import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../state/AppContext';
import { useJournal } from '../state/data';
import { db } from '../db/db';
import { addDays, longDate, shortDate, todayKey } from '../analytics/time';
import { INJURY_LABELS, currentPhaseIndex, isSurgical, phasesFor, weekSince } from '../plan/phases';
import type { InjuryType, JournalEntry } from '../types';
import { SWELLING_LABELS } from '../types';
import { Card, Disclaimer } from '../ui/components';
import { ChartTip, axisProps, useChartColors } from '../ui/charts';
import { PageHead } from './common';

function PlanCard() {
  const { settings, updateSettings } = useApp();
  const plan = settings.plan;
  const set = (patch: Partial<typeof plan>) => updateSettings({ plan: { ...plan, ...patch } });
  const { week, days } = weekSince(plan.eventDate, todayKey());
  const surgical = isSurgical(plan.injury);
  return (
    <Card title="Recovery plan">
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div className="week-badge" aria-label={`Week ${week}`}>
          <span className="small">{days < 0 ? 'Starts in' : 'Week'}</span>
          <b>{days < 0 ? -days : week}</b>
          <span className="small">{days < 0 ? 'days' : surgical ? 'post-op' : 'since injury'}</span>
        </div>
        <div className="grid grid-2" style={{ flex: 1, minWidth: 240 }}>
          <label className="field">
            Injury / procedure
            <select value={plan.injury} onChange={(e) => set({ injury: e.target.value as InjuryType })}>
              {Object.entries(INJURY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {surgical ? 'Surgery date' : 'Injury date'}
            <input type="date" value={plan.eventDate} onChange={(e) => e.target.value && set({ eventDate: e.target.value })} />
          </label>
          <label className="field">
            Side
            <select value={plan.side} onChange={(e) => set({ side: e.target.value as 'left' | 'right' })}>
              <option value="right">Right</option>
              <option value="left">Left</option>
            </select>
          </label>
          <label className="field">
            Taped muscle
            <input type="text" value={plan.muscle} onChange={(e) => set({ muscle: e.target.value })} />
          </label>
          <label className="field">
            Physical therapist
            <input type="text" value={plan.ptName} placeholder="Name / clinic (for reports)" onChange={(e) => set({ ptName: e.target.value })} />
          </label>
          <label className="field">
            Notes
            <input type="text" value={plan.notes} placeholder="e.g. hamstring graft, brace until wk 4" onChange={(e) => set({ notes: e.target.value })} />
          </label>
        </div>
      </div>
    </Card>
  );
}

function PhasesCard() {
  const { settings } = useApp();
  const phases = phasesFor(settings.plan.injury);
  const { days } = weekSince(settings.plan.eventDate, todayKey());
  const cur = currentPhaseIndex(phases, days);
  return (
    <Card title="Typical phase milestones" hint={`General guidance for ${INJURY_LABELS[settings.plan.injury]} — not medical advice`}>
      <div className="phases">
        {phases.map((p, i) => (
          <div key={p.title} className={`phase ${i < cur ? 'done' : i === cur ? 'current' : ''}`}>
            <span className="bullet">{i + 1}</span>
            <div>
              <div className="row">
                <h3 className="phase-title">{p.title}</h3>
                <span className="small muted">
                  weeks {p.fromWeek}–{p.toWeek}
                </span>
                {i === cur && <span className="pill">You are here</span>}
              </div>
              <ul>
                {p.goals.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
      <p className="small muted">
        Timelines vary widely between people and protocols. Progress between phases is based on criteria your clinician assesses, not just time.
      </p>
    </Card>
  );
}

function blankEntry(date: string): JournalEntry {
  return { date, pain: 3, swelling: 1, notes: '', updatedAt: Date.now() };
}

function JournalForm() {
  const journal = useJournal();
  const [date, setDate] = useState(todayKey());
  const existing = journal.find((j) => j.date === date);
  const [entry, setEntry] = useState<JournalEntry>(existing ?? blankEntry(date));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const ex = journal.find((j) => j.date === date);
    if (ex) setEntry(ex);
    else {
      // prefill ROM from the most recent previous entry
      const prev = [...journal].reverse().find((j) => j.date < date);
      setEntry({ ...blankEntry(date), romFlexion: prev?.romFlexion, romExtension: prev?.romExtension });
    }
    setSaved(false);
  }, [date, journal.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<JournalEntry>) => {
    setEntry((e) => ({ ...e, ...patch }));
    setSaved(false);
  };
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const save = async () => {
    await db.journal.put({ ...entry, date, updatedAt: Date.now() });
    setSaved(true);
  };
  return (
    <Card title="Daily log" hint={longDate(date)} action={<input type="date" value={date} max={todayKey()} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto' }} />}>
      <div className="stack" style={{ gap: 14 }}>
        <label className="field">
          <span className="row">
            Pain (0 = none, 10 = worst imaginable) <span className="spacer" />
            <b style={{ fontSize: '1.1rem', color: 'var(--text)' }}>{entry.pain}</b>
          </span>
          <input type="range" min={0} max={10} step={1} value={entry.pain} onChange={(e) => set({ pain: Number(e.target.value) })} />
        </label>
        <div className="field">
          Swelling
          <div className="seg" role="radiogroup" aria-label="Swelling">
            {SWELLING_LABELS.map((l, i) => (
              <button key={l} role="radio" aria-checked={entry.swelling === i} className={entry.swelling === i ? 'on' : ''} onClick={() => set({ swelling: i })}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-2">
          <label className="field">
            Knee flexion (bend), degrees
            <input type="number" min={0} max={160} value={entry.romFlexion ?? ''} placeholder="e.g. 110" onChange={(e) => set({ romFlexion: num(e.target.value) })} />
          </label>
          <label className="field">
            Knee extension, degrees (0 = straight, −5 = lacking 5°)
            <input type="number" min={-30} max={15} value={entry.romExtension ?? ''} placeholder="e.g. 0" onChange={(e) => set({ romExtension: num(e.target.value) })} />
          </label>
        </div>
        <label className="field">
          Notes
          <textarea value={entry.notes} placeholder="How did the knee feel? Anything your PT should know?" onChange={(e) => set({ notes: e.target.value })} />
        </label>
        <div className="row">
          <button className="btn primary" onClick={() => void save()}>
            {existing ? 'Update entry' : 'Save entry'}
          </button>
          {saved && <span className="small" style={{ color: 'var(--good-text)' }}>Saved</span>}
          <span className="spacer" />
          <span className="small muted">Self-reported ROM — measure the same way each time (e.g. with a goniometer app or your PT’s method).</span>
        </div>
      </div>
    </Card>
  );
}

function JournalHistory() {
  const journal = useJournal();
  const c = useChartColors();
  const from = addDays(todayKey(), -42);
  const data = useMemo(
    () => journal.filter((j) => j.date >= from).map((j) => ({ label: shortDate(j.date), pain: j.pain, flexion: j.romFlexion ?? null, swelling: j.swelling })),
    [journal, from],
  );
  const recent = [...journal].reverse().slice(0, 14);
  return (
    <>
      <div className="grid grid-2">
        <Card title="Pain" hint="Last 6 weeks, 0–10">
          <div className="chart-box">
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="label" interval="preserveStartEnd" {...axisProps(c)} />
                <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} {...axisProps(c)} />
                <Tooltip content={<ChartTip />} />
                <Line type="monotone" dataKey="pain" name="Pain" stroke={c.s2} strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Knee flexion" hint="Self-reported, degrees">
          <div className="chart-box">
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="label" interval="preserveStartEnd" {...axisProps(c)} />
                <YAxis domain={['dataMin - 10', 'dataMax + 5']} tickFormatter={(v) => `${Math.round(v)}°`} {...axisProps(c)} />
                <Tooltip content={<ChartTip valueFormatter={(v) => `${v}°`} />} />
                <Line type="monotone" dataKey="flexion" name="Flexion" stroke={c.s1} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
      <Card title="Recent entries">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Pain</th>
                <th>Swelling</th>
                <th className="num">Flexion</th>
                <th className="num">Extension</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((j) => (
                <tr key={j.date}>
                  <td>{shortDate(j.date)}</td>
                  <td className="num">{j.pain}</td>
                  <td>{SWELLING_LABELS[j.swelling]}</td>
                  <td className="num">{j.romFlexion !== undefined ? `${j.romFlexion}°` : '—'}</td>
                  <td className="num">{j.romExtension !== undefined ? `${j.romExtension}°` : '—'}</td>
                  <td className="text-2">{j.notes}</td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No entries yet.
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

export function PlanPage() {
  return (
    <>
      <PageHead title="Plan & journal" sub="Where you are in recovery, and how you feel day to day" />
      <Disclaimer />
      <PlanCard />
      <div className="grid grid-2">
        <JournalForm />
        <PhasesCard />
      </div>
      <JournalHistory />
    </>
  );
}
