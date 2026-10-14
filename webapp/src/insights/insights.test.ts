import { describe, expect, it } from 'vitest';
import type { DaySummary } from '../analytics/summary';
import { addDays, dateKeyStartEpoch } from '../analytics/time';
import type { JournalEntry, SessionResult } from '../types';
import {
  activitySpike,
  generateInsights,
  goalStreaks,
  journalReminder,
  painActivityCorrelation,
  painTrend,
  romProgress,
  sedentaryStretch,
  sessionAdherence,
  swellingChange,
  weekOverWeekActivity,
  weekOverWeekPeak,
  type InsightInput,
} from './index';
import { pearson, slope } from './stats';

const TODAY = '2026-05-20';

function day(date: string, o: Partial<DaySummary> = {}): DaySummary {
  return {
    date,
    wornMinutes: 800,
    activeMinutes: 40,
    activeSeconds: 2400,
    reps: 150,
    meanPermille: 60,
    peakPermille: 600,
    hourly: [],
    longestInactiveMin: 30,
    longestInactiveStartMin: 600,
    sensorIssueMinutes: 0,
    ...o,
  };
}

function lastNDays(n: number, f: (i: number, date: string) => Partial<DaySummary> = () => ({})): DaySummary[] {
  // i = 1 → yesterday … n
  return Array.from({ length: n }, (_, k) => {
    const i = n - k;
    const date = addDays(TODAY, -i);
    return day(date, f(i, date));
  });
}

function input(o: Partial<InsightInput> = {}): InsightInput {
  return {
    today: TODAY,
    days: [],
    sessions: [],
    journal: [],
    goals: { activeMinutes: 45, reps: 150, sessions: 2 },
    calibrationDates: [],
    ...o,
  };
}

function session(date: string, completed = true, i = 0): SessionResult {
  const t = dateKeyStartEpoch(date) * 1000 + (9 + i * 8) * 3600000;
  return {
    id: `${date}-${i}`,
    exerciseId: 'quad_sets',
    exerciseName: 'Quad sets',
    startedAt: t,
    endedAt: t + 600000,
    targetSets: 3,
    targetReps: 10,
    targetHoldS: 5,
    qualityTargetPct: 50,
    sets: [],
    totalReps: 30,
    goodReps: 25,
    avgHoldS: 5,
    avgPeakPct: 60,
    maxPeakPct: 70,
    completed,
    calibrated: true,
    source: 'device',
  };
}

const journal = (date: string, pain: number, o: Partial<JournalEntry> = {}): JournalEntry => ({
  date,
  pain,
  swelling: 1,
  notes: '',
  updatedAt: 0,
  ...o,
});

describe('stats', () => {
  it('pearson and slope', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
    expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3]))).toBe(true);
    expect(slope([0, 1, 2], [1, 3, 5])).toBeCloseTo(2);
  });
});

describe('week over week', () => {
  it('reports an increase in active minutes', () => {
    const days = lastNDays(14, (i) => ({ activeMinutes: i <= 7 ? 60 : 40 }));
    const r = weekOverWeekActivity(input({ days }));
    expect(r?.tone).toBe('positive');
    expect(r?.title).toContain('50%');
  });
  it('reports a decrease cautiously', () => {
    const days = lastNDays(14, (i) => ({ activeMinutes: i <= 7 ? 20 : 40 }));
    const r = weekOverWeekActivity(input({ days }));
    expect(r?.tone).toBe('info');
    expect(r?.body).toMatch(/physical therapist/);
  });
  it('needs enough days', () => {
    expect(weekOverWeekActivity(input({ days: lastNDays(6) }))).toBeNull();
  });
  it('flags recalibration on peak comparisons', () => {
    const days = lastNDays(14, (i) => ({ peakPermille: i <= 7 ? 500 : 700 }));
    const r = weekOverWeekPeak(input({ days, calibrationDates: [addDays(TODAY, -5)] }));
    expect(r?.body).toMatch(/recalibrated/);
    expect(r?.tone).toBe('info');
    const r2 = weekOverWeekPeak(input({ days: lastNDays(14, (i) => ({ peakPermille: i <= 7 ? 700 : 500 })) }));
    expect(r2?.tone).toBe('positive');
    expect(r2?.body).not.toMatch(/recalibrated/);
  });
});

describe('adherence', () => {
  it('counts completed sessions in the last 7 days', () => {
    const sessions: SessionResult[] = [];
    for (let i = 1; i <= 7; i++) sessions.push(session(addDays(TODAY, -i), true, 0), session(addDays(TODAY, -i), true, 1));
    expect(sessionAdherence(input({ sessions }))?.tone).toBe('positive');
    const few = sessions.slice(0, 5);
    const r = sessionAdherence(input({ sessions: few }));
    expect(r?.tone).toBe('caution');
    expect(r?.title).toBe('5 of 14 planned sessions this week');
    expect(sessionAdherence(input({ sessions: [] }))).toBeNull();
  });
});

describe('sedentary stretch', () => {
  it('suggests movement after ≥ 90 min still during waking hours', () => {
    const r = sedentaryStretch(input({ days: [day(TODAY, { longestInactiveMin: 135, longestInactiveStartMin: 13 * 60 + 5 })], timeFormat: '24h' }));
    expect(r?.title).toContain('2 h 15 min');
    expect(r?.body).toContain('13:05');
    expect(sedentaryStretch(input({ days: [day(TODAY, { longestInactiveMin: 60 })] }))).toBeNull();
  });
});

describe('pain', () => {
  it('detects downward and upward trends', () => {
    const down = Array.from({ length: 10 }, (_, i) => journal(addDays(TODAY, -10 + i), 6 - i * 0.4));
    expect(painTrend(input({ journal: down }))?.tone).toBe('positive');
    const up = Array.from({ length: 10 }, (_, i) => journal(addDays(TODAY, -10 + i), 2 + i * 0.3));
    const r = painTrend(input({ journal: up }));
    expect(r?.tone).toBe('caution');
    expect(r?.body).toMatch(/contact your physical therapist/);
  });
  it('correlates activity with next-day pain, phrased cautiously', () => {
    const days = lastNDays(20, (i) => ({ activeMinutes: i % 2 ? 80 : 30 }));
    // next-day pain follows activity
    const j = days.map((d) => journal(addDays(d.date, 1), d.activeMinutes > 50 ? 5 : 2));
    const r = painActivityCorrelation(input({ days, journal: j }));
    expect(r?.title).toMatch(/followed by more pain/);
    expect(r?.body).toMatch(/not proof of cause/);
    // no relationship → nothing
    const flat = days.map((d) => journal(addDays(d.date, 1), 3));
    expect(painActivityCorrelation(input({ days, journal: flat }))).toBeNull();
  });
});

describe('streaks', () => {
  it('celebrates consecutive goal days', () => {
    const days = lastNDays(5, (i) => ({ activeMinutes: i <= 3 ? 50 : 10, reps: 10 }));
    const r = goalStreaks(input({ days }));
    expect(r?.title).toBe('3 days in a row at your active-minutes goal');
  });
  it('falls back to rep streak', () => {
    const days = lastNDays(5, () => ({ activeMinutes: 10, reps: 200 }));
    expect(goalStreaks(input({ days }))?.title).toBe('5 days in a row at your rep goal');
  });
});

describe('activity spike', () => {
  it('warns on a sudden jump vs the prior week', () => {
    const days = lastNDays(8, (i) => ({ activeMinutes: i === 1 ? 95 : 40 }));
    const r = activitySpike(input({ days }));
    expect(r?.tone).toBe('caution');
    expect(r?.title).toBe('Activity spike yesterday');
    expect(r?.body).toMatch(/gradually/);
  });
  it('stays quiet for normal variation', () => {
    expect(activitySpike(input({ days: lastNDays(8, (i) => ({ activeMinutes: 40 + i })) }))).toBeNull();
  });
});

describe('swelling / ROM / reminder', () => {
  it('flags increased swelling', () => {
    const j = [journal(addDays(TODAY, -3), 3, { swelling: 0 }), journal(addDays(TODAY, -2), 3, { swelling: 1 }), journal(addDays(TODAY, -1), 4, { swelling: 2 })];
    expect(swellingChange(input({ journal: j }))?.tone).toBe('caution');
  });
  it('reports ROM gains', () => {
    const j = [90, 95, 101].map((rom, i) => journal(addDays(TODAY, -10 + i * 4), 3, { romFlexion: rom }));
    expect(romProgress(input({ journal: j }))?.title).toBe('Knee bend improved by 11°');
  });
  it('reminds to journal only when today is missing', () => {
    expect(journalReminder(input())).not.toBeNull();
    expect(journalReminder(input({ journal: [journal(TODAY, 2)] }))).toBeNull();
  });
});

describe('generateInsights', () => {
  it('returns a no-data card when empty', () => {
    expect(generateInsights(input())[0].id).toBe('no-data');
  });
  it('sorts cautions first and never uses directive medical language', () => {
    const days = lastNDays(14, (i) => ({ activeMinutes: i === 1 ? 120 : 40 }));
    const list = generateInsights(input({ days }));
    expect(list[0].id).toBe('spike');
    for (const ins of list) expect(ins.body).not.toMatch(/\byou must\b|\bdiagnos/i);
  });
});
