/**
 * Deterministic demo dataset: ~6 weeks of an ACL-reconstruction recovery.
 *
 * The *device log* is generated minute by minute from a fixed anchor so that reloading the page
 * later reproduces the same indices (the app's dedupe-by-index stays consistent) and simply
 * continues with newer minutes. The app database is pre-seeded with everything up to the start
 * of the previous boot; the rest (yesterday + today, including unsynced-time records) is pulled
 * through the real protocol on the first Demo-mode connect.
 */
import type { RecordFields } from '../protocol/codec';
import { RECORD_FLAG } from '../protocol/constants';
import type { CalibrationEvent, StoredRecord } from '../device/types';
import type { JournalEntry, SessionResult } from '../types';
import { Rng, hashSeed } from '../lib/random';
import { toDateKey } from '../analytics/time';
import { EXERCISES } from '../exercises/presets';
import { judgeRep } from '../exercises/session';

export const DEMO_DEVICE_ID = 'sim-kinetape-demo';
export const DEMO_DEVICE_NAME = 'KineTape-D3M0';
export const DEMO_DAYS_BEFORE_ANCHOR = 42;
const SPIKE_DAY = 41; // the day before the anchor day
const RECAL_DAYS = [0, 14, 30];
const REST_RAW = 310;

export interface DemoDataset {
  log: RecordFields[];
  /** true epoch (s) for each log index, used to seed already-synced rows */
  trueEpoch: number[];
  currentBoot: { bootId: number; bootStartMs: number };
  splitIndex: number;
  stored: StoredRecord[];
  sessions: SessionResult[];
  journal: JournalEntry[];
  calibrations: CalibrationEvent[];
  surgeryDate: string;
  maxRaw: number;
}

const calibCapacity = (d: number) => (d < 14 ? 0.8 : d < 30 ? 0.95 : 1.1);
const maxRawFor = (d: number) => Math.round(REST_RAW + (2840 * calibCapacity(d)) / 1.1);
const progress = (d: number) => Math.min(1, d / DEMO_DAYS_BEFORE_ANCHOR);
const strength = (d: number) => Math.min(1.05, 0.45 + 0.5 * progress(d) + 0.004 * Math.max(0, d - DEMO_DAYS_BEFORE_ANCHOR));

type Block = { start: number; end: number; kind: 'pt' | 'walk' | 'sit' };

interface DayPlan {
  d: number;
  dayStart: Date;
  bootStartMs: number;
  bootEndMs: number;
  blocks: Block[];
  pt: Block[];
  rng: Rng;
}

function planDay(d: number, day0: Date): DayPlan {
  const rng = new Rng(hashSeed(`kinetape-demo-day-${d}`));
  const dayStart = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + d);
  const at = (min: number) => dayStart.getTime() + min * 60000;
  const p = progress(d);
  const spike = d === SPIKE_DAY;
  const bootStartMs = at(7 * 60 + rng.range(-20, 45)) + rng.int(0, 59) * 1000;
  const bootEndMs = at(22 * 60 + 15 + rng.range(0, 60));
  const blocks: Block[] = [];
  const pt: Block[] = [];
  const ptLen = Math.round(8 + 10 * p);
  const ptDoneP = 0.72 + 0.2 * p;
  const morning = Math.round(9 * 60 + rng.range(-30, 60));
  const evening = Math.round(18 * 60 + rng.range(-30, 90));
  for (const start of spike ? [morning, 13 * 60 + 30, evening] : [morning, evening]) {
    if (spike || rng.chance(ptDoneP)) pt.push({ start, end: start + ptLen, kind: 'pt' });
  }
  if (rng.chance(0.5)) {
    const s = Math.round(13 * 60 + rng.range(0, 60));
    blocks.push({ start: s, end: s + Math.round(rng.range(100, 150)), kind: 'sit' });
  }
  const walks = Math.round((2 + 8 * p) * rng.range(0.7, 1.3) * (spike ? 1.9 : 1));
  for (let i = 0; i < walks; i++) {
    const s = Math.round(rng.range(8 * 60, 21 * 60));
    blocks.push({ start: s, end: s + Math.round(rng.range(3, 10) * (spike ? 1.5 : 1)), kind: 'walk' });
  }
  blocks.push(...pt); // PT last so it wins on overlap
  return { d, dayStart, bootStartMs, bootEndMs, blocks, pt, rng };
}

function minuteKind(plan: DayPlan, mod: number): Block['kind'] | 'default' {
  let k: Block['kind'] | 'default' = 'default';
  for (const b of plan.blocks) if (mod >= b.start && mod < b.end) k = b.kind;
  return k;
}

const clampPm = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));

function minuteValues(kind: Block['kind'] | 'default', d: number, rng: Rng) {
  const p = progress(d);
  const s = strength(d) / calibCapacity(d);
  switch (kind) {
    case 'pt':
      return {
        reps: rng.int(5, 9),
        activeSeconds: Math.round(rng.range(25, 45)),
        peak: clampPm(s * 1000 * rng.range(0.85, 1.0)),
        mean: Math.round(rng.range(160, 300)),
      };
    case 'walk':
      return {
        reps: rng.int(0, 2),
        activeSeconds: Math.round(rng.range(8, 22)),
        peak: clampPm(rng.range(220, 400) * (0.8 + 0.4 * p)),
        mean: Math.round(rng.range(80, 150)),
      };
    case 'sit':
      return { reps: 0, activeSeconds: 0, peak: Math.round(rng.range(15, 70)), mean: Math.round(rng.range(6, 20)) };
    default:
      if (rng.chance(0.7))
        return { reps: 0, activeSeconds: rng.chance(0.2) ? 1 : 0, peak: Math.round(rng.range(20, 90)), mean: Math.round(rng.range(8, 25)) };
      return {
        reps: rng.chance(0.04) ? 1 : 0,
        activeSeconds: Math.round(rng.range(1, 7)),
        peak: Math.round(rng.range(100, 280)),
        mean: Math.round(rng.range(30, 70)),
      };
  }
}

const NOTES = [
  'Felt stiff in the morning, better after exercises.',
  'Iced after PT.',
  'PT visit — progressed to standing exercises.',
  'Slept well.',
  'Knee clicked a bit on stairs, no pain.',
  'Long day at the desk.',
  'Walked to the store without crutches!',
  'A bit sore after yesterday.',
  '',
  '',
  '',
];

export function generateDemo(anchorMs: number, nowMs: number, deviceId = DEMO_DEVICE_ID): DemoDataset {
  const anchor = new Date(anchorMs);
  const day0 = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - DEMO_DAYS_BEFORE_ANCHOR);
  const surgery = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() - 3);
  const todayKey = toDateKey(new Date(nowMs));

  // plan all boots that started before now
  const plans: DayPlan[] = [];
  for (let d = 0; d < 4000; d++) {
    const plan = planDay(d, day0);
    if (plan.bootStartMs > nowMs) break;
    plans.push(plan);
  }

  const log: RecordFields[] = [];
  const trueEpoch: number[] = [];
  const bootFirstIndex: number[] = [];
  const sessions: SessionResult[] = [];
  const journal: JournalEntry[] = [];
  const calibrations: CalibrationEvent[] = [];
  let currentBoot = { bootId: 1, bootStartMs: nowMs };

  plans.forEach((plan, i) => {
    const isCurrent = i === plans.length - 1;
    const bootId = (100 + plan.d) & 0xffff;
    const endMs = isCurrent ? nowMs : plan.bootEndMs;
    const rng = plan.rng;
    const syncMin = isCurrent ? Number.POSITIVE_INFINITY : rng.int(3, 50);
    const bootStartS = Math.floor(plan.bootStartMs / 1000);
    bootFirstIndex.push(log.length);
    if (isCurrent) currentBoot = { bootId, bootStartMs: bootStartS * 1000 };
    const dropout = plan.d === 20 ? { from: 11 * 60, to: 11 * 60 + 15 } : null;
    for (let m = 0; bootStartS * 1000 + (m + 1) * 60000 <= endMs; m++) {
      const epoch = bootStartS + m * 60;
      const dt = new Date(epoch * 1000);
      const mod = dt.getHours() * 60 + dt.getMinutes();
      let v = minuteValues(minuteKind(plan, mod), plan.d, rng);
      let sensorOk = true;
      if (dropout && mod >= dropout.from && mod < dropout.to) {
        v = { reps: 0, activeSeconds: 0, peak: 0, mean: 0 };
        sensorOk = false;
      }
      const timeValid = m >= syncMin;
      log.push({
        t: timeValid ? Math.floor(epoch / 60) * 60 : m * 60,
        bootId,
        flags: (timeValid ? RECORD_FLAG.TIME_VALID : 0) | (sensorOk ? RECORD_FLAG.SENSOR_OK : 0),
        meanActivationPermille: v.mean,
        peakActivationPermille: v.peak,
        reps: v.reps,
        activeSeconds: Math.min(60, v.activeSeconds),
      });
      trueEpoch.push(timeValid ? Math.floor(epoch / 60) * 60 : epoch);
    }

    // calibration events
    if (RECAL_DAYS.includes(plan.d))
      calibrations.push({ deviceId, at: plan.bootStartMs + 10 * 60000, restRaw: REST_RAW, maxRaw: maxRawFor(plan.d), source: 'demo' });

    // guided sessions saved by the app
    const cRng = new Rng(hashSeed(`kinetape-demo-sessions-${plan.d}`));
    plan.pt.forEach((b, bi) => {
      const startMs = plan.dayStart.getTime() + b.start * 60000;
      const ex = EXERCISES[(plan.d * 2 + bi) % EXERCISES.length];
      const durMs = (b.end - b.start) * 60000;
      if (startMs + durMs > nowMs) return;
      const s = strength(plan.d) / calibCapacity(plan.d);
      const sets = [];
      const short = cRng.chance(0.12);
      for (let si = 0; si < ex.sets; si++) {
        const n = short && si === ex.sets - 1 ? Math.max(1, ex.reps - cRng.int(2, 5)) : ex.reps;
        const reps = [];
        for (let r = 0; r < n; r++) {
          const holdMs = Math.round(ex.holdS * 1000 * cRng.range(0.72, 1.2));
          const peakPermille = clampPm(s * 1000 * cRng.range(0.72, 1.0));
          reps.push(judgeRep({ startMs: 0, endMs: holdMs, holdMs, peakPermille }, ex));
        }
        sets.push({ reps });
      }
      const all = sets.flatMap((x) => x.reps);
      const total = all.length;
      sessions.push({
        id: `demo-${plan.d}-${bi}`,
        exerciseId: ex.id,
        exerciseName: ex.name,
        startedAt: startMs,
        endedAt: startMs + durMs,
        targetSets: ex.sets,
        targetReps: ex.reps,
        targetHoldS: ex.holdS,
        qualityTargetPct: ex.qualityTargetPct,
        sets,
        totalReps: total,
        goodReps: all.filter((r) => r.good).length,
        avgHoldS: Math.round(all.reduce((a, r) => a + r.holdMs, 0) / total / 100) / 10,
        avgPeakPct: Math.round(all.reduce((a, r) => a + r.peakPermille, 0) / total / 10),
        maxPeakPct: Math.round(Math.max(...all.map((r) => r.peakPermille)) / 10),
        completed: total >= ex.sets * ex.reps * 0.8,
        calibrated: true,
        source: 'demo',
        calibMaxRaw: maxRawFor(plan.d),
      });
    });

    // journal (not for today — leave that for the user)
    const dateKey = toDateKey(plan.dayStart);
    const jRng = new Rng(hashSeed(`kinetape-demo-journal-${plan.d}`));
    const isYesterday = i === plans.length - 2 || (isCurrent && dateKey !== todayKey);
    if (dateKey < todayKey && (isYesterday || jRng.chance(0.85))) {
      const p = progress(plan.d);
      const afterSpike = plan.d === SPIKE_DAY + 1;
      const pain = Math.max(0, Math.min(10, Math.round(6.2 - 4.5 * p + jRng.normal(0, 0.7) + (plan.d === SPIKE_DAY ? 1.5 : 0) + (afterSpike ? 2 : 0))));
      const swelling = plan.d === SPIKE_DAY ? 2 : p < 0.25 ? (jRng.chance(0.7) ? 2 : 1) : p < 0.6 ? 1 : jRng.chance(0.3) ? 1 : 0;
      journal.push({
        date: dateKey,
        pain,
        swelling,
        romFlexion: Math.round(Math.min(135, 75 + 58 * p + jRng.normal(0, 3))),
        romExtension: Math.min(0, Math.round(-6 + 6 * p + jRng.normal(0, 1))),
        notes: plan.d === SPIKE_DAY ? 'Long walk with friends + extra session. Knee tired by evening.' : jRng.pick(NOTES),
        updatedAt: plan.bootEndMs,
      });
    }
  });

  const splitIndex = plans.length >= 2 ? bootFirstIndex[plans.length - 2] : 0;
  const stored: StoredRecord[] = [];
  for (let i = 0; i < splitIndex; i++) {
    const r = log[i];
    const valid = (r.flags & RECORD_FLAG.TIME_VALID) !== 0;
    stored.push({
      deviceId,
      generation: 0,
      index: i,
      t: r.t,
      bootId: r.bootId,
      flags: r.flags,
      sensorOk: (r.flags & RECORD_FLAG.SENSOR_OK) !== 0,
      mean: r.meanActivationPermille,
      peak: r.peakActivationPermille,
      reps: r.reps,
      activeSeconds: r.activeSeconds,
      epoch: trueEpoch[i],
      timeSource: valid ? 'device' : 'converted',
    });
  }
  const lastDay = plans.length ? plans[plans.length - 1].d : 0;
  return {
    log,
    trueEpoch,
    currentBoot,
    splitIndex,
    stored,
    sessions,
    journal,
    calibrations,
    surgeryDate: toDateKey(surgery),
    maxRaw: maxRawFor(lastDay),
  };
}

export const DEMO_REST_RAW = REST_RAW;
