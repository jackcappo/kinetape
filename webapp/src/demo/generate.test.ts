import { describe, expect, it } from 'vitest';
import { generateDemo } from './generate';
import { summarizeDays } from '../analytics/summary';
import { DeviceClient } from '../device/DeviceClient';
import { SimulatedTransport } from '../device/SimulatedTransport';
import { MemorySyncStore } from '../device/types';

const WIN = { wakeStartMin: 7 * 60, wakeEndMin: 22 * 60 };

describe('demo dataset', () => {
  const anchor = new Date(2026, 4, 20, 14, 30).getTime();
  const ds = generateDemo(anchor, anchor);

  it('is deterministic and extends consistently over time', () => {
    const later = generateDemo(anchor, anchor + 3 * 3600 * 1000);
    expect(later.log.length).toBeGreaterThan(ds.log.length);
    // records before the old "current boot" are identical
    expect(later.log.slice(0, ds.splitIndex)).toEqual(ds.log.slice(0, ds.splitIndex));
  });

  it('has realistic daily numbers with progression', () => {
    const days = summarizeDays(ds.stored, WIN);
    expect(days.length).toBeGreaterThanOrEqual(38);
    const first = days.slice(0, 7);
    const last = days.slice(-7);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const a0 = avg(first.map((d) => d.activeMinutes));
    const a1 = avg(last.map((d) => d.activeMinutes));
    expect(a1).toBeGreaterThan(a0);
    expect(a0).toBeGreaterThan(5);
    expect(a1).toBeLessThan(200);
    expect(ds.sessions.length).toBeGreaterThan(50);
    expect(ds.journal.length).toBeGreaterThan(30);
    expect(ds.calibrations).toHaveLength(3);
  });

  it('syncs the not-yet-synced remainder through the real protocol path', async () => {
    const store = new MemorySyncStore();
    await store.upsertRecords(ds.stored);
    await store.setCursor({ deviceId: 'sim-kinetape-demo', generation: 0, cursor: ds.splitIndex });
    const now = () => anchor;
    const t = new SimulatedTransport({
      realtime: false,
      now,
      connectDelayMs: 1,
      writeLatencyMs: 1,
      historyPacingMs: 0,
      bootId: ds.currentBoot.bootId,
      uptimeS: Math.floor((anchor - ds.currentBoot.bootStartMs) / 1000),
      restRaw: 310,
      maxRaw: ds.maxRaw,
      calibrated: true,
      history: { firstIndex: 0, records: ds.log },
    });
    const client = new DeviceClient(t, store, { now, tzOffsetMin: () => 0 });
    await client.connect();
    expect(client.lastSync?.fromIndex).toBe(ds.splitIndex);
    expect(client.lastSync?.nextIndex).toBe(ds.log.length);
    // every newly synced record of the current boot is converted, older-boot unsynced ones are estimated
    const rows = store.all().filter((r) => r.index >= ds.splitIndex);
    expect(rows.filter((r) => r.timeSource === 'unknown')).toHaveLength(0);
    // conversion reproduces the true time within a second
    for (const r of rows.filter((x) => x.timeSource === 'converted')) expect(Math.abs(r.epoch! - ds.trueEpoch[r.index])).toBeLessThanOrEqual(1);
    for (const r of rows.filter((x) => x.timeSource === 'estimated')) expect(Math.abs(r.epoch! - ds.trueEpoch[r.index])).toBeLessThanOrEqual(60);
    t.dispose();
  });
});
