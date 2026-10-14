import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useApp, useLiveStream, isConnectedPhase } from '../state/AppContext';
import { EXERCISES, exerciseById, type ExercisePreset } from '../exercises/presets';
import { RepTracker } from '../exercises/repTracker';
import { initialSession, sessionReducer, summarizeSession } from '../exercises/session';
import { db } from '../db/db';
import { sessionDateKey, useSessions } from '../state/data';
import { todayKey } from '../analytics/time';
import { Card, Stat, useNow } from '../ui/components';
import { IconCheck, IconPlay, IconTimer } from '../ui/icons';
import { ConnectPrompt, PageHead } from './common';
import type { LivePacket } from '../protocol/codec';
import type { SessionResult } from '../types';

function Targets({ ex }: { ex: ExercisePreset }) {
  return (
    <div className="targets">
      <span className="pill">
        {ex.sets} × {ex.reps}
      </span>
      <span className="pill">hold {ex.holdS}s</span>
      <span className="pill">≥ {ex.qualityTargetPct}% effort</span>
      <span className="pill">rest {ex.restS}s</span>
    </div>
  );
}

function Runner({ ex, onClose }: { ex: ExercisePreset; onClose: () => void }) {
  const { client, sim, status, phase: linkPhase } = useApp();
  const reducer = useMemo(() => sessionReducer(ex), [ex]);
  const [s, dispatch] = useReducer(reducer, undefined, initialSession);
  const tracker = useRef(new RepTracker());
  const [latest, setLatest] = useState<LivePacket | null>(null);
  const [autoDemo, setAutoDemo] = useState(true);
  const [saved, setSaved] = useState<SessionResult | null>(null);
  const now = useNow(250);

  useLiveStream((p) => {
    setLatest(p);
    const ev = tracker.current.push(p);
    if (ev) dispatch({ type: 'rep', ev, now: Date.now() });
  });

  useEffect(() => {
    dispatch({ type: 'tick', now });
  }, [now]);

  // Demo: let the simulated tape "perform" the exercise during work phases
  useEffect(() => {
    if (!sim) return;
    const d = sim.sim;
    if (autoDemo && s.phase === 'work') {
      d.coach = { holdMs: ex.holdS * 1000 + 350, relaxMs: ex.relaxS * 1000, level: Math.min(0.95, ex.qualityTargetPct / 100 + 0.2) };
      d.manualLevel = null;
    } else if (autoDemo && s.phase === 'rest') {
      d.coach = null;
      d.manualLevel = 0.02;
    } else {
      d.coach = null;
      d.manualLevel = null;
    }
    d.resetPattern();
  }, [sim, autoDemo, s.phase, ex]);
  useEffect(
    () => () => {
      if (sim) {
        sim.sim.coach = null;
        sim.sim.manualLevel = null;
        sim.sim.resetPattern();
      }
    },
    [sim],
  );

  // save when done
  useEffect(() => {
    if (s.phase !== 'done' || saved || !s.startedAt) return;
    const total = s.sets.reduce((a, x) => a + x.reps.length, 0);
    if (total === 0) return;
    const r = summarizeSession(s, ex, {
      id: `${Date.now()}-${ex.id}`,
      calibrated: !!status?.calibrated,
      source: client?.transport.kind === 'sim' ? 'demo' : 'device',
      calibMaxRaw: status?.maxRaw,
    });
    void db.sessions.put(r);
    setSaved(r);
  }, [s, saved, ex, status, client]);

  const set = s.sets[s.setIndex];
  const repsInSet = set?.reps.length ?? 0;
  const cur = latest ? tracker.current.current(latest.uptimeMs) : null;
  const holdFrac = cur ? Math.min(1, cur.holdMs / (ex.holdS * 1000)) : 0;
  const act = latest ? latest.activationPermille / 10 : 0;
  const restLeft = s.restEndsAt ? Math.max(0, Math.ceil((s.restEndsAt - now) / 1000)) : 0;
  const last = s.lastRep;
  const feedback = last
    ? last.good
      ? 'Good rep!'
      : last.holdMs < ex.holdS * 800
        ? 'Try to hold a little longer'
        : 'Squeeze a bit harder if comfortable'
    : '';

  if (s.phase === 'done') {
    const r = saved;
    return (
      <Card title={`${ex.name} — session complete`}>
        {r ? (
          <div className="stack">
            <div className="grid grid-4">
              <Stat label="Reps" value={r.totalReps} foot={`target ${r.targetSets * r.targetReps}`} />
              <Stat label="Good reps" value={r.goodReps} foot={`${Math.round((100 * r.goodReps) / Math.max(1, r.totalReps))}%`} />
              <Stat label="Avg hold" value={r.avgHoldS} unit="s" foot={`target ${r.targetHoldS}s`} />
              <Stat label="Avg peak" value={r.avgPeakPct} unit="%" foot={`max ${r.maxPeakPct}% · target ${r.qualityTargetPct}%`} />
            </div>
            {!r.calibrated && <p className="small muted">The tape wasn’t calibrated, so effort percentages are approximate.</p>}
            <p className="text-2">Saved to your history{r.completed ? ' and counted toward today’s sessions' : ' (counted as partial)'}.</p>
          </div>
        ) : (
          <p className="muted">No reps were recorded, so nothing was saved.</p>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={onClose}>
            Back to exercises
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="runner">
      <Card title={ex.name} hint={ex.short} action={<Targets ex={ex} />}>
        {s.phase === 'ready' && (
          <div className="stack">
            <ol className="text-2" style={{ margin: 0, paddingLeft: 18 }}>
              {ex.instructions.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ol>
            {!status?.calibrated && <div className="notice">Tip: calibrate first on the Device page so effort is measured against your own max.</div>}
            {sim && (
              <label className="row small">
                <input type="checkbox" checked={autoDemo} onChange={(e) => setAutoDemo(e.target.checked)} /> Demo: let the simulated tape perform the reps
              </label>
            )}
            <div>
              <button className="btn primary lg" disabled={!isConnectedPhase(linkPhase)} onClick={() => dispatch({ type: 'start', now: Date.now() })}>
                <IconPlay size={16} /> Start set 1
              </button>
            </div>
          </div>
        )}
        {s.phase === 'work' && (
          <div className="stack" style={{ gap: 16 }}>
            <div className="row">
              <div>
                <div className="small text-2">
                  Set {s.setIndex + 1} of {ex.sets}
                </div>
                <div className="big-number tabular">
                  {repsInSet}
                  <span className="muted" style={{ fontSize: '1.4rem' }}>
                    {' '}
                    / {ex.reps}
                  </span>
                </div>
              </div>
              <span className="spacer" />
              <span className={`contract-badge ${latest?.contracting ? 'on' : ''}`}>{latest?.contracting ? ex.cue : 'Relax'}</span>
            </div>
            <div>
              <div className="row small text-2" style={{ marginBottom: 4 }}>
                Hold <span className="spacer" />
                <span className="tabular">
                  {cur ? (cur.holdMs / 1000).toFixed(1) : '0.0'} / {ex.holdS} s
                </span>
              </div>
              <div className="hold-bar">
                <div className={holdFrac >= 1 ? 'met' : ''} style={{ width: `${holdFrac * 100}%` }} />
              </div>
            </div>
            <div>
              <div className="row small text-2" style={{ marginBottom: 4 }}>
                Effort <span className="spacer" />
                <span className="tabular">
                  {Math.round(act)}% (target {ex.qualityTargetPct}%)
                </span>
              </div>
              <div className="hold-bar">
                <div className={act >= ex.qualityTargetPct ? 'met' : ''} style={{ width: `${Math.min(100, act)}%` }} />
                <span className="target" style={{ left: `${ex.qualityTargetPct}%` }} />
              </div>
            </div>
            <div className="rep-dots" aria-label="Reps this set">
              {Array.from({ length: ex.reps }, (_, i) => {
                const r = set?.reps[i];
                return (
                  <span key={i} className={r ? (r.good ? 'good' : 'meh') : ''}>
                    {r ? (r.good ? '✓' : '!') : i + 1}
                  </span>
                );
              })}
            </div>
            <div className="small" style={{ minHeight: 20, color: last?.good ? 'var(--good-text)' : 'var(--text-2)' }} aria-live="polite">
              {feedback}
            </div>
            <div className="row">
              <button className="btn" onClick={() => dispatch({ type: 'endSet', now: Date.now() })}>
                End set
              </button>
              <button className="btn ghost" onClick={() => dispatch({ type: 'finish', now: Date.now() })}>
                Finish session
              </button>
            </div>
          </div>
        )}
        {s.phase === 'rest' && (
          <div className="stack" style={{ alignItems: 'flex-start' }}>
            <div className="small text-2">
              <IconTimer size={14} /> Rest before set {s.setIndex + 2} of {ex.sets}
            </div>
            <div className="big-number tabular">{restLeft}s</div>
            <div className="progress" style={{ width: '100%' }}>
              <div style={{ width: `${100 - (100 * restLeft) / ex.restS}%` }} />
            </div>
            <p className="text-2 small">Relax the leg fully. Gentle breathing.</p>
            <div className="row">
              <button className="btn primary" onClick={() => dispatch({ type: 'skipRest', now: Date.now() })}>
                Skip rest
              </button>
              <button className="btn ghost" onClick={() => dispatch({ type: 'finish', now: Date.now() })}>
                Finish session
              </button>
            </div>
          </div>
        )}
      </Card>
      <Card title="This session">
        <table>
          <thead>
            <tr>
              <th>Set</th>
              <th className="num">Reps</th>
              <th className="num">Good</th>
              <th className="num">Avg hold</th>
              <th className="num">Avg peak</th>
            </tr>
          </thead>
          <tbody>
            {s.sets.map((x, i) => {
              const n = x.reps.length;
              const avg = (f: (r: (typeof x.reps)[0]) => number) => (n ? x.reps.reduce((a, r) => a + f(r), 0) / n : 0);
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="num">{n}</td>
                  <td className="num">{x.reps.filter((r) => r.good).length}</td>
                  <td className="num">{n ? `${(avg((r) => r.holdMs) / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="num">{n ? `${Math.round(avg((r) => r.peakPermille) / 10)}%` : '—'}</td>
                </tr>
              );
            })}
            {!s.sets.length && (
              <tr>
                <td colSpan={5} className="muted">
                  Not started
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 14 }}>
          <button
            className="btn ghost"
            onClick={() => {
              if (s.phase === 'ready' || confirm('Leave this session? Reps so far will be saved as a partial session.')) {
                if (s.phase === 'ready') onClose();
                else dispatch({ type: 'finish', now: Date.now() });
              }
            }}
          >
            {s.phase === 'ready' ? 'Back' : 'Stop'}
          </button>
        </div>
      </Card>
    </div>
  );
}

export function ExercisePage() {
  const { client, phase, settings } = useApp();
  const sessions = useSessions();
  const [active, setActive] = useState<string | null>(null);
  const today = todayKey();
  const program = settings.program.map(exerciseById).filter((x): x is ExercisePreset => !!x);
  const list = program.length ? program : EXERCISES;
  const todays = sessions.filter((s) => sessionDateKey(s) === today);
  const recent = [...sessions].reverse().slice(0, 12);
  const ex = active ? exerciseById(active) : null;

  if (ex)
    return (
      <>
        <PageHead title="Guided exercise" sub="Reps, hold time and effort are measured from the live tape signal" />
        {!client || phase === 'disconnected' ? <ConnectPrompt what="run a guided session" /> : <Runner ex={ex} onClose={() => setActive(null)} />}
      </>
    );

  return (
    <>
      <PageHead
        title="Exercises"
        sub={`Today: ${todays.filter((s) => s.completed).length} of ${settings.goals.sessions} planned sessions completed`}
      />
      <div className="notice">
        These are commonly prescribed knee-rehab exercises with typical targets. Do only the exercises — and the range, load and repetitions — your physical therapist
        has prescribed for your stage of recovery. Stop if you feel sharp pain.
      </div>
      <div className="ex-list">
        {list.map((e) => {
          const done = todays.filter((s) => s.exerciseId === e.id && s.completed).length;
          return (
            <div className="card ex-card" key={e.id}>
              <div className="row">
                <h2>{e.name}</h2>
                <span className="spacer" />
                {done > 0 && (
                  <span className="done-chip">
                    <IconCheck size={14} /> done{done > 1 ? ` ×${done}` : ''}
                  </span>
                )}
              </div>
              <p className="text-2 small">{e.short}</p>
              <Targets ex={e} />
              <div>
                <button className="btn primary" onClick={() => setActive(e.id)}>
                  <IconPlay size={14} /> Start
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <Card title="Recent sessions">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Exercise</th>
                <th className="num">Reps</th>
                <th className="num">Good</th>
                <th className="num">Avg hold</th>
                <th className="num">Avg peak</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td>{r.exerciseName}</td>
                  <td className="num">
                    {r.totalReps}/{r.targetSets * r.targetReps}
                  </td>
                  <td className="num">{r.goodReps}</td>
                  <td className="num">{r.avgHoldS}s</td>
                  <td className="num">{r.avgPeakPct}%</td>
                  <td>{r.completed ? 'Complete' : 'Partial'}</td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    No sessions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
