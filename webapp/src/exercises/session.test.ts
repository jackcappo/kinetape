import { describe, expect, it } from 'vitest';
import { exerciseById } from './presets';
import { RepTracker, type RepEvent } from './repTracker';
import { initialSession, judgeRep, sessionReducer, summarizeSession } from './session';

const ex = { ...exerciseById('quad_sets')!, sets: 2, reps: 3, holdS: 2, restS: 10 };

describe('RepTracker', () => {
  it('detects contractions from the LIVE contracting flag, measures hold and peak', () => {
    const t = new RepTracker();
    const evs: RepEvent[] = [];
    let ms = 1000;
    const feed = (contracting: boolean, act: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const e = t.push({ uptimeMs: ms, activationPermille: act + i, contracting });
        if (e) evs.push(e);
        ms += 50;
      }
    };
    feed(false, 10, 5);
    feed(true, 600, 40); // 2 s
    feed(false, 10, 5);
    feed(true, 500, 3); // 150 ms → too short
    feed(false, 10, 5);
    expect(evs).toHaveLength(1);
    expect(evs[0].holdMs).toBe(2000);
    expect(evs[0].peakPermille).toBe(639);
  });
  it('resets when uptime goes backwards (device reboot)', () => {
    const t = new RepTracker();
    t.push({ uptimeMs: 5000, activationPermille: 500, contracting: true });
    expect(t.push({ uptimeMs: 100, activationPermille: 0, contracting: false })).toBeNull();
  });
});

describe('session state machine', () => {
  const reduce = sessionReducer(ex);
  const rep = (holdMs: number, peak: number) => ({ startMs: 0, endMs: holdMs, holdMs, peakPermille: peak });

  it('judges reps by hold (≥80%) and quality target', () => {
    expect(judgeRep(rep(1700, 600), ex).good).toBe(true);
    expect(judgeRep(rep(1500, 600), ex).good).toBe(false);
    expect(judgeRep(rep(2000, 400), ex).good).toBe(false);
  });

  it('runs sets, rest timer and completes', () => {
    let s = initialSession();
    s = reduce(s, { type: 'rep', ev: rep(2000, 600), now: 0 }); // ignored before start
    expect(s.sets).toHaveLength(0);
    s = reduce(s, { type: 'start', now: 1000 });
    expect(s.phase).toBe('work');
    for (let i = 0; i < 3; i++) s = reduce(s, { type: 'rep', ev: rep(2000, 600 + i), now: 2000 + i });
    expect(s.phase).toBe('rest');
    expect(s.restEndsAt).toBe(2002 + 10000);
    s = reduce(s, { type: 'tick', now: 5000 });
    expect(s.phase).toBe('rest');
    s = reduce(s, { type: 'tick', now: 12002 });
    expect(s).toMatchObject({ phase: 'work', setIndex: 1 });
    s = reduce(s, { type: 'rep', ev: rep(1000, 300), now: 13000 });
    s = reduce(s, { type: 'rep', ev: rep(2100, 700), now: 14000 });
    s = reduce(s, { type: 'rep', ev: rep(2100, 800), now: 15000 });
    expect(s.phase).toBe('done');
    const r = summarizeSession(s, ex, { id: 'x', calibrated: true, source: 'device' });
    expect(r).toMatchObject({ totalReps: 6, goodReps: 5, maxPeakPct: 80, completed: true, startedAt: 1000, endedAt: 15000 });
    expect(r.sets).toHaveLength(2);
  });

  it('can skip rest and finish early (incomplete)', () => {
    let s = reduce(initialSession(), { type: 'start', now: 0 });
    s = reduce(s, { type: 'rep', ev: rep(2000, 600), now: 1 });
    s = reduce(s, { type: 'endSet', now: 2 });
    expect(s.phase).toBe('rest');
    s = reduce(s, { type: 'skipRest', now: 3 });
    expect(s.phase).toBe('work');
    s = reduce(s, { type: 'finish', now: 4 });
    expect(s.phase).toBe('done');
    expect(summarizeSession(s, ex, { id: 'y', calibrated: false, source: 'device' }).completed).toBe(false);
  });
});
