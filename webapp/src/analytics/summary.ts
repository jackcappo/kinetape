/**
 * Pure aggregation of minute records into daily / weekly summaries.
 */
import type { StoredRecord } from '../device/types';
import { epochToDateKey, minuteOfDay, weekStartKey } from './time';

/** A minute counts as "active" when the muscle was engaged ≥ 10 s of it, or a rep was completed. */
export const ACTIVE_MINUTE_SECONDS = 10;
/** A minute counts as "inactive" when engagement < 2 s and no reps. */
export const INACTIVE_MINUTE_SECONDS = 2;

export const isActiveMinute = (r: Pick<StoredRecord, 'activeSeconds' | 'reps'>) =>
  r.activeSeconds >= ACTIVE_MINUTE_SECONDS || r.reps > 0;
export const isInactiveMinute = (r: Pick<StoredRecord, 'activeSeconds' | 'reps'>) =>
  r.activeSeconds < INACTIVE_MINUTE_SECONDS && r.reps === 0;

export interface HourBucket {
  hour: number;
  activeMinutes: number;
  reps: number;
  meanPermille: number;
  wornMinutes: number;
}

export interface DaySummary {
  date: string;
  wornMinutes: number;
  activeMinutes: number;
  activeSeconds: number;
  reps: number;
  meanPermille: number;
  peakPermille: number;
  hourly: HourBucket[];
  longestInactiveMin: number;
  longestInactiveStartMin: number | null;
  sensorIssueMinutes: number;
}

export interface WakingWindow {
  wakeStartMin: number;
  wakeEndMin: number;
}

/** Summarise records that belong to one local day. Records without an epoch are ignored. */
export function summarizeDay(date: string, records: StoredRecord[], win: WakingWindow): DaySummary {
  const recs = records
    .filter((r) => r.epoch !== undefined && epochToDateKey(r.epoch) === date)
    .sort((a, b) => a.epoch! - b.epoch!);
  const hourly: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, activeMinutes: 0, reps: 0, meanPermille: 0, wornMinutes: 0 }));
  let active = 0;
  let activeSeconds = 0;
  let reps = 0;
  let meanSum = 0;
  let peak = 0;
  let sensorIssue = 0;
  for (const r of recs) {
    const h = hourly[Math.floor(minuteOfDay(r.epoch!) / 60)];
    h.wornMinutes++;
    h.meanPermille += r.mean;
    h.reps += r.reps;
    if (isActiveMinute(r)) {
      h.activeMinutes++;
      active++;
    }
    activeSeconds += r.activeSeconds;
    reps += r.reps;
    meanSum += r.mean;
    if (r.peak > peak) peak = r.peak;
    if (!r.sensorOk) sensorIssue++;
  }
  for (const h of hourly) h.meanPermille = h.wornMinutes ? Math.round(h.meanPermille / h.wornMinutes) : 0;
  const { length, startMin } = longestInactiveStretch(recs, win);
  return {
    date,
    wornMinutes: recs.length,
    activeMinutes: active,
    activeSeconds,
    reps,
    meanPermille: recs.length ? Math.round(meanSum / recs.length) : 0,
    peakPermille: peak,
    hourly,
    longestInactiveMin: length,
    longestInactiveStartMin: startMin,
    sensorIssueMinutes: sensorIssue,
  };
}

/**
 * Longest run of consecutive inactive minutes inside waking hours.
 * Missing minutes (tape not worn / device off) break a run — we only count what we observed.
 */
export function longestInactiveStretch(
  sortedRecs: Pick<StoredRecord, 'epoch' | 'activeSeconds' | 'reps'>[],
  win: WakingWindow,
): { length: number; startMin: number | null } {
  let best = 0;
  let bestStart: number | null = null;
  let run = 0;
  let runStart: number | null = null;
  let prevEpoch: number | null = null;
  for (const r of sortedRecs) {
    if (r.epoch === undefined) continue;
    const mod = minuteOfDay(r.epoch);
    const waking = mod >= win.wakeStartMin && mod < win.wakeEndMin;
    const contiguous = prevEpoch !== null && r.epoch - prevEpoch <= 90;
    if (waking && isInactiveMinute(r)) {
      if (run > 0 && contiguous) run++;
      else {
        run = 1;
        runStart = mod;
      }
      if (run > best) {
        best = run;
        bestStart = runStart;
      }
    } else run = 0;
    prevEpoch = r.epoch;
  }
  return { length: best, startMin: bestStart };
}

/** Group records by local day and summarise each day that has data. */
export function summarizeDays(records: StoredRecord[], win: WakingWindow): DaySummary[] {
  const byDay = new Map<string, StoredRecord[]>();
  for (const r of records) {
    if (r.epoch === undefined) continue;
    const k = epochToDateKey(r.epoch);
    let arr = byDay.get(k);
    if (!arr) byDay.set(k, (arr = []));
    arr.push(r);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, recs]) => summarizeDay(k, recs, win));
}

export interface PeriodSummary {
  key: string;
  days: number;
  avgActiveMinutes: number;
  totalReps: number;
  avgReps: number;
  peakPermille: number;
  avgPeakPermille: number;
  sessions: number;
}

/** Aggregate day summaries into periods (e.g. weeks via weekStartKey, months via monthKey). */
export function aggregatePeriods(
  days: DaySummary[],
  keyFn: (date: string) => string = weekStartKey,
  sessionsPerDay: Map<string, number> = new Map(),
): PeriodSummary[] {
  const groups = new Map<string, DaySummary[]>();
  for (const d of days) {
    const k = keyFn(d.date);
    let arr = groups.get(k);
    if (!arr) groups.set(k, (arr = []));
    arr.push(d);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, ds]) => {
      const n = ds.length;
      const totalReps = ds.reduce((s, d) => s + d.reps, 0);
      return {
        key,
        days: n,
        avgActiveMinutes: Math.round(ds.reduce((s, d) => s + d.activeMinutes, 0) / n),
        totalReps,
        avgReps: Math.round(totalReps / n),
        peakPermille: Math.max(...ds.map((d) => d.peakPermille)),
        avgPeakPermille: Math.round(ds.reduce((s, d) => s + d.peakPermille, 0) / n),
        sessions: ds.reduce((s, d) => s + (sessionsPerDay.get(d.date) ?? 0), 0),
      };
    });
}

/**
 * Consecutive days (ending today, or yesterday if today isn't met yet) that meet a predicate.
 * Days missing from the map break the streak.
 */
export function currentStreak(dayMet: Map<string, boolean>, today: string, addDaysFn: (k: string, n: number) => string): number {
  let k = dayMet.get(today) ? today : addDaysFn(today, -1);
  let n = 0;
  while (dayMet.get(k)) {
    n++;
    k = addDaysFn(k, -1);
  }
  return n;
}

export function longestStreak(dayMet: Map<string, boolean>, addDaysFn: (k: string, n: number) => string): number {
  const keys = [...dayMet.keys()].sort();
  let best = 0;
  for (const k of keys) {
    if (!dayMet.get(k) || dayMet.get(addDaysFn(k, -1))) continue; // only start at streak heads
    let n = 0;
    let c = k;
    while (dayMet.get(c)) {
      n++;
      c = addDaysFn(c, 1);
    }
    best = Math.max(best, n);
  }
  return best;
}

/** Robust "strength proxy" for a day: the 95th percentile of minute peaks (less noisy than the max). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
