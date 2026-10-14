import { describe, expect, it } from 'vitest';
import { DeviceClient, SyncInterruptedError, resolveRecordTimes } from './DeviceClient';
import { SimulatedTransport, type SimulatedTransportOptions } from './SimulatedTransport';
import { MemorySyncStore } from './types';
import { decodeLive, decodeStatus, type RecordFields } from '../protocol/codec';
import { RECORD_FLAG, RESULT } from '../protocol/constants';

const E0 = 1_760_000_000; // epoch seconds

function validRecords(n: number, bootId = 5, startEpoch = E0 - 86400): RecordFields[] {
  return Array.from({ length: n }, (_, i) => ({
    t: startEpoch + i * 60,
    bootId,
    flags: RECORD_FLAG.TIME_VALID | RECORD_FLAG.SENSOR_OK,
    meanActivationPermille: (i * 7) % 300,
    peakActivationPermille: (i * 13) % 900,
    reps: i % 4,
    activeSeconds: i % 30,
  }));
}

function makeSim(opts: SimulatedTransportOptions = {}) {
  return new SimulatedTransport({
    realtime: false,
    connectDelayMs: 1,
    writeLatencyMs: 1,
    historyPacingMs: 0,
    calibRestMs: 20,
    calibMaxMs: 30,
    reconnectDelayMs: -1,
    ...opts,
  });
}

function makeClient(t: SimulatedTransport, store = new MemorySyncStore(), now?: () => number) {
  const client = new DeviceClient(t, store, {
    now,
    tzOffsetMin: () => -240,
    commandTimeoutMs: 500,
    historyIdleTimeoutMs: 500,
  });
  return { client, store };
}

describe('DeviceClient session + sync against SimulatedTransport', () => {
  it('runs the typical session: STATUS, SET_TIME with tz, full sync, cursor persisted', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: validRecords(253) } });
    const { client, store } = makeClient(t);
    await client.connect();
    expect(client.phase).toBe('ready');
    expect(t.sim.timeValid).toBe(true);
    expect(t.sim.tzOffsetMin).toBe(-240);
    expect(Math.abs(t.sim.epochNow() - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    expect(store.all()).toHaveLength(253);
    expect(store.all().every((r) => r.timeSource === 'device' && r.epoch === r.t)).toBe(true);
    const cur = await store.getCursor(t.deviceId);
    expect(cur).toMatchObject({ generation: 0, cursor: 253 });
    expect(client.lastSync).toMatchObject({ fromIndex: 0, nextIndex: 253, received: 253, added: 253, complete: true, resynced: false });
    t.dispose();
  });

  it('deduplicates by (deviceId, index) and only fetches new records on the next sync', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: validRecords(40) } });
    const { client, store } = makeClient(t);
    await client.connect();
    const again = await client.sync();
    expect(again).toMatchObject({ fromIndex: 40, received: 0, added: 0, nextIndex: 40 });
    validRecords(5, 5, E0).forEach((r) => t.sim.appendRecord(r));
    await client.readStatus();
    const third = await client.sync();
    expect(third).toMatchObject({ fromIndex: 40, received: 5, added: 5, nextIndex: 45 });
    expect(store.all()).toHaveLength(45);
    // Re-inserting the same rows never duplicates
    expect(await store.upsertRecords(store.all())).toBe(0);
    t.dispose();
  });

  it('resumes from the persisted cursor after a link drop mid-transfer', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: validRecords(300) } });
    t.sim.dropAfterPackets = 5; // 5 packets × 10 records, then the link drops
    const { client, store } = makeClient(t);
    const err = await client.connect().catch((e) => e);
    expect(err).toBeInstanceOf(SyncInterruptedError);
    expect((err as SyncInterruptedError).partial.nextIndex).toBe(50);
    expect((await store.getCursor(t.deviceId))?.cursor).toBe(50);
    expect(store.all()).toHaveLength(50);
    expect(client.phase).toBe('disconnected');

    await client.connect();
    expect(client.lastSync).toMatchObject({ fromIndex: 50, received: 250, added: 250, nextIndex: 300, complete: true });
    expect(store.all()).toHaveLength(300);
    expect(new Set(store.all().map((r) => r.index)).size).toBe(300);
    t.dispose();
  });

  it('auto-reconnects and re-runs the session after an unexpected drop', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: validRecords(120) }, reconnectDelayMs: 10 });
    t.sim.dropAfterPackets = 3;
    const { client, store } = makeClient(t);
    const done = new Promise<void>((resolve) => {
      client.events.on('sync', (r) => {
        if (r.complete && r.nextIndex === 120) resolve();
      });
    });
    await client.connect().catch(() => undefined);
    await done;
    expect(store.all()).toHaveLength(120);
    expect((await store.getCursor(t.deviceId))?.cursor).toBe(120);
    t.dispose();
  });

  it('resyncs from 0 into a new generation when the device log was cleared (next_index < cursor)', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: validRecords(120) } });
    const { client, store } = makeClient(t);
    await client.connect();
    expect((await store.getCursor(t.deviceId))?.cursor).toBe(120);

    // Device is wiped / reflashed out-of-band, then records 30 new minutes.
    t.sim.clearLog();
    validRecords(30, 6, E0).forEach((r) => t.sim.appendRecord(r));
    await client.readStatus();
    const res = await client.sync();
    expect(res).toMatchObject({ resynced: true, generation: 1, fromIndex: 0, nextIndex: 30, added: 30 });
    const cur = await store.getCursor(t.deviceId);
    expect(cur).toMatchObject({ generation: 1, cursor: 30 });
    // Old generation kept, new generation stored separately (index 0..29 reused without collisions)
    expect(store.all().filter((r) => r.generation === 0)).toHaveLength(120);
    expect(store.all().filter((r) => r.generation === 1)).toHaveLength(30);
    t.dispose();
  });

  it('CLEAR_HISTORY from the app starts a new generation', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: validRecords(20) } });
    const { client, store } = makeClient(t);
    await client.connect();
    expect(await client.clearHistory()).toBe(RESULT.OK);
    expect(t.sim.nextIndex).toBe(0);
    expect(await store.getCursor(t.deviceId)).toMatchObject({ generation: 1, cursor: 0 });
    const r = await client.sync();
    expect(r).toMatchObject({ resynced: false, received: 0, nextIndex: 0 });
    t.dispose();
  });

  it('reports records lost to ring overwrite and syncs what is left', async () => {
    const t = makeSim({ capacity: 100, history: { firstIndex: 0, records: validRecords(250) } });
    const { client, store } = makeClient(t);
    await client.connect();
    expect(t.sim.oldestIndex).toBe(150);
    expect(client.lastSync).toMatchObject({ fromIndex: 150, lostToRing: 150, received: 100, nextIndex: 250 });
    expect(store.all()).toHaveLength(100);
    t.dispose();
  });

  it('converts unsynced current-boot records with epoch_now − uptime_s + t, estimates older boots', async () => {
    const nowMs = E0 * 1000;
    const now = () => nowMs;
    const uptimeS = 7200;
    const recs: RecordFields[] = [];
    const base = { meanActivationPermille: 10, peakActivationPermille: 20, reps: 0, activeSeconds: 0 };
    // boot 5: unsynced only (never had time) → unknown
    for (let i = 0; i < 5; i++) recs.push({ ...base, t: i * 60, bootId: 5, flags: RECORD_FLAG.SENSOR_OK });
    // boot 6: 10 unsynced then 10 time-valid → estimated from the first valid one
    for (let i = 0; i < 10; i++) recs.push({ ...base, t: i * 60, bootId: 6, flags: RECORD_FLAG.SENSOR_OK });
    const firstValid = E0 - 86400;
    for (let i = 0; i < 10; i++)
      recs.push({ ...base, t: firstValid + i * 60, bootId: 6, flags: RECORD_FLAG.SENSOR_OK | RECORD_FLAG.TIME_VALID });
    // boot 7 (current): 100 unsynced minutes since boot
    for (let i = 0; i < 100; i++) recs.push({ ...base, t: i * 60, bootId: 7, flags: RECORD_FLAG.SENSOR_OK });

    const t = makeSim({ bootId: 7, uptimeS, now, history: { firstIndex: 0, records: recs } });
    const { client, store } = makeClient(t, new MemorySyncStore(), now);
    await client.connect();
    const rows = store.all();
    expect(rows).toHaveLength(125);
    const byIdx = new Map(rows.map((r) => [r.index, r]));
    for (let i = 0; i < 5; i++) expect(byIdx.get(i)).toMatchObject({ timeSource: 'unknown', epoch: undefined });
    for (let i = 0; i < 10; i++)
      expect(byIdx.get(5 + i)).toMatchObject({ timeSource: 'estimated', epoch: firstValid - (10 - i) * 60 });
    expect(byIdx.get(15)).toMatchObject({ timeSource: 'device', epoch: firstValid });
    for (let i = 0; i < 100; i++)
      expect(byIdx.get(25 + i)).toMatchObject({ timeSource: 'converted', epoch: E0 - uptimeS + i * 60 });
    expect(client.lastSync?.timeUnknown).toBe(5);
    t.dispose();
  });

  it('resolveRecordTimes does not estimate across index gaps', () => {
    const mk = (t: number, bootId: number, valid: boolean) => ({
      t,
      bootId,
      flags: valid ? 3 : 2,
      timeValid: valid,
      sensorOk: true,
      meanActivationPermille: 0,
      peakActivationPermille: 0,
      reps: 0,
      activeSeconds: 0,
    });
    const res = resolveRecordTimes(
      [
        { index: 1, rec: mk(0, 3, false) },
        { index: 5, rec: mk(E0, 3, true) },
      ],
      null,
    );
    expect(res.get(1)?.timeSource).toBe('unknown');
    expect(res.get(5)?.timeSource).toBe('device');
  });

  it('runs async calibration and reports calib results incl. failure (4)', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: [] } });
    const { client, store } = makeClient(t);
    await client.connect();
    const states: number[] = [];
    client.events.on('status', (s) => states.push(s.calibState));
    const rest = await client.calibrate('rest');
    expect(rest.result).toBe(RESULT.OK);
    expect(states).toContain(1);
    const max = await client.calibrate('max');
    expect(max.result).toBe(RESULT.OK);
    expect(states).toContain(2);
    expect(max.status.calibrated).toBe(true);
    expect(max.status.maxRaw).toBeGreaterThan(max.status.restRaw + 100);
    expect(store.calibrations.length).toBeGreaterThanOrEqual(1);

    t.sim.failNextMaxCalibration = true;
    const fail = await client.calibrate('max');
    expect(fail.result).toBe(RESULT.FAILED);
    expect(fail.resultName).toBe('failed');
    t.dispose();
  });

  it('handles END status=1 (MTU too small) gracefully without moving the cursor', async () => {
    const t = makeSim({ history: { firstIndex: 0, records: validRecords(30) } });
    t.sim.mtu = 23; // (23-3-8)/16 = 0 records per packet
    const { client, store } = makeClient(t);
    await client.connect();
    expect(client.phase).toBe('ready');
    expect(client.lastSync).toMatchObject({ complete: false, received: 0, nextIndex: 0 });
    expect(client.lastSync?.error).toMatch(/END status 1/);
    expect((await store.getCursor(t.deviceId))?.cursor ?? 0).toBe(0);
    t.sim.mtu = 185;
    const ok = await client.sync();
    expect(ok).toMatchObject({ complete: true, nextIndex: 30 });
    t.dispose();
  });

  it('simulator mirrors firmware arg checks: SET_TIME epoch 0 / |tz|>840, exact lengths, unknown opcode', async () => {
    const t = makeSim();
    const { client } = makeClient(t);
    await client.connect();
    const send = async (hex: string) => {
      const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
      await t.writeControl(bytes);
      return decodeStatus(t.sim.statusBytes());
    };
    expect((await send('0100000000' + '0000')).lastResult).toBe(RESULT.BAD_ARGS); // epoch 0
    expect((await send('010078e768' + '4c04')).lastResult).toBe(RESULT.BAD_ARGS); // tz +1100
    expect((await send('0623ff')).lastResult).toBe(RESULT.BAD_ARGS); // wrong length
    expect((await send('09'))).toMatchObject({ lastCmd: 9, lastResult: RESULT.UNKNOWN_OPCODE });
    t.dispose();
  });

  it('SET_THRESHOLD and IDENTIFY are acknowledged via STATUS', async () => {
    const t = makeSim();
    const { client } = makeClient(t);
    await client.connect();
    let blinked = false;
    t.onIdentify(() => (blinked = true));
    expect(await client.setThreshold(35)).toBe(RESULT.OK);
    expect(t.sim.thresholdPct).toBe(35);
    expect(client.status?.thresholdPct).toBe(35);
    expect(await client.identify()).toBe(RESULT.OK);
    expect(blinked).toBe(true);
    expect(() => client.setThreshold(2)).toThrow(RangeError);
    t.dispose();
  });

  it('simulator engine emits decodable LIVE packets and counts reps with hysteresis', async () => {
    const t = makeSim();
    const { client } = makeClient(t);
    await client.connect();
    const live: ReturnType<typeof decodeLive>[] = [];
    client.events.on('live', (p) => live.push(p));
    // 3 contractions: 1.5 s strong, 1.5 s relaxed
    for (let rep = 0; rep < 3; rep++) {
      t.sim.manualLevel = 0.8;
      for (let i = 0; i < 30; i++) t.sim.tick();
      t.sim.manualLevel = 0;
      for (let i = 0; i < 30; i++) t.sim.tick();
    }
    expect(live.length).toBe(180);
    expect(live.some((p) => p.contracting)).toBe(true);
    expect(Math.max(...live.map((p) => p.activationPermille))).toBeGreaterThan(500);
    const s = decodeStatus(t.sim.statusBytes());
    expect(s.repsToday).toBe(3);
    // seq increments by one per packet
    expect(live[1].seq - live[0].seq).toBe(1);
    t.dispose();
  });
});
