import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '../db/db';
import type { StoredRecord } from '../device/types';
import { summarizeDays, type DaySummary } from '../analytics/summary';
import { addDays, dateKeyStartEpoch, epochToDateKey, todayKey } from '../analytics/time';
import { generateInsights, type Insight } from '../insights';
import type { JournalEntry, SessionResult, Settings } from '../types';
import type { CalibrationRow } from '../db/db';

const EMPTY: never[] = [];

/** Records whose epoch falls in [fromKey 00:00, toKey+1 00:00). */
export function useRecords(fromKey: string, toKey: string): StoredRecord[] | undefined {
  return useLiveQuery(
    () => db.records.where('epoch').between(dateKeyStartEpoch(fromKey), dateKeyStartEpoch(addDays(toKey, 1)), true, false).toArray(),
    [fromKey, toKey],
  );
}

export function useDaySummaries(fromKey: string, toKey: string, settings: Settings): { days: DaySummary[]; loading: boolean } {
  const recs = useRecords(fromKey, toKey);
  const days = useMemo(
    () => (recs ? summarizeDays(recs, { wakeStartMin: settings.wakeStartMin, wakeEndMin: settings.wakeEndMin }) : []),
    [recs, settings.wakeStartMin, settings.wakeEndMin],
  );
  return { days, loading: recs === undefined };
}

export function useSessions(): SessionResult[] {
  return useLiveQuery(() => db.sessions.orderBy('startedAt').toArray(), []) ?? EMPTY;
}

export function useJournal(): JournalEntry[] {
  return useLiveQuery(() => db.journal.orderBy('date').toArray(), []) ?? EMPTY;
}

export function useCalibrations(): CalibrationRow[] {
  return useLiveQuery(() => db.calibrations.orderBy('at').toArray(), []) ?? EMPTY;
}

export function useUnknownTimeCount(): number {
  return useLiveQuery(() => db.records.filter((r) => r.epoch === undefined).count(), []) ?? 0;
}

/** Recalibration dates (excluding the first calibration of each device). */
export function recalibrationDates(cals: CalibrationRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cals) {
    if (seen.has(c.deviceId)) out.push(epochToDateKey(Math.floor(c.at / 1000)));
    seen.add(c.deviceId);
  }
  return out;
}

export function useInsights(settings: Settings): { insights: Insight[]; loading: boolean } {
  const today = todayKey();
  const { days, loading } = useDaySummaries(addDays(today, -35), today, settings);
  const sessions = useSessions();
  const journal = useJournal();
  const cals = useCalibrations();
  const insights = useMemo(
    () =>
      generateInsights({
        today,
        days,
        sessions,
        journal,
        goals: settings.goals,
        calibrationDates: recalibrationDates(cals),
        timeFormat: settings.timeFormat,
      }),
    [today, days, sessions, journal, settings.goals, cals, settings.timeFormat],
  );
  return { insights, loading };
}

export const sessionDateKey = (s: SessionResult) => {
  const d = new Date(s.startedAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function sessionsPerDay(sessions: SessionResult[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) if (s.completed) m.set(sessionDateKey(s), (m.get(sessionDateKey(s)) ?? 0) + 1);
  return m;
}

export function fmtAct(permille: number, unit: Settings['activationUnit']): string {
  return unit === 'permille' ? `${Math.round(permille)}‰` : `${Math.round(permille / 10)}%`;
}
