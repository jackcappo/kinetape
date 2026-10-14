/**
 * Guided-exercise session state machine (pure). Time is passed in explicitly so it can be tested.
 *   ready → work (set 1) → rest → work (set 2) … → done
 */
import type { RepResult, SessionResult, SetResult } from '../types';
import type { ExercisePreset } from './presets';
import type { RepEvent } from './repTracker';

export type SessionPhase = 'ready' | 'work' | 'rest' | 'done';

export interface SessionState {
  phase: SessionPhase;
  setIndex: number;
  sets: SetResult[];
  restEndsAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** last rep feedback for the UI */
  lastRep: RepResult | null;
}

export const initialSession = (): SessionState => ({
  phase: 'ready',
  setIndex: 0,
  sets: [],
  restEndsAt: null,
  startedAt: null,
  endedAt: null,
  lastRep: null,
});

/** A rep is "good" if held ≥ 80 % of the target hold and reached the quality target. */
export function judgeRep(ev: RepEvent, ex: ExercisePreset): RepResult {
  const holdOk = ev.holdMs >= ex.holdS * 1000 * 0.8;
  const qualityOk = ev.peakPermille >= ex.qualityTargetPct * 10;
  return { holdMs: ev.holdMs, peakPermille: ev.peakPermille, good: holdOk && qualityOk };
}

export type SessionAction =
  | { type: 'start'; now: number }
  | { type: 'rep'; ev: RepEvent; now: number }
  | { type: 'tick'; now: number }
  | { type: 'skipRest'; now: number }
  | { type: 'endSet'; now: number }
  | { type: 'finish'; now: number };

export function sessionReducer(ex: ExercisePreset) {
  return (s: SessionState, a: SessionAction): SessionState => {
    switch (a.type) {
      case 'start':
        if (s.phase !== 'ready') return s;
        return { ...s, phase: 'work', setIndex: 0, sets: [{ reps: [] }], startedAt: a.now };
      case 'rep': {
        if (s.phase !== 'work') return s;
        const rep = judgeRep(a.ev, ex);
        const sets = s.sets.map((set, i) => (i === s.setIndex ? { reps: [...set.reps, rep] } : set));
        const next = { ...s, sets, lastRep: rep };
        if (sets[s.setIndex].reps.length >= ex.reps) return completeSet(next, ex, a.now);
        return next;
      }
      case 'endSet':
        return s.phase === 'work' ? completeSet(s, ex, a.now) : s;
      case 'tick':
        if (s.phase === 'rest' && s.restEndsAt !== null && a.now >= s.restEndsAt) return beginNextSet(s);
        return s;
      case 'skipRest':
        return s.phase === 'rest' ? beginNextSet(s) : s;
      case 'finish':
        if (s.phase === 'done') return s;
        return { ...s, phase: 'done', endedAt: a.now, restEndsAt: null };
    }
  };
}

function completeSet(s: SessionState, ex: ExercisePreset, now: number): SessionState {
  if (s.setIndex + 1 >= ex.sets) return { ...s, phase: 'done', endedAt: now, restEndsAt: null };
  return { ...s, phase: 'rest', restEndsAt: now + ex.restS * 1000 };
}

function beginNextSet(s: SessionState): SessionState {
  return { ...s, phase: 'work', setIndex: s.setIndex + 1, sets: [...s.sets, { reps: [] }], restEndsAt: null };
}

export function summarizeSession(
  s: SessionState,
  ex: ExercisePreset,
  meta: { id: string; calibrated: boolean; source: 'device' | 'demo'; calibMaxRaw?: number },
): SessionResult {
  const reps = s.sets.flatMap((x) => x.reps);
  const totalReps = reps.length;
  const goodReps = reps.filter((r) => r.good).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const completedSets = s.sets.filter((x) => x.reps.length >= ex.reps).length;
  return {
    id: meta.id,
    exerciseId: ex.id,
    exerciseName: ex.name,
    startedAt: s.startedAt ?? Date.now(),
    endedAt: s.endedAt ?? Date.now(),
    targetSets: ex.sets,
    targetReps: ex.reps,
    targetHoldS: ex.holdS,
    qualityTargetPct: ex.qualityTargetPct,
    sets: s.sets.filter((x) => x.reps.length > 0),
    totalReps,
    goodReps,
    avgHoldS: Math.round(avg(reps.map((r) => r.holdMs)) / 100) / 10,
    avgPeakPct: Math.round(avg(reps.map((r) => r.peakPermille)) / 10),
    maxPeakPct: Math.round(Math.max(0, ...reps.map((r) => r.peakPermille)) / 10),
    // "completed" = at least 80 % of the prescribed reps were done
    completed: completedSets >= ex.sets || totalReps >= ex.sets * ex.reps * 0.8,
    calibrated: meta.calibrated,
    source: meta.source,
    calibMaxRaw: meta.calibMaxRaw,
  };
}
