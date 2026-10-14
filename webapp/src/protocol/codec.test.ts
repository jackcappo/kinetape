import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeControl,
  decodeHistoryPacket,
  decodeLive,
  decodeRecord,
  decodeStatus,
  encodeCalibrateMax,
  encodeCalibrateRest,
  encodeClearHistory,
  encodeEndPacket,
  encodeIdentify,
  encodeLive,
  encodeRecord,
  encodeRecordsPacket,
  encodeSetThreshold,
  encodeSetTime,
  encodeStatus,
  encodeSyncHistory,
  fromHex,
  ProtocolError,
  toHex,
  type MinuteRecord,
  type RecordFields,
} from './codec';
import { browserTzOffsetMin } from './codec';

// Binding contract: ../../../protocol/test-vectors.json (relative to webapp/src/protocol)
const vectorsPath = fileURLToPath(new URL('../../../protocol/test-vectors.json', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(vectorsPath, 'utf8'));

interface SnakeRecord {
  t: number;
  boot_id: number;
  flags: number;
  mean_activation_permille: number;
  peak_activation_permille: number;
  reps: number;
  active_seconds: number;
}

const toRecordFields = (f: SnakeRecord): RecordFields => ({
  t: f.t,
  bootId: f.boot_id,
  flags: f.flags,
  meanActivationPermille: f.mean_activation_permille,
  peakActivationPermille: f.peak_activation_permille,
  reps: f.reps,
  activeSeconds: f.active_seconds,
});

function expectRecord(r: MinuteRecord, f: SnakeRecord) {
  expect(r.t).toBe(f.t);
  expect(r.bootId).toBe(f.boot_id);
  expect(r.flags).toBe(f.flags);
  expect(r.timeValid).toBe((f.flags & 1) !== 0);
  expect(r.sensorOk).toBe((f.flags & 2) !== 0);
  expect(r.meanActivationPermille).toBe(f.mean_activation_permille);
  expect(r.peakActivationPermille).toBe(f.peak_activation_permille);
  expect(r.reps).toBe(f.reps);
  expect(r.activeSeconds).toBe(f.active_seconds);
}

describe('test-vectors.json is present and non-trivial', () => {
  it('has every section', () => {
    for (const k of ['live', 'record', 'history_records', 'history_end', 'status', 'control']) {
      expect(Array.isArray(V[k]), k).toBe(true);
      expect(V[k].length, k).toBeGreaterThan(0);
    }
  });
});

describe('LIVE', () => {
  for (const vec of V.live) {
    it(`decodes ${vec.hex}`, () => {
      const p = decodeLive(fromHex(vec.hex));
      expect(p.flags).toBe(vec.fields.flags);
      expect(p.seq).toBe(vec.fields.seq);
      expect(p.uptimeMs).toBe(vec.fields.uptime_ms);
      expect(p.raw).toBe(vec.fields.raw);
      expect(p.activationPermille).toBe(vec.fields.activation_permille);
      expect(p.contracting).toBe((vec.fields.flags & 1) !== 0);
      expect(p.calibrated).toBe((vec.fields.flags & 2) !== 0);
      expect(p.sensorOk).toBe((vec.fields.flags & 4) !== 0);
    });
    it(`encodes ${vec.hex}`, () => {
      const bytes = encodeLive({
        flags: vec.fields.flags,
        seq: vec.fields.seq,
        uptimeMs: vec.fields.uptime_ms,
        raw: vec.fields.raw,
        activationPermille: vec.fields.activation_permille,
      });
      expect(toHex(bytes)).toBe(vec.hex);
    });
  }
  it('rejects wrong type / short packets', () => {
    expect(() => decodeLive(fromHex('20070201'))).toThrow(ProtocolError);
    expect(() => decodeLive(fromHex('2007020140e201000008ee02'))).toThrow(ProtocolError);
  });
  it('accepts DataView with byteOffset', () => {
    const vec = V.live[0];
    const padded = fromHex('ffff' + vec.hex);
    const dv = new DataView(padded.buffer, 2, padded.byteLength - 2);
    expect(decodeLive(dv).seq).toBe(vec.fields.seq);
  });
});

describe('minute record', () => {
  for (const vec of V.record) {
    it(`decodes ${vec.hex}`, () => expectRecord(decodeRecord(fromHex(vec.hex)), vec.fields));
    it(`encodes ${vec.hex}`, () => expect(toHex(encodeRecord(toRecordFields(vec.fields)))).toBe(vec.hex));
  }
});

describe('HISTORY RECORDS', () => {
  for (const vec of V.history_records) {
    it(`decodes ${vec.hex.slice(0, 16)}…`, () => {
      const p = decodeHistoryPacket(fromHex(vec.hex));
      expect(p.kind).toBe('records');
      if (p.kind !== 'records') return;
      expect(p.firstIndex).toBe(vec.first_index);
      expect(p.records.length).toBe(vec.records.length);
      p.records.forEach((r, i) => expectRecord(r, vec.records[i]));
    });
    it(`encodes ${vec.hex.slice(0, 16)}…`, () => {
      const bytes = encodeRecordsPacket(vec.first_index, vec.records.map(toRecordFields));
      expect(toHex(bytes)).toBe(vec.hex);
    });
  }
  it('rejects truncated packets and zero count', () => {
    const vec = V.history_records[0];
    expect(() => decodeHistoryPacket(fromHex(vec.hex.slice(0, vec.hex.length - 2)))).toThrow(ProtocolError);
    expect(() => decodeHistoryPacket(fromHex('2000000000000000'))).toThrow(ProtocolError);
  });
  it('enforces 1..10 records when encoding', () => {
    expect(() => encodeRecordsPacket(0, [])).toThrow(RangeError);
    const r = toRecordFields(V.record[0].fields);
    expect(() => encodeRecordsPacket(0, Array(11).fill(r))).toThrow(RangeError);
    expect(encodeRecordsPacket(0, Array(10).fill(r)).byteLength).toBe(8 + 160);
  });
});

describe('HISTORY END', () => {
  for (const vec of V.history_end) {
    it(`decodes ${vec.hex}`, () => {
      const p = decodeHistoryPacket(fromHex(vec.hex));
      expect(p).toEqual({ kind: 'end', status: vec.status, nextIndex: vec.next_index });
    });
    it(`encodes ${vec.hex}`, () => expect(toHex(encodeEndPacket(vec.status, vec.next_index))).toBe(vec.hex));
  }
  it('rejects unknown packet types', () => {
    expect(() => decodeHistoryPacket(fromHex('2200000000000000'))).toThrow(ProtocolError);
  });
});

describe('STATUS', () => {
  for (const vec of V.status) {
    const f = vec.fields;
    it(`decodes ${vec.hex.slice(0, 16)}…`, () => {
      const s = decodeStatus(fromHex(vec.hex));
      expect(s.fwVersion).toBe(f.fw_version);
      expect(s.flags).toBe(f.flags);
      expect(s.timeValid).toBe((f.flags & 1) !== 0);
      expect(s.calibrated).toBe((f.flags & 2) !== 0);
      expect(s.sensorOk).toBe((f.flags & 4) !== 0);
      expect(s.calibState).toBe(f.calib_state);
      expect(s.epochNow).toBe(f.epoch_now);
      expect(s.uptimeS).toBe(f.uptime_s);
      expect(s.bootId).toBe(f.boot_id);
      expect(s.restRaw).toBe(f.rest_raw);
      expect(s.maxRaw).toBe(f.max_raw);
      expect(s.thresholdPct).toBe(f.threshold_pct);
      expect(s.batteryPct).toBe(f.battery_pct);
      expect(s.oldestIndex).toBe(f.oldest_index);
      expect(s.nextIndex).toBe(f.next_index);
      expect(s.lastCmd).toBe(f.last_cmd);
      expect(s.lastResult).toBe(f.last_result);
      expect(s.repsToday).toBe(f.reps_today);
    });
    it(`encodes ${vec.hex.slice(0, 16)}…`, () => {
      const bytes = encodeStatus({
        fwVersion: f.fw_version,
        flags: f.flags,
        calibState: f.calib_state,
        epochNow: f.epoch_now,
        uptimeS: f.uptime_s,
        bootId: f.boot_id,
        restRaw: f.rest_raw,
        maxRaw: f.max_raw,
        thresholdPct: f.threshold_pct,
        batteryPct: f.battery_pct,
        oldestIndex: f.oldest_index,
        nextIndex: f.next_index,
        lastCmd: f.last_cmd,
        lastResult: f.last_result,
        repsToday: f.reps_today,
      });
      expect(toHex(bytes)).toBe(vec.hex);
    });
  }
});

describe('CONTROL encoders', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const encoders: Record<string, (v: any) => Uint8Array> = {
    SET_TIME: (v) => encodeSetTime(v.epoch_s, v.tz_offset_min),
    CALIBRATE_REST: () => encodeCalibrateRest(),
    CALIBRATE_MAX: () => encodeCalibrateMax(),
    SYNC_HISTORY: (v) => encodeSyncHistory(v.from_index),
    CLEAR_HISTORY: () => encodeClearHistory(),
    SET_THRESHOLD: (v) => encodeSetThreshold(v.threshold_pct),
    IDENTIFY: () => encodeIdentify(),
  };
  it('covers every opcode in the vectors', () => {
    const names = V.control.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(Object.keys(encoders).sort());
  });
  for (const vec of V.control) {
    it(`${vec.name} -> ${vec.hex}`, () => {
      const enc = encoders[vec.name];
      expect(enc, `no encoder for ${vec.name}`).toBeDefined();
      expect(toHex(enc(vec))).toBe(vec.hex);
    });
    it(`${vec.name} round-trips through decodeControl`, () => {
      const c = decodeControl(fromHex(vec.hex));
      expect('error' in c).toBe(false);
      if (vec.name === 'SET_TIME') expect(c).toMatchObject({ epochS: vec.epoch_s, tzOffsetMin: vec.tz_offset_min });
      if (vec.name === 'SYNC_HISTORY') expect(c).toMatchObject({ fromIndex: vec.from_index });
      if (vec.name === 'SET_THRESHOLD') expect(c).toMatchObject({ thresholdPct: vec.threshold_pct });
    });
  }
  it('validates threshold range', () => {
    expect(() => encodeSetThreshold(4)).toThrow(RangeError);
    expect(() => encodeSetThreshold(96)).toThrow(RangeError);
    expect(toHex(encodeSetThreshold(5))).toBe('0605');
  });
  it('decodeControl flags bad args and unknown opcodes', () => {
    expect(decodeControl(fromHex('0601'.slice(0, 2)))).toEqual({ error: 'bad_args', op: 6 });
    expect(decodeControl(fromHex('09'))).toEqual({ error: 'unknown_opcode', op: 9 });
  });
  it('browser tz offset sign convention: minutes east of UTC', () => {
    const fake = { getTimezoneOffset: () => 240 } as Date; // EDT reports +240
    expect(browserTzOffsetMin(fake)).toBe(-240);
    expect(Object.is(browserTzOffsetMin({ getTimezoneOffset: () => 0 } as Date), 0)).toBe(true);
  });
});
