import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../state/AppContext';
import { recalibrationDates, sessionsPerDay, useCalibrations, useDaySummaries, useInsights, useSessions } from '../state/data';
import { aggregatePeriods, currentStreak, longestStreak } from '../analytics/summary';
import { addDays, dateRange, monthKey, parseDateKey, shortDate, todayKey, weekStartKey } from '../analytics/time';
import { Card, InsightCard, Segmented, Stat } from '../ui/components';
import { ChartTip, axisProps, useChartColors } from '../ui/charts';
import { PageHead } from './common';

type Range = 'daily' | 'weekly' | 'monthly';

const RANGE_DAYS: Record<Range, number> = { daily: 30, weekly: 7 * 12, monthly: 182 };

interface Point {
  key: string;
  label: string;
  activeMinutes: number | null;
  reps: number | null;
  peak: number | null;
  adherence: number | null;
}

export function ProgressPage() {
  const { settings } = useApp();
  const [range, setRange] = useState<Range>('daily');
  const today = todayKey();
  const from = addDays(today, -(RANGE_DAYS[range] - 1));
  const { days } = useDaySummaries(from, today, settings);
  const sessions = useSessions();
  const cals = useCalibrations();
  const { insights } = useInsights(settings);
  const c = useChartColors();
  const perDay = useMemo(() => sessionsPerDay(sessions), [sessions]);
  const recal = useMemo(() => recalibrationDates(cals), [cals]);
  const goal = settings.goals;

  const points: Point[] = useMemo(() => {
    if (range === 'daily') {
      const byDate = new Map(days.map((d) => [d.date, d]));
      return dateRange(from, today).map((k) => {
        const d = byDate.get(k);
        const sess = perDay.get(k) ?? 0;
        return {
          key: k,
          label: shortDate(k),
          activeMinutes: d ? d.activeMinutes : null,
          reps: d ? d.reps : null,
          peak: d ? Math.round(d.peakPermille / 10) : null,
          adherence: goal.sessions ? Math.min(100, Math.round((100 * sess) / goal.sessions)) : null,
        };
      });
    }
    const keyFn = range === 'weekly' ? weekStartKey : monthKey;
    const periods = aggregatePeriods(days, keyFn, perDay);
    return periods.map((p) => {
      // planned sessions = goal × number of calendar days of the period that are in range and ≤ today
      const pDays = dateRange(from, today).filter((k) => keyFn(k) === p.key).length;
      return {
        key: p.key,
        label: range === 'weekly' ? `Wk of ${shortDate(p.key)}` : parseDateKey(p.key + '-01').toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
        activeMinutes: p.avgActiveMinutes,
        reps: p.avgReps,
        peak: Math.round(p.avgPeakPermille / 10),
        adherence: goal.sessions ? Math.min(100, Math.round((100 * p.sessions) / (goal.sessions * pDays))) : null,
      };
    });
  }, [range, days, perDay, from, today, goal.sessions]);

  const recalLabels = useMemo(() => {
    const out = new Set<string>();
    for (const k of recal) {
      if (k < from) continue;
      const key = range === 'daily' ? k : range === 'weekly' ? weekStartKey(k) : monthKey(k);
      const p = points.find((x) => x.key === key);
      if (p) out.add(p.label);
    }
    return [...out];
  }, [recal, points, range, from]);

  const allDays = useDaySummaries(addDays(today, -180), today, settings).days;
  const met = useMemo(() => new Map(allDays.map((d) => [d.date, d.activeMinutes >= goal.activeMinutes])), [allDays, goal.activeMinutes]);
  const streak = currentStreak(met, today, addDays);
  const best = longestStreak(met, addDays);
  const metInRange = days.filter((d) => d.activeMinutes >= goal.activeMinutes).length;
  const sessIn = sessions.filter((s) => s.completed && new Date(s.startedAt) >= parseDateKey(from)).length;
  const daysIn = dateRange(from, today).length;
  const adherencePct = goal.sessions ? Math.round((100 * sessIn) / (goal.sessions * daysIn)) : 0;

  const avgSuffix = range === 'daily' ? '' : ' (daily average)';
  const interval = range === 'daily' ? 4 : 'preserveStartEnd';
  const tip = (unit: string) => <ChartTip valueFormatter={(v) => `${v}${unit}`} />;

  return (
    <>
      <PageHead title="Progress" sub="Trends over time — compare yourself with yourself">
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { value: 'daily', label: '30 days' },
            { value: 'weekly', label: '12 weeks' },
            { value: 'monthly', label: '6 months' },
          ]}
        />
      </PageHead>

      <div className="grid grid-4">
        <Stat label="Current streak" value={streak} unit={streak === 1 ? 'day' : 'days'} foot={`at ${goal.activeMinutes}+ active min`} />
        <Stat label="Longest streak" value={best} unit="days" foot="last 6 months" />
        <Stat label="Days at goal" value={metInRange} unit={`/ ${days.length}`} foot="days with data in range" />
        <Stat label="Session adherence" value={Math.min(100, adherencePct)} unit="%" foot={`${sessIn} of ${goal.sessions * daysIn} planned`} />
      </div>

      <div className="grid grid-2">
        <Card title={`Active minutes${avgSuffix}`} hint={`Dashed: goal ${goal.activeMinutes} min`}>
          <div className="chart-box">
            <ResponsiveContainer>
              <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="label" interval={interval} {...axisProps(c)} />
                <YAxis allowDecimals={false} {...axisProps(c)} />
                <Tooltip cursor={{ fill: c.grid, fillOpacity: 0.5 }} content={tip(' min')} />
                <ReferenceLine y={goal.activeMinutes} stroke={c.muted} strokeDasharray="4 3" />
                <Bar dataKey="activeMinutes" name="Active minutes" fill={c.s1} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title={`Reps${avgSuffix}`} hint={`Dashed: goal ${goal.reps}`}>
          <div className="chart-box">
            <ResponsiveContainer>
              <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="label" interval={interval} {...axisProps(c)} />
                <YAxis allowDecimals={false} {...axisProps(c)} />
                <Tooltip cursor={{ fill: c.grid, fillOpacity: 0.5 }} content={tip(' reps')} />
                <ReferenceLine y={goal.reps} stroke={c.muted} strokeDasharray="4 3" />
                <Bar dataKey="reps" name="Reps" fill={c.s3} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card
          title={`Peak activation${range === 'daily' ? '' : ' (average daily peak)'}`}
          hint="Strength proxy, % of calibrated max · vertical lines mark recalibrations"
        >
          <div className="chart-box">
            <ResponsiveContainer>
              <LineChart data={points} margin={{ top: 16, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="label" interval={interval} {...axisProps(c)} />
                <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} {...axisProps(c)} />
                <Tooltip content={tip('%')} />
                {recalLabels.map((l) => (
                  <ReferenceLine key={l} x={l} stroke={c.s2} strokeDasharray="3 3" label={{ value: 'Recalibrated', position: 'top', fill: c.text2, fontSize: 10 }} />
                ))}
                <Line type="monotone" dataKey="peak" name="Peak activation" stroke={c.s1} strokeWidth={2} dot={range === 'daily' ? false : { r: 4 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">After a recalibration the same effort can read differently, so compare within the segments between lines.</p>
        </Card>
        <Card title="Exercise-session adherence" hint={`% of ${goal.sessions} planned sessions per day`}>
          <div className="chart-box">
            <ResponsiveContainer>
              <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="label" interval={interval} {...axisProps(c)} />
                <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} {...axisProps(c)} />
                <Tooltip cursor={{ fill: c.grid, fillOpacity: 0.5 }} content={tip('%')} />
                <Bar dataKey="adherence" name="Adherence" fill={c.s2} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card title="Insights" hint="Generated from your data · cautious, general observations only">
        <div className="stack">
          {insights.map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      </Card>
    </>
  );
}
