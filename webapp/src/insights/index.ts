/**
 * Insights engine — pure functions that turn summaries, sessions and journal entries into
 * plain-language, cautiously phrased observations. Nothing here is medical advice; wording
 * always defers to the user's clinician.
 */
import type { DaySummary } from '../analytics/summary';
import { currentStreak } from '../analytics/summary';
import { addDays, daysBetween, formatDuration, formatMinuteOfDay } from '../analytics/time';
import type { Goals, JournalEntry, SessionResult } from '../types';
import { mean, pctChange, pearson, slope } from './stats';

export type InsightTone = 'positive' | 'info' | 'caution';

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  body: string;
  /** higher = more important */
  priority: number;
}

export interface InsightInput {
  today: string;
  /** Day summaries (any order); days without data are simply absent. */
  days: DaySummary[];
  sessions: SessionResult[];
  journal: JournalEntry[];
  goals: Goals;
  /** Date keys on which the sensor was (re)calibrated. */
  calibrationDates: string[];
  timeFormat?: '12h' | '24h';
}

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const dateOfMs = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function window(days: Map<string, DaySummary>, today: string, fromOffset: number, toOffset: number): DaySummary[] {
  const out: DaySummary[] = [];
  for (let o = fromOffset; o <= toOffset; o++) {
    const d = days.get(addDays(today, o));
    if (d && d.wornMinutes > 0) out.push(d);
  }
  return out;
}

const MIN_DAYS_PER_WEEK = 4;

export function weekOverWeekActivity(input: InsightInput): Insight | null {
  const byDate = new Map(input.days.map((d) => [d.date, d]));
  const last = window(byDate, input.today, -7, -1);
  const prev = window(byDate, input.today, -14, -8);
  if (last.length < MIN_DAYS_PER_WEEK || prev.length < MIN_DAYS_PER_WEEK) return null;
  const a = mean(last.map((d) => d.activeMinutes));
  const b = mean(prev.map((d) => d.activeMinutes));
  const ch = pctChange(a, b);
  if (!Number.isFinite(ch)) return null;
  if (ch >= 0.1)
    return {
      id: 'wow-activity',
      tone: 'positive',
      title: `Active minutes up ${pct(ch)} this week`,
      body: `You averaged ${Math.round(a)} active minutes a day over the last 7 days, compared with ${Math.round(b)} the week before. Steady, gradual increases are generally what rehab plans aim for.`,
      priority: 60,
    };
  if (ch <= -0.15)
    return {
      id: 'wow-activity',
      tone: 'info',
      title: `Active minutes down ${pct(ch)} this week`,
      body: `You averaged ${Math.round(a)} active minutes a day, compared with ${Math.round(b)} the week before. Some variation is normal; if pain, swelling or fatigue is holding you back, it may be worth mentioning to your physical therapist.`,
      priority: 55,
    };
  return {
    id: 'wow-activity',
    tone: 'info',
    title: 'Activity steady week over week',
    body: `About ${Math.round(a)} active minutes a day over the last 7 days (previous week: ${Math.round(b)}).`,
    priority: 20,
  };
}

export function weekOverWeekPeak(input: InsightInput): Insight | null {
  const byDate = new Map(input.days.map((d) => [d.date, d]));
  const last = window(byDate, input.today, -7, -1);
  const prev = window(byDate, input.today, -14, -8);
  if (last.length < MIN_DAYS_PER_WEEK || prev.length < MIN_DAYS_PER_WEEK) return null;
  const a = mean(last.map((d) => d.peakPermille));
  const b = mean(prev.map((d) => d.peakPermille));
  const ch = pctChange(a, b);
  if (!Number.isFinite(ch) || Math.abs(ch) < 0.05) return null;
  const recal = input.calibrationDates.some((k) => k >= addDays(input.today, -14) && k <= input.today);
  const caveat = recal
    ? ' Note: the sensor was recalibrated during this period, so peak values before and after aren’t directly comparable.'
    : '';
  const up = ch > 0;
  return {
    id: 'wow-peak',
    tone: recal ? 'info' : up ? 'positive' : 'info',
    title: `Peak activation ${up ? 'up' : 'down'} ${pct(ch)} week over week`,
    body: `Your average daily peak was ${Math.round(a / 10)}% of calibrated max (previous week ${Math.round(b / 10)}%). Peak activation is a rough strength proxy, not a clinical measurement.${caveat}`,
    priority: up ? 50 : 40,
  };
}

export function sessionAdherence(input: InsightInput): Insight | null {
  const perDay = input.goals.sessions;
  if (!perDay) return null;
  const from = addDays(input.today, -7);
  const to = addDays(input.today, -1);
  const done = input.sessions.filter((s) => {
    const k = dateOfMs(s.startedAt);
    return s.completed && k >= from && k <= to;
  }).length;
  const anyHistory = input.sessions.some((s) => dateOfMs(s.startedAt) < input.today);
  if (!anyHistory) return null;
  const planned = perDay * 7;
  const ratio = Math.min(1, done / planned);
  if (ratio >= 0.9)
    return {
      id: 'adherence',
      tone: 'positive',
      title: `${done} of ${planned} planned sessions done this week`,
      body: 'Great consistency with your exercise plan over the last 7 days.',
      priority: 58,
    };
  if (ratio >= 0.6)
    return {
      id: 'adherence',
      tone: 'info',
      title: `${done} of ${planned} planned sessions this week`,
      body: `That’s ${pct(ratio)} of your plan. Short sessions still count — a reminder at a regular time of day can help.`,
      priority: 45,
    };
  return {
    id: 'adherence',
    tone: 'caution',
    title: `${done} of ${planned} planned sessions this week`,
    body: `You completed ${pct(ratio)} of the sessions in your plan. If the program feels too hard, painful or hard to fit in, consider talking it through with your physical therapist.`,
    priority: 62,
  };
}

export function sedentaryStretch(input: InsightInput): Insight | null {
  const today = input.days.find((d) => d.date === input.today);
  if (!today || today.longestInactiveMin < 90 || today.longestInactiveStartMin === null) return null;
  return {
    id: 'sedentary',
    tone: 'info',
    title: `Long still stretch today: ${formatDuration(today.longestInactiveMin)}`,
    body: `Starting around ${formatMinuteOfDay(today.longestInactiveStartMin, input.timeFormat)}, the sensor saw very little muscle activity during waking hours. If your PT has recommended regular movement breaks or quad sets, this might be a good moment for one.`,
    priority: 48,
  };
}

export function painTrend(input: InsightInput): Insight | null {
  const from = addDays(input.today, -14);
  const entries = input.journal.filter((j) => j.date >= from && j.date <= input.today).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (entries.length < 5) return null;
  const xs = entries.map((e) => daysBetween(from, e.date));
  const ys = entries.map((e) => e.pain);
  const perWeek = slope(xs, ys) * 7;
  if (!Number.isFinite(perWeek)) return null;
  if (perWeek <= -0.5)
    return {
      id: 'pain-trend',
      tone: 'positive',
      title: 'Pain scores trending down',
      body: `Over the last two weeks your logged pain has dropped by about ${Math.abs(perWeek).toFixed(1)} points per week.`,
      priority: 52,
    };
  if (perWeek >= 0.5)
    return {
      id: 'pain-trend',
      tone: 'caution',
      title: 'Pain scores trending up',
      body: `Your logged pain has risen by about ${perWeek.toFixed(1)} points per week over the last two weeks. If this continues, or comes with more swelling, warmth or reduced motion, please contact your physical therapist or surgeon.`,
      priority: 80,
    };
  return null;
}

export function painActivityCorrelation(input: InsightInput): Insight | null {
  const from = addDays(input.today, -28);
  const pain = new Map(input.journal.map((j) => [j.date, j.pain]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of input.days) {
    if (d.date < from || d.date >= input.today) continue;
    const next = pain.get(addDays(d.date, 1));
    if (next === undefined) continue;
    xs.push(d.activeMinutes);
    ys.push(next);
  }
  if (xs.length < 8) return null;
  const r = pearson(xs, ys);
  if (!Number.isFinite(r) || Math.abs(r) < 0.4) return null;
  const n = xs.length;
  if (r > 0)
    return {
      id: 'pain-activity',
      tone: 'info',
      title: 'More activity tended to be followed by more pain',
      body: `Across ${n} days, higher-activity days were often followed by higher pain scores the next day (correlation ${r.toFixed(2)}). This is a pattern, not proof of cause — but it may help you and your PT find a comfortable pace.`,
      priority: 50,
    };
  return {
    id: 'pain-activity',
    tone: 'positive',
    title: 'Active days weren’t followed by more pain',
    body: `Across ${n} days, more active days were generally followed by lower pain scores (correlation ${r.toFixed(2)}). A pattern, not proof of cause.`,
    priority: 35,
  };
}

export function goalStreaks(input: InsightInput): Insight | null {
  const metActive = new Map(input.days.map((d) => [d.date, d.activeMinutes >= input.goals.activeMinutes]));
  const s = currentStreak(metActive, input.today, addDays);
  if (s >= 2)
    return {
      id: 'streak',
      tone: 'positive',
      title: `${s} days in a row at your active-minutes goal`,
      body: `You’ve reached ${input.goals.activeMinutes}+ active minutes on each of the last ${s} days. Nice consistency!`,
      priority: 57,
    };
  const metReps = new Map(input.days.map((d) => [d.date, d.reps >= input.goals.reps]));
  const r = currentStreak(metReps, input.today, addDays);
  if (r >= 2)
    return {
      id: 'streak',
      tone: 'positive',
      title: `${r} days in a row at your rep goal`,
      body: `You’ve completed ${input.goals.reps}+ reps on each of the last ${r} days.`,
      priority: 54,
    };
  return null;
}

/** Sudden spike in load vs. the previous week's baseline (yesterday or today). */
export function activitySpike(input: InsightInput): Insight | null {
  const byDate = new Map(input.days.map((d) => [d.date, d]));
  for (const offset of [0, -1]) {
    const k = addDays(input.today, offset);
    const d = byDate.get(k);
    if (!d) continue;
    const base = window(byDate, k, -7, -1);
    if (base.length < MIN_DAYS_PER_WEEK) continue;
    const bAct = mean(base.map((x) => x.activeMinutes));
    const bReps = mean(base.map((x) => x.reps));
    const actSpike = d.activeMinutes > 1.5 * bAct && d.activeMinutes - bAct >= 20;
    const repSpike = d.reps > 1.6 * bReps && d.reps - bReps >= 80;
    if (actSpike || repSpike) {
      const what = actSpike
        ? `${d.activeMinutes} active minutes (your recent average is ${Math.round(bAct)})`
        : `${d.reps} reps (your recent average is ${Math.round(bReps)})`;
      return {
        id: 'spike',
        tone: 'caution',
        title: `Activity spike ${offset === 0 ? 'today' : 'yesterday'}`,
        body: `You logged ${what}. Sudden jumps in load can increase the risk of overdoing it during recovery. Consider ramping up gradually and keep an eye on pain and swelling over the next day — check in with your PT if they increase.`,
        priority: 75,
      };
    }
  }
  return null;
}

export function swellingChange(input: InsightInput): Insight | null {
  const sorted = [...input.journal].filter((j) => j.date <= input.today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = sorted[sorted.length - 1];
  if (!latest || daysBetween(latest.date, input.today) > 1) return null;
  const prior = sorted.filter((j) => j.date < latest.date && j.date >= addDays(latest.date, -4));
  if (prior.length < 2) return null;
  const avg = mean(prior.map((j) => j.swelling));
  if (latest.swelling >= 2 && latest.swelling - avg >= 1)
    return {
      id: 'swelling',
      tone: 'caution',
      title: 'Swelling higher than recent days',
      body: 'Your latest entry shows more swelling than the previous few days. Rest, elevation and ice are commonly advised, but follow your care team’s instructions — and contact them promptly if it comes with significant pain, warmth, redness or fever.',
      priority: 78,
    };
  return null;
}

export function romProgress(input: InsightInput): Insight | null {
  const withRom = input.journal
    .filter((j) => j.romFlexion !== undefined && j.date <= input.today && j.date >= addDays(input.today, -14))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (withRom.length < 3) return null;
  const gain = withRom[withRom.length - 1].romFlexion! - withRom[0].romFlexion!;
  if (gain >= 5)
    return {
      id: 'rom',
      tone: 'positive',
      title: `Knee bend improved by ${Math.round(gain)}°`,
      body: `Your self-reported flexion went from ${withRom[0].romFlexion}° to ${withRom[withRom.length - 1].romFlexion}° over the last two weeks.`,
      priority: 46,
    };
  return null;
}

export function journalReminder(input: InsightInput): Insight | null {
  if (input.journal.some((j) => j.date === input.today)) return null;
  return {
    id: 'journal',
    tone: 'info',
    title: 'Log today’s pain and range of motion',
    body: 'A quick daily entry helps you and your PT connect how you feel with what the tape measures.',
    priority: 10,
  };
}

const RULES = [
  activitySpike,
  swellingChange,
  painTrend,
  sessionAdherence,
  weekOverWeekActivity,
  weekOverWeekPeak,
  goalStreaks,
  painActivityCorrelation,
  sedentaryStretch,
  romProgress,
  journalReminder,
];

export function generateInsights(input: InsightInput): Insight[] {
  if (!input.days.length && !input.journal.length) {
    return [
      {
        id: 'no-data',
        tone: 'info',
        title: 'No data yet',
        body: 'Connect your KineTape (or try Demo mode) and wear it during the day — insights appear once there’s about a week of data.',
        priority: 1,
      },
    ];
  }
  return RULES.map((r) => r(input))
    .filter((x): x is Insight => x !== null)
    .sort((a, b) => b.priority - a.priority);
}
