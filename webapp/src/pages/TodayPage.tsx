import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp, isConnectedPhase } from '../state/AppContext';
import { fmtAct, sessionDateKey, useDaySummaries, useInsights, useSessions } from '../state/data';
import { addDays, formatDuration, formatMinuteOfDay, longDate, todayKey } from '../analytics/time';
import { Card, GoalRing, InsightCard, Segmented, Stat } from '../ui/components';
import { ChartTip, axisProps, useChartColors } from '../ui/charts';
import { IconChevronLeft, IconChevronRight, IconRefresh } from '../ui/icons';
import { ConnectButtons, PageHead } from './common';

export function TodayPage() {
  const { settings, client, phase, syncNow, syncProgress } = useApp();
  const [date, setDate] = useState(todayKey());
  const [metric, setMetric] = useState<'activeMinutes' | 'reps'>('activeMinutes');
  const { days, loading } = useDaySummaries(date, date, settings);
  const sessions = useSessions();
  const { insights } = useInsights(settings);
  const c = useChartColors();
  const day = days[0];
  const isToday = date === todayKey();
  const sessionsToday = sessions.filter((s) => s.completed && sessionDateKey(s) === date).length;
  const fmtH = (h: number) => formatMinuteOfDay(h * 60, settings.timeFormat).replace(':00', '');
  const hourly = useMemo(() => (day ? day.hourly.map((h) => ({ ...h, label: fmtH(h.hour) })) : []), [day, settings.timeFormat]); // eslint-disable-line react-hooks/exhaustive-deps
  const wakeStartH = settings.wakeStartMin / 60;
  const wakeEndH = settings.wakeEndMin / 60;

  return (
    <>
      <PageHead title={isToday ? 'Today' : longDate(date)} sub={isToday ? longDate(date) : 'Daily summary'}>
        <button className="btn icon" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>
          <IconChevronLeft />
        </button>
        <button className="btn" disabled={isToday} onClick={() => setDate(todayKey())}>
          Today
        </button>
        <button className="btn icon" aria-label="Next day" disabled={isToday} onClick={() => setDate(addDays(date, 1))}>
          <IconChevronRight />
        </button>
        {client && isConnectedPhase(phase) && (
          <button className="btn" onClick={() => void syncNow()} disabled={!!syncProgress}>
            <IconRefresh size={16} /> {syncProgress ? 'Syncing…' : 'Sync'}
          </button>
        )}
      </PageHead>

      {!loading && !day && (
        <div className="card empty">
          <h2>No tape data for this day</h2>
          <p className="text-2">
            {client ? 'Sync your tape to pull in the latest minutes.' : 'Connect your KineTape to sync, or try Demo mode to explore with sample data.'}
          </p>
          {!client && <ConnectButtons />}
        </div>
      )}

      {day && isToday && day.wornMinutes < 180 && (
        <div className="notice no-print">
          It’s early in the day — only {formatDuration(day.wornMinutes)} recorded so far.
          <button className="btn ghost" style={{ minHeight: 0, padding: '0 6px' }} onClick={() => setDate(addDays(date, -1))}>
            See yesterday →
          </button>
        </div>
      )}

      {day && (
        <>
          <div className="grid grid-3">
            <Card title="Goals" className="span-2">
              <div className="rings">
                <GoalRing value={day.activeMinutes} goal={settings.goals.activeMinutes} label="Active minutes" unit="min" color={c.s1} />
                <GoalRing value={day.reps} goal={settings.goals.reps} label="Reps" color={c.s3} />
                <GoalRing value={sessionsToday} goal={settings.goals.sessions} label="Exercise sessions" color={c.s2} />
              </div>
            </Card>
            <Card title="Waking-hours stillness">
              <div className="stat">
                <div className="value">{formatDuration(day.longestInactiveMin)}</div>
                <div className="foot">
                  {day.longestInactiveStartMin !== null
                    ? `Longest stretch with almost no muscle activity, from ${formatMinuteOfDay(day.longestInactiveStartMin, settings.timeFormat)}`
                    : 'No inactive stretch recorded'}
                </div>
              </div>
              <p className="small muted" style={{ marginTop: 10 }}>
                Waking hours: {formatMinuteOfDay(settings.wakeStartMin, settings.timeFormat)}–{formatMinuteOfDay(settings.wakeEndMin, settings.timeFormat)}
              </p>
            </Card>
          </div>

          <div className="grid grid-4">
            <Stat label="Active minutes" value={day.activeMinutes} unit="min" foot={`${formatDuration(day.wornMinutes)} worn`} />
            <Stat label="Reps" value={day.reps} foot="completed contractions" />
            <Stat label="Mean activation" value={fmtAct(day.meanPermille, settings.activationUnit)} foot="average over worn minutes" />
            <Stat label="Peak activation" value={fmtAct(day.peakPermille, settings.activationUnit)} foot="of calibrated max" />
          </div>

          <Card
            title="Hourly activity"
            hint="Shaded: outside waking hours"
            action={
              <Segmented
                value={metric}
                onChange={setMetric}
                options={[
                  { value: 'activeMinutes', label: 'Active min' },
                  { value: 'reps', label: 'Reps' },
                ]}
              />
            }
          >
            <div className="chart-box">
              <ResponsiveContainer>
                <BarChart data={hourly} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <ReferenceArea x1={hourly[0]?.label} x2={hourly[Math.max(0, Math.floor(wakeStartH) - 1)]?.label} fill={c.grid} fillOpacity={0.5} />
                  <ReferenceArea x1={hourly[Math.min(23, Math.ceil(wakeEndH))]?.label} x2={hourly[23]?.label} fill={c.grid} fillOpacity={0.5} />
                  <XAxis dataKey="label" interval={2} {...axisProps(c)} />
                  <YAxis allowDecimals={false} {...axisProps(c)} />
                  <Tooltip
                    cursor={{ fill: c.grid, fillOpacity: 0.5 }}
                    content={<ChartTip valueFormatter={(v) => (metric === 'reps' ? `${v} reps` : `${v} min`)} />}
                  />
                  <Bar dataKey={metric} name={metric === 'reps' ? 'Reps' : 'Active minutes'} fill={metric === 'reps' ? c.s3 : c.s1} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </>
      )}

      {isToday && (
        <Card title="Insights" hint="Plain-language observations — not medical advice" action={<a href="#/progress">See all</a>}>
          <div className="stack">
            {insights.slice(0, 4).map((i) => (
              <InsightCard key={i.id} insight={i} />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
