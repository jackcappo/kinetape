import { useEffect, useState } from 'react';
import { useApp, isConnectedPhase } from '../state/AppContext';
import { bluetoothSupport } from '../device/WebBluetoothTransport';
import { OPCODE_NAME, RESULT, RESULT_NAME, THRESHOLD_MAX, THRESHOLD_MIN } from '../protocol/constants';
import type { CalibrationOutcome } from '../device/DeviceClient';
import { Card, Pill, timeAgo, useNow } from '../ui/components';
import { IconAlert, IconBolt, IconCheck, IconRefresh } from '../ui/icons';
import { ConnectButtons, PageHead } from './common';
import { useCalibrations, useUnknownTimeCount } from '../state/data';
import { db } from '../db/db';
import { useLiveQuery } from 'dexie-react-hooks';

function fmtUptime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function StatusCard() {
  const { client, status, phase, lastSync, syncProgress, syncNow, disconnect, identifyAt, sim } = useApp();
  const now = useNow(5000);
  const cursor = useLiveQuery(() => (client ? db.cursors.get(client.deviceId) : undefined), [client, lastSync]);
  const unknown = useUnknownTimeCount();
  const [identifying, setIdentifying] = useState(false);
  if (!client) return null;
  const s = status;
  const stored = s ? s.nextIndex - s.oldestIndex : 0;
  const lastSyncAt = lastSync?.at ?? cursor?.lastSyncAt;
  const blinking = Date.now() - identifyAt < 2200;
  return (
    <Card
      title={client.transport.name}
      hint={client.transport.kind === 'sim' ? 'Simulated device — speaks the real BLE protocol' : 'Web Bluetooth'}
      action={
        <div className="row">
          {sim && <span className={`led ${blinking ? 'blink' : ''}`} key={identifyAt} title="Simulated status LED" />}
          <Pill tone={isConnectedPhase(phase) ? 'ok' : phase === 'reconnecting' ? 'warn' : 'bad'}>{phase}</Pill>
        </div>
      }
    >
      {s ? (
        <dl className="kv">
          <dt>Sensor</dt>
          <dd>
            {s.sensorOk ? (
              <span style={{ color: 'var(--good-text)' }}>
                <IconCheck size={14} /> Contact OK
              </span>
            ) : (
              <span style={{ color: '#b26a00' }}>
                <IconAlert size={14} /> No contact — re-apply tape firmer
              </span>
            )}
          </dd>
          <dt>Calibrated</dt>
          <dd>{s.calibrated ? `Yes (rest ${s.restRaw}, max ${s.maxRaw})` : 'Not yet — run calibration below'}</dd>
          <dt>Time synced</dt>
          <dd>{s.timeValid ? new Date(s.epochNow * 1000).toLocaleTimeString() : 'No'}</dd>
          <dt>Stored on device</dt>
          <dd className="tabular">
            {stored.toLocaleString()} min <span className="muted">({s.oldestIndex}–{s.nextIndex})</span>
          </dd>
          <dt>Reps today (device)</dt>
          <dd className="tabular">{s.repsToday}</dd>
          <dt>Threshold</dt>
          <dd>{s.thresholdPct}%</dd>
          <dt>Last sync</dt>
          <dd>{lastSyncAt ? `${timeAgo(lastSyncAt, now)}${lastSync ? ` · ${lastSync.added} new` : ''}` : 'Never'}</dd>
          <dt>App cursor</dt>
          <dd className="tabular">{cursor ? `${cursor.cursor} (gen ${cursor.generation})` : '—'}</dd>
          <dt>Uptime · boot</dt>
          <dd className="tabular">
            {fmtUptime(s.uptimeS)} · #{s.bootId}
          </dd>
          <dt>Firmware · battery</dt>
          <dd>v{s.fwVersion} · {s.batteryPct === 255 ? 'unknown' : `${s.batteryPct}%`}</dd>
          <dt>Last command</dt>
          <dd>
            {OPCODE_NAME[s.lastCmd] ?? s.lastCmd} → {RESULT_NAME[s.lastResult] ?? s.lastResult}
          </dd>
        </dl>
      ) : (
        <p className="muted">Waiting for STATUS…</p>
      )}
      {syncProgress && (
        <div style={{ marginTop: 14 }}>
          <div className="row small text-2" style={{ marginBottom: 6 }}>
            Syncing history… <span className="spacer" />
            <span className="tabular">
              {syncProgress.received} / {syncProgress.expected}
            </span>
          </div>
          <div className="progress">
            <div style={{ width: `${syncProgress.expected ? (100 * syncProgress.received) / syncProgress.expected : 100}%` }} />
          </div>
        </div>
      )}
      {lastSync?.error && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <IconAlert /> {lastSync.error}
        </div>
      )}
      {lastSync && lastSync.lostToRing > 0 && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <IconAlert /> {lastSync.lostToRing} minutes were overwritten on the device before syncing (its log holds about 7 days). Sync at least weekly.
        </div>
      )}
      {lastSync?.resynced && (
        <div className="notice" style={{ marginTop: 12 }}>
          The device log was cleared or reflashed, so the app started a fresh sync from index 0. Previously synced data is kept.
        </div>
      )}
      {unknown > 0 && (
        <p className="small muted" style={{ marginTop: 10 }}>
          {unknown} minutes have no known time (recorded before the clock was set on an earlier boot) and are excluded from charts.
        </p>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={() => void syncNow()} disabled={!isConnectedPhase(phase) || !!syncProgress}>
          <IconRefresh size={16} /> Sync now
        </button>
        <button
          className="btn"
          disabled={!isConnectedPhase(phase) || identifying}
          onClick={async () => {
            setIdentifying(true);
            try {
              await client.identify();
            } finally {
              setIdentifying(false);
            }
          }}
        >
          <IconBolt size={16} /> Identify (blink LED)
        </button>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
    </Card>
  );
}

function CalibrationWizard() {
  const { client, status, phase } = useApp();
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState<null | { kind: 'rest' | 'max'; started: number }>(null);
  const [results, setResults] = useState<{ rest?: CalibrationOutcome; max?: CalibrationOutcome }>({});
  const now = useNow(200);
  const cals = useCalibrations();
  if (!client) return null;
  const connected = isConnectedPhase(phase);

  const run = async (kind: 'rest' | 'max') => {
    setRunning({ kind, started: Date.now() });
    try {
      const r = await client.calibrate(kind);
      setResults((p) => ({ ...p, [kind]: r }));
      if (r.result === RESULT.OK) setStep(kind === 'rest' ? 2 : 3);
    } finally {
      setRunning(null);
    }
  };
  const dur = running?.kind === 'rest' ? 3000 : 5000;
  const left = running ? Math.max(0, dur - (now - running.started)) : 0;
  const calibStateLabel = ['idle', 'sampling rest', 'sampling max'][status?.calibState ?? 0] ?? String(status?.calibState);
  const resultLine = (r?: CalibrationOutcome) =>
    r && (
      <p className="small" style={{ color: r.result === RESULT.OK ? 'var(--good-text)' : 'var(--critical)' }}>
        Result: {r.resultName} ({r.result})
        {r.result === RESULT.FAILED && ' — the peak was not at least 100 above the resting value. Re-apply the tape over the muscle belly and contract harder.'}
        {r.result === RESULT.BUSY && ' — the device is busy (another calibration or sync is running). Try again in a few seconds.'}
      </p>
    );

  return (
    <Card title="Calibration" hint={`calib_state: ${calibStateLabel}`}>
      <div className="steps" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i <= step ? 'on' : ''} />
        ))}
      </div>
      {step === 0 && (
        <div className="stack">
          <p className="text-2">
            Calibration teaches the tape what “relaxed” and “maximum effort” look like for <em>your</em> muscle, so activation is shown as a percentage of your
            own max. Recalibrate when you re-apply the tape. {cals.length > 0 && `Last calibrated ${new Date(cals[cals.length - 1].at).toLocaleDateString()}.`}
          </p>
          <div>
            <button className="btn primary" disabled={!connected} onClick={() => setStep(1)}>
              Start calibration
            </button>
          </div>
        </div>
      )}
      {step === 1 && (
        <div className="stack">
          <h3>Step 1 · Relax completely</h3>
          <p className="text-2">Sit or lie with the leg supported and the thigh muscle fully relaxed. The tape samples for 3 seconds.</p>
          {running?.kind === 'rest' ? (
            <div className="stack">
              <div className="big-number tabular">{(left / 1000).toFixed(1)} s</div>
              <div className="progress">
                <div style={{ width: `${100 - (100 * left) / dur}%` }} />
              </div>
              <span className="small muted">Stay relaxed…</span>
            </div>
          ) : (
            <div className="row">
              <button className="btn primary" disabled={!connected} onClick={() => void run('rest')}>
                Sample rest (CALIBRATE_REST)
              </button>
              <button className="btn ghost" onClick={() => setStep(0)}>
                Cancel
              </button>
            </div>
          )}
          {resultLine(results.rest)}
        </div>
      )}
      {step === 2 && (
        <div className="stack">
          <h3>Step 2 · Maximum comfortable contraction</h3>
          <p className="text-2">
            When you press start, tighten the thigh as hard as is <strong>comfortable</strong> (like a strong quad set) and hold for 5 seconds. Don’t push into
            pain — stay within what your PT has cleared.
          </p>
          {running?.kind === 'max' ? (
            <div className="stack">
              <div className="big-number tabular">{(left / 1000).toFixed(1)} s</div>
              <div className="progress">
                <div style={{ width: `${100 - (100 * left) / dur}%` }} />
              </div>
              <span className="small muted">Squeeze and hold…</span>
            </div>
          ) : (
            <div className="row">
              <button className="btn primary" disabled={!connected} onClick={() => void run('max')}>
                Sample max (CALIBRATE_MAX)
              </button>
              <button className="btn ghost" onClick={() => setStep(1)}>
                Back
              </button>
            </div>
          )}
          {resultLine(results.max)}
        </div>
      )}
      {step === 3 && (
        <div className="stack">
          <h3>
            <IconCheck size={16} /> Calibrated
          </h3>
          <dl className="kv">
            <dt>rest_raw</dt>
            <dd>{status?.restRaw}</dd>
            <dt>max_raw</dt>
            <dd>{status?.maxRaw}</dd>
            <dt>Results</dt>
            <dd>
              REST {results.rest?.resultName ?? '—'} · MAX {results.max?.resultName ?? '—'}
            </dd>
          </dl>
          <p className="small muted">Peak-activation charts mark this recalibration, since values before and after aren’t directly comparable.</p>
          <div>
            <button className="btn" onClick={() => setStep(0)}>
              Done
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ThresholdCard() {
  const { client, status, phase } = useApp();
  const [val, setVal] = useState(status?.thresholdPct ?? 30);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (status) setVal(status.thresholdPct);
  }, [status?.thresholdPct]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!client) return null;
  const apply = async () => {
    setMsg(null);
    const r = await client.setThreshold(val);
    setMsg(r === RESULT.OK ? `Saved: ${val}%` : `Device answered ${RESULT_NAME[r] ?? r}`);
  };
  return (
    <Card title="Contraction threshold" hint="Activation at which a contraction (rep) starts; it ends below 60 % of this">
      <div className="row">
        <input
          type="range"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          value={val}
          onChange={(e) => setVal(Number(e.target.value))}
          aria-label="Threshold percent"
          style={{ flex: 1 }}
        />
        <b className="tabular" style={{ width: 44, textAlign: 'right' }}>
          {val}%
        </b>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" disabled={!isConnectedPhase(phase) || val === status?.thresholdPct} onClick={() => void apply()}>
          Apply (SET_THRESHOLD)
        </button>
        {msg && <span className="small text-2">{msg}</span>}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        Lower = more sensitive (counts gentler contractions); higher = only strong efforts count. Default 30 %.
      </p>
    </Card>
  );
}

function DemoControls() {
  const { sim, client } = useApp();
  const [, force] = useState(0);
  if (!sim || !client) return null;
  const d = sim.sim;
  const toggle = (fn: () => void) => {
    fn();
    force((x) => x + 1);
  };
  const flexDown = () => toggle(() => (d.manualLevel = 0.8));
  const flexUp = () => toggle(() => (d.manualLevel = null));
  return (
    <Card title="Demo device controls" hint="Fault injection for the simulator">
      <div className="stack">
        <button
          className="btn primary lg flex-btn"
          onPointerDown={flexDown}
          onPointerUp={flexUp}
          onPointerLeave={() => d.manualLevel !== null && flexUp()}
          onKeyDown={(e) => e.key === ' ' && flexDown()}
          onKeyUp={(e) => e.key === ' ' && flexUp()}
        >
          Press &amp; hold to flex
        </button>
        <label className="row small">
          <input type="checkbox" checked={d.sensorFault} onChange={(e) => toggle(() => (d.sensorFault = e.target.checked))} /> Simulate loose tape (no contact)
        </label>
        <label className="row small">
          <input type="checkbox" checked={d.failNextMaxCalibration} onChange={(e) => toggle(() => (d.failNextMaxCalibration = e.target.checked))} /> Make next
          CALIBRATE_MAX fail (weak contraction)
        </label>
        <div className="row">
          <button className="btn" onClick={() => sim.simulateLinkDrop()}>
            Drop connection
          </button>
          <button
            className="btn"
            onClick={() => {
              d.reboot();
              d.notifyStatus();
              force((x) => x + 1);
            }}
            title="New boot_id, clock lost — next sync shows unsynced-time conversion"
          >
            Power-cycle device
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (confirm('Clear the demo device log (CLEAR_HISTORY)? Data already synced to the app is kept.')) await client.clearHistory();
            }}
          >
            CLEAR_HISTORY
          </button>
        </div>
      </div>
    </Card>
  );
}

function EventLog() {
  const { log } = useApp();
  if (!log.length) return null;
  return (
    <Card title="Session log">
      <div className="log">
        {[...log].reverse().map((e, i) => (
          <div key={i} className={e.level}>
            {new Date(e.at).toLocaleTimeString()} {e.msg}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function DevicePage() {
  const { client, error, clearError, phase } = useApp();
  const sup = bluetoothSupport();
  return (
    <>
      <PageHead title="Device" sub="Connect, calibrate and sync your KineTape" />
      {error && (
        <div className="notice warn">
          <IconAlert />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn ghost" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}
      {!client || phase === 'disconnected' ? (
        <div className="grid grid-2">
          <Card title="Connect your KineTape">
            <div className="stack">
              <p className="text-2">
                Turn the tape’s electronics on, keep it within a few metres, then choose <strong>KineTape-XXXX</strong> in the browser’s Bluetooth dialog.
              </p>
              {sup.ok ? (
                <ConnectButtons size="lg" />
              ) : (
                <>
                  <div className="notice warn">
                    <IconAlert />
                    <span>{sup.reason}</span>
                  </div>
                  <ConnectButtons size="lg" />
                </>
              )}
              {client && phase === 'disconnected' && <p className="small muted">The previous connection ended.</p>}
            </div>
          </Card>
          <Card title="What happens when you connect">
            <ol className="text-2" style={{ margin: 0, paddingLeft: 18 }}>
              <li>The app reads the device status and sets its clock to your time zone.</li>
              <li>New minute summaries stored on the tape (up to ~7 days) are synced into this browser.</li>
              <li>The live signal streams for the Live view and guided exercises.</li>
            </ol>
            <p className="small muted" style={{ marginTop: 10 }}>
              Demo mode runs a simulated tape in your browser with six weeks of realistic recovery data.
            </p>
          </Card>
        </div>
      ) : (
        <div className="grid grid-2">
          <StatusCard />
          <div className="stack" style={{ gap: 16 }}>
            <CalibrationWizard />
            <ThresholdCard />
          </div>
          <DemoControls />
          <EventLog />
        </div>
      )}
    </>
  );
}

