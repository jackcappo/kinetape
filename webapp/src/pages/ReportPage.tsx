import { useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useApp } from '../state/AppContext';
import { recalibrationDates, sessionDateKey, useCalibrations, useDaySummaries, useJournal, useRecords, useSessions } from '../state/data';
import { addDays, dateRange, formatDuration, longDate, shortDate, todayKey } from '../analytics/time';
import { generateInsights } from '../insights';
import { INJURY_LABELS, isSurgical, weekSince } from '../plan/phases';
import { SWELLING_LABELS } from '../types';
import { download, exportBackup, importBackup, journalCsv, recordsCsv, sessionsCsv, validateBackup } from '../db/backup';
import { mean } from '../insights/stats';
import { Card, Disclaimer, InsightCard, Segmented } from '../ui/components';
import { axisProps, useChartColors } from '../ui/charts';
import { IconDownload, IconPrinter } from '../ui/icons';
import { PageHead } from './common';

type Preset = '7' | '14' | '30' | 'custom';

export function ReportPage() {
  const { settings } = useApp();
  const today = todayKey();
  const [preset, setPreset] = useState<Preset>('14');
  const [customFrom, setCustomFrom] = useState(addDays(today, -13));
  const [customTo, setCustomTo] = useState(today);
  const from = preset === 'custom' ? customFrom : addDays(today, -(Number(preset) - 1));
  const to = preset === 'custom' ? customTo : today;
  const { days } = useDaySummaries(from, to, settings);
  const records = useRecords(from, to);
  const allSessions = useSessions();
  const allJournal = useJournal();
  const cals = useCalibrations();
  const c = useChartColors();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const sessions = allSessions.filter((s) => sessionDateKey(s) >= from && sessionDateKey(s) <= to);
  const journal = allJournal.filter((j) => j.date >= from && j.date <= to);
  const recal = recalibrationDates(cals).filter((k) => k >= from && k <= to);
  const nDays = dateRange(from, to).length;
  const plan = settings.plan;
  const { week } = weekSince(plan.eventDate, to);

  const byDate = new Map(days.map((d) => [d.date, d]));
  const chartData = dateRange(from, to).map((k) => {
    const d = byDate.get(k);
    const j = journal.find((x) => x.date === k);
    return { label: shortDate(k), active: d?.activeMinutes ?? null, peak: d ? Math.round(d.peakPermille / 10) : null, pain: j?.pain ?? null };
  });
  const recalLabels = recal.map(shortDate);

  const completed = sessions.filter((s) => s.completed).length;
  const planned = settings.goals.sessions * nDays;
  const romVals = journal.filter((j) => j.romFlexion !== undefined);
  const insights = useMemo(
    () =>
      generateInsights({
        today: to,
        days,
        sessions: allSessions,
        journal: allJournal,
        goals: settings.goals,
        calibrationDates: recalibrationDates(cals),
        timeFormat: settings.timeFormat,
      }).filter((i) => i.id !== 'journal' && i.id !== 'sedentary'),
    [to, days, allSessions, allJournal, settings.goals, cals, settings.timeFormat],
  );

  const avg = (xs: number[]) => (xs.length ? mean(xs) : NaN);
  const f0 = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
  const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
  const metrics: [string, string][] = [
    ['Days with tape data', `${days.length} of ${nDays}`],
    ['Avg active minutes / day', f0(avg(days.map((d) => d.activeMinutes)))],
    ['Avg reps / day', f0(avg(days.map((d) => d.reps)))],
    ['Total reps', String(days.reduce((a, d) => a + d.reps, 0))],
    ['Avg wear time / day', days.length ? formatDuration(avg(days.map((d) => d.wornMinutes))) : '—'],
    ['Avg daily peak activation', `${f0(avg(days.map((d) => d.peakPermille / 10)))}% of calibrated max`],
    ['Avg longest still stretch (waking)', days.length ? formatDuration(avg(days.map((d) => d.longestInactiveMin))) : '—'],
    ['Exercise sessions', `${completed} completed of ${planned} planned (${planned ? Math.round((100 * completed) / planned) : 0}%)`],
    ['Avg session quality', sessions.length ? `${f0(avg(sessions.map((s) => s.avgPeakPct)))}% peak · ${f0((100 * sessions.reduce((a, s) => a + s.goodReps, 0)) / Math.max(1, sessions.reduce((a, s) => a + s.totalReps, 0)))}% good reps` : '—'],
    ['Avg pain (0–10)', f1(avg(journal.map((j) => j.pain)))],
    ['Knee flexion', romVals.length ? `${romVals[0].romFlexion}° → ${romVals[romVals.length - 1].romFlexion}°` : '—'],
    ['Recalibrations in range', recal.length ? recal.map(shortDate).join(', ') : 'none'],
  ];

  const stamp = `${from}_to_${to}`;
  const onImport = async (file: File) => {
    setImportMsg(null);
    try {
      const b = validateBackup(JSON.parse(await file.text()));
      const replace = confirm('Replace ALL current data with this backup?\n\nOK = replace, Cancel = merge into existing data.');
      await importBackup(b, replace ? 'replace' : 'merge');
      setImportMsg(`Imported ${b.records.length.toLocaleString()} minute records, ${b.sessions.length} sessions, ${b.journal.length} journal entries (${replace ? 'replaced' : 'merged'}). Reload to refresh settings.`);
    } catch (e) {
      setImportMsg(`Import failed: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <PageHead title="Share / report" sub="A printable summary for your physical therapist">
        <button className="btn primary" onClick={() => window.print()}>
          <IconPrinter size={16} /> Print / Save as PDF
        </button>
      </PageHead>

      <Card className="no-print" title="Range & exports">
        <div className="stack">
          <div className="row">
            <Segmented
              value={preset}
              onChange={setPreset}
              options={[
                { value: '7', label: '7 days' },
                { value: '14', label: '14 days' },
                { value: '30', label: '30 days' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
            {preset === 'custom' && (
              <>
                <input type="date" value={customFrom} max={customTo} onChange={(e) => e.target.value && setCustomFrom(e.target.value)} style={{ width: 'auto' }} />
                <span className="muted">to</span>
                <input type="date" value={customTo} min={customFrom} max={today} onChange={(e) => e.target.value && setCustomTo(e.target.value)} style={{ width: 'auto' }} />
              </>
            )}
          </div>
          <div className="row">
            <button className="btn" disabled={!records} onClick={() => records && download(`kinetape-minutes_${stamp}.csv`, recordsCsv(records), 'text/csv')}>
              <IconDownload size={16} /> Minute records CSV
            </button>
            <button className="btn" onClick={() => download(`kinetape-sessions_${stamp}.csv`, sessionsCsv(sessions), 'text/csv')}>
              <IconDownload size={16} /> Sessions CSV
            </button>
            <button className="btn" onClick={() => download(`kinetape-journal_${stamp}.csv`, journalCsv(journal), 'text/csv')}>
              <IconDownload size={16} /> Journal CSV
            </button>
            <span className="spacer" />
            <button className="btn" onClick={async () => download(`kinetape-backup_${today}.json`, JSON.stringify(await exportBackup()), 'application/json')}>
              <IconDownload size={16} /> Full backup (JSON)
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              Import backup…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImport(f);
                e.target.value = '';
              }}
            />
          </div>
          {importMsg && <div className="notice">{importMsg}</div>}
          <p className="small muted">Exports are generated on this device; nothing is uploaded. Share files only with people you trust.</p>
        </div>
      </Card>

      <article className="card report">
        <header className="report-head">
          <div>
            <h1>KineTape progress report</h1>
            <div className="text-2">
              {longDate(from)} – {longDate(to)} ({nDays} days)
            </div>
          </div>
          <dl className="kv" style={{ minWidth: 260 }}>
            <dt>Condition</dt>
            <dd>
              {INJURY_LABELS[plan.injury]} ({plan.side})
            </dd>
            <dt>{isSurgical(plan.injury) ? 'Surgery' : 'Injury'} date</dt>
            <dd>
              {plan.eventDate} · week {week}
            </dd>
            <dt>Taped muscle</dt>
            <dd>{plan.muscle}</dd>
            {plan.ptName && (
              <>
                <dt>Physical therapist</dt>
                <dd>{plan.ptName}</dd>
              </>
            )}
            <dt>Generated</dt>
            <dd>{new Date().toLocaleString()}</dd>
          </dl>
        </header>

        <section>
          <h2>Key metrics</h2>
          <table>
            <tbody>
              {metrics.map(([k, v]) => (
                <tr key={k}>
                  <th style={{ width: '45%' }}>{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.notes && <p className="small text-2" style={{ marginTop: 6 }}>Patient notes: {plan.notes}</p>}
        </section>

        <section>
          <h2>Daily active minutes</h2>
          <div className="chart-box" style={{ height: 200 }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="label" interval="preserveStartEnd" {...axisProps(c)} />
                <YAxis allowDecimals={false} {...axisProps(c)} />
                <ReferenceLine y={settings.goals.activeMinutes} stroke={c.muted} strokeDasharray="4 3" />
                <Bar dataKey="active" fill={c.s1} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">Dashed line: goal {settings.goals.activeMinutes} min. A minute is active when the muscle was engaged ≥ 10 s or a rep was completed.</p>
        </section>

        <div className="grid grid-2">
          <section>
            <h2>Peak activation (% of calibrated max)</h2>
            <div className="chart-box" style={{ height: 180 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 14, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <XAxis dataKey="label" interval="preserveStartEnd" {...axisProps(c)} />
                  <YAxis domain={[0, 100]} {...axisProps(c)} />
                  {recalLabels.map((l) => (
                    <ReferenceLine key={l} x={l} stroke={c.s2} strokeDasharray="3 3" label={{ value: 'Recal.', position: 'top', fill: c.text2, fontSize: 10 }} />
                  ))}
                  <Line dataKey="peak" stroke={c.s1} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
          <section>
            <h2>Pain (0–10, self-reported)</h2>
            <div className="chart-box" style={{ height: 180 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 14, right: 8, bottom: 0, left: -24 }}>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <XAxis dataKey="label" interval="preserveStartEnd" {...axisProps(c)} />
                  <YAxis domain={[0, 10]} {...axisProps(c)} />
                  <Line dataKey="pain" stroke={c.s2} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>

        {insights.length > 0 && (
          <section>
            <h2>Observations</h2>
            <div className="stack">
              {insights.slice(0, 6).map((i) => (
                <InsightCard key={i.id} insight={i} />
              ))}
            </div>
          </section>
        )}

        <section>
          <h2>Exercise sessions ({sessions.length})</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Exercise</th>
                  <th className="num">Reps</th>
                  <th className="num">Good</th>
                  <th className="num">Avg hold</th>
                  <th className="num">Avg / max peak</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[...sessions].reverse().map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td>{s.exerciseName}</td>
                    <td className="num">
                      {s.totalReps}/{s.targetSets * s.targetReps}
                    </td>
                    <td className="num">{s.goodReps}</td>
                    <td className="num">
                      {s.avgHoldS}s / {s.targetHoldS}s
                    </td>
                    <td className="num">
                      {s.avgPeakPct}% / {s.maxPeakPct}%
                    </td>
                    <td>{s.completed ? 'Complete' : 'Partial'}</td>
                  </tr>
                ))}
                {!sessions.length && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No sessions in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>Journal ({journal.length})</h2>
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
                {[...journal].reverse().map((j) => (
                  <tr key={j.date}>
                    <td>{shortDate(j.date)}</td>
                    <td className="num">{j.pain}</td>
                    <td>{SWELLING_LABELS[j.swelling]}</td>
                    <td className="num">{j.romFlexion !== undefined ? `${j.romFlexion}°` : '—'}</td>
                    <td className="num">{j.romExtension !== undefined ? `${j.romExtension}°` : '—'}</td>
                    <td>{j.notes}</td>
                  </tr>
                ))}
                {!journal.length && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No journal entries in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>About these numbers</h2>
          <p className="small text-2">
            Data comes from a thin-film pressure sensor under kinesiology tape over the {plan.muscle.toLowerCase()}, summarised per minute on the device. Activation is
            relative to the patient’s own calibration (relaxed vs. maximum comfortable contraction) and is not a validated clinical strength measure; values are
            not comparable across recalibrations. Journal values are self-reported.
          </p>
          <div style={{ marginTop: 10 }}>
            <Disclaimer />
          </div>
        </section>
      </article>
    </>
  );
}
