import { describe, expect, it } from 'vitest';
import type { StoredRecord } from '../device/types';
import { aggregatePeriods, currentStreak, longestInactiveStretch, longestStreak, percentile, summarizeDay, summarizeDays } from './summary';
import { addDays, dateKeyStartEpoch, weekStartKey } from './time';

const WIN = { wakeStartMin: 7 * 60, wakeEndMin: 22 * 60 };

function rec(epoch: number, o: Partial<StoredRecord> = {}): StoredRecord {
  return {
    deviceId: 'd',
    generation: 0,
    index: epoch,
    t: epoch,
    bootId: 1,
    flags: 3,
    sensorOk: true,
    mean: 50,
    peak: 100,
    reps: 0,
    activeSeconds: 0,
    epoch,
    timeSource: 'device',
    ...o,
  };
}

describe('summarizeDay', () => {
  const day = '2026-03-10';
  const base = dateKeyStartEpoch(day);
  it('computes active minutes, reps, mean/peak, hourly buckets', () => {
    const recs = [
      rec(base + 9 * 3600, { reps: 3, activeSeconds: 20, peak: 700, mean: 200 }),
      rec(base + 9 * 3600 + 60, { activeSeconds: 12, peak: 400, mean: 100 }),
      rec(base + 9 * 3600 + 120, { activeSeconds: 2, mean: 30 }), // not active
      rec(base + 15 * 3600, { reps: 1, activeSeconds: 3, mean: 40 }), // active via rep
      rec(base + 86400 + 60, { reps: 99 }), // next day — ignored
    ];
    const s = summarizeDay(day, recs, WIN);
    expect(s.wornMinutes).toBe(4);
    expect(s.activeMinutes).toBe(3);
    expect(s.reps).toBe(4);
    expect(s.peakPermille).toBe(700);
    expect(s.meanPermille).toBe(Math.round((200 + 100 + 30 + 40) / 4));
    expect(s.hourly[9]).toMatchObject({ activeMinutes: 2, reps: 3, wornMinutes: 3 });
    expect(s.hourly[15].activeMinutes).toBe(1);
  });

  it('ignores records with unknown time', () => {
    const s = summarizeDay(day, [rec(base + 3600, { epoch: undefined, timeSource: 'unknown' })], WIN);
    expect(s.wornMinutes).toBe(0);
  });
});

describe('longestInactiveStretch', () => {
  const base = dateKeyStartEpoch('2026-03-10');
  it('counts consecutive inactive waking minutes and breaks on gaps / activity', () => {
    const recs: StoredRecord[] = [];
    for (let m = 0; m < 50; m++) recs.push(rec(base + 10 * 3600 + m * 60)); // 10:00–10:49 inactive
    recs.push(rec(base + 10 * 3600 + 50 * 60, { reps: 1 })); // active breaks
    for (let m = 51; m < 71; m++) recs.push(rec(base + 10 * 3600 + m * 60)); // 20 min
    // gap of 30 min (not worn) then 40 inactive — gap breaks the run
    for (let m = 100; m < 140; m++) recs.push(rec(base + 10 * 3600 + m * 60));
    const r = longestInactiveStretch(recs, WIN);
    expect(r.length).toBe(50);
    expect(r.startMin).toBe(600);
  });
  it('ignores minutes outside waking hours', () => {
    const recs: StoredRecord[] = [];
    for (let m = 0; m < 120; m++) recs.push(rec(base + 1 * 3600 + m * 60)); // 1am–3am
    expect(longestInactiveStretch(recs, WIN).length).toBe(0);
  });
});

describe('summarizeDays / aggregatePeriods / streaks', () => {
  it('groups by local day and week', () => {
    const start = '2026-03-02'; // a Monday
    const recs: StoredRecord[] = [];
    for (let d = 0; d < 14; d++) {
      const e = dateKeyStartEpoch(addDays(start, d)) + 10 * 3600;
      for (let m = 0; m < 10; m++) recs.push(rec(e + m * 60, { reps: 2, activeSeconds: 20, peak: 300 + d * 10 }));
    }
    const days = summarizeDays(recs, WIN);
    expect(days).toHaveLength(14);
    expect(days[0].date).toBe(start);
    const weeks = aggregatePeriods(days, weekStartKey);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({ key: start, days: 7, avgActiveMinutes: 10, totalReps: 140, peakPermille: 360 });
  });

  it('computes current and longest streaks', () => {
    const today = '2026-03-20';
    const met = new Map<string, boolean>();
    for (let i = 1; i <= 4; i++) met.set(addDays(today, -i), true); // 4 days ending yesterday
    met.set(addDays(today, -5), false);
    for (let i = 6; i <= 12; i++) met.set(addDays(today, -i), true); // 7-day streak earlier
    expect(currentStreak(met, today, addDays)).toBe(4);
    met.set(today, true);
    expect(currentStreak(met, today, addDays)).toBe(5);
    expect(longestStreak(met, addDays)).toBe(7);
  });

  it('percentile', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});
