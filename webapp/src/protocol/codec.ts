/**
 * KineTape BLE Protocol v1 — pure codec (little-endian, packed).
 * Decoders accept any BufferSource (DataView, ArrayBuffer, Uint8Array).
 * Encoders return a fresh Uint8Array.
 */
import {
  END_LEN,
  HISTORY_HEADER_LEN,
  LIVE_FLAG,
  LIVE_LEN,
  MAX_RECORDS_PER_PACKET,
  OPCODE,
  PACKET_TYPE,
  RECORD_FLAG,
  RECORD_LEN,
  STATUS_FLAG,
  STATUS_LEN,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from './constants';

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export interface LivePacket {
  flags: number;
  contracting: boolean;
  calibrated: boolean;
  sensorOk: boolean;
  seq: number;
  uptimeMs: number;
  raw: number;
  activationPermille: number;
}

export interface MinuteRecord {
  /** unix epoch seconds (UTC) if timeValid, else seconds since boot */
  t: number;
  bootId: number;
  flags: number;
  timeValid: boolean;
  sensorOk: boolean;
  meanActivationPermille: number;
  peakActivationPermille: number;
  reps: number;
  activeSeconds: number;
}

export interface RecordsPacket {
  kind: 'records';
  firstIndex: number;
  records: MinuteRecord[];
}

export interface EndPacket {
  kind: 'end';
  status: number;
  nextIndex: number;
}

export type HistoryPacket = RecordsPacket | EndPacket;

export interface DeviceStatus {
  fwVersion: number;
  flags: number;
  timeValid: boolean;
  calibrated: boolean;
  sensorOk: boolean;
  calibState: number;
  epochNow: number;
  uptimeS: number;
  bootId: number;
  restRaw: number;
  maxRaw: number;
  thresholdPct: number;
  batteryPct: number;
  oldestIndex: number;
  nextIndex: number;
  lastCmd: number;
  lastResult: number;
  repsToday: number;
}

// ---------------------------------------------------------------- helpers

export type Bytes = ArrayBufferLike | ArrayBufferView<ArrayBufferLike>;

export function toDataView(src: Bytes): DataView {
  if (src instanceof DataView) return src;
  if (ArrayBuffer.isView(src)) return new DataView(src.buffer, src.byteOffset, src.byteLength);
  return new DataView(src);
}

function need(dv: DataView, min: number, what: string) {
  if (dv.byteLength < min) throw new ProtocolError(`${what}: expected >= ${min} bytes, got ${dv.byteLength}`);
}

function checkType(dv: DataView, type: number, what: string) {
  const got = dv.getUint8(0);
  if (got !== type) throw new ProtocolError(`${what}: expected type 0x${type.toString(16)}, got 0x${got.toString(16)}`);
}

function u8(v: number, name: string) {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`${name} out of u8 range: ${v}`);
  return v;
}
function u16(v: number, name: string) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`${name} out of u16 range: ${v}`);
  return v;
}
function u32(v: number, name: string) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`${name} out of u32 range: ${v}`);
  return v;
}
function i16(v: number, name: string) {
  if (!Number.isInteger(v) || v < -0x8000 || v > 0x7fff) throw new RangeError(`${name} out of i16 range: ${v}`);
  return v;
}

export function toHex(bytes: Uint8Array | DataView): string {
  const u = bytes instanceof DataView ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------- LIVE

export function decodeLive(src: Bytes): LivePacket {
  const dv = toDataView(src);
  need(dv, LIVE_LEN, 'LIVE');
  checkType(dv, PACKET_TYPE.LIVE, 'LIVE');
  const flags = dv.getUint8(1);
  return {
    flags,
    contracting: (flags & LIVE_FLAG.CONTRACTING) !== 0,
    calibrated: (flags & LIVE_FLAG.CALIBRATED) !== 0,
    sensorOk: (flags & LIVE_FLAG.SENSOR_OK) !== 0,
    seq: dv.getUint16(2, true),
    uptimeMs: dv.getUint32(4, true),
    raw: dv.getUint16(8, true),
    activationPermille: dv.getUint16(10, true),
  };
}

export interface LiveFields {
  flags: number;
  seq: number;
  uptimeMs: number;
  raw: number;
  activationPermille: number;
}

export function encodeLive(p: LiveFields): Uint8Array {
  const out = new Uint8Array(LIVE_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, PACKET_TYPE.LIVE);
  dv.setUint8(1, u8(p.flags, 'flags'));
  dv.setUint16(2, u16(p.seq, 'seq'), true);
  dv.setUint32(4, u32(p.uptimeMs, 'uptime_ms'), true);
  dv.setUint16(8, u16(p.raw, 'raw'), true);
  dv.setUint16(10, u16(p.activationPermille, 'activation_permille'), true);
  return out;
}

// ---------------------------------------------------------------- minute record

export function decodeRecord(src: Bytes, offset = 0): MinuteRecord {
  const dv = toDataView(src);
  if (dv.byteLength < offset + RECORD_LEN) throw new ProtocolError(`record: expected ${RECORD_LEN} bytes at offset ${offset}`);
  const flags = dv.getUint8(offset + 6);
  return {
    t: dv.getUint32(offset + 0, true),
    bootId: dv.getUint16(offset + 4, true),
    flags,
    timeValid: (flags & RECORD_FLAG.TIME_VALID) !== 0,
    sensorOk: (flags & RECORD_FLAG.SENSOR_OK) !== 0,
    meanActivationPermille: dv.getUint16(offset + 8, true),
    peakActivationPermille: dv.getUint16(offset + 10, true),
    reps: dv.getUint16(offset + 12, true),
    activeSeconds: dv.getUint16(offset + 14, true),
  };
}

export interface RecordFields {
  t: number;
  bootId: number;
  flags: number;
  meanActivationPermille: number;
  peakActivationPermille: number;
  reps: number;
  activeSeconds: number;
}

function writeRecord(dv: DataView, offset: number, r: RecordFields) {
  dv.setUint32(offset + 0, u32(r.t, 't'), true);
  dv.setUint16(offset + 4, u16(r.bootId, 'boot_id'), true);
  dv.setUint8(offset + 6, u8(r.flags, 'flags'));
  dv.setUint8(offset + 7, 0);
  dv.setUint16(offset + 8, u16(r.meanActivationPermille, 'mean'), true);
  dv.setUint16(offset + 10, u16(r.peakActivationPermille, 'peak'), true);
  dv.setUint16(offset + 12, u16(r.reps, 'reps'), true);
  dv.setUint16(offset + 14, u16(r.activeSeconds, 'active_seconds'), true);
}

export function encodeRecord(r: RecordFields): Uint8Array {
  const out = new Uint8Array(RECORD_LEN);
  writeRecord(new DataView(out.buffer), 0, r);
  return out;
}

// ---------------------------------------------------------------- HISTORY

export function decodeHistoryPacket(src: Bytes): HistoryPacket {
  const dv = toDataView(src);
  need(dv, 1, 'HISTORY');
  const type = dv.getUint8(0);
  if (type === PACKET_TYPE.RECORDS) {
    need(dv, HISTORY_HEADER_LEN, 'RECORDS');
    const n = dv.getUint8(1);
    if (n < 1) throw new ProtocolError('RECORDS: count must be >= 1');
    const expected = HISTORY_HEADER_LEN + RECORD_LEN * n;
    if (dv.byteLength < expected) throw new ProtocolError(`RECORDS: count ${n} needs ${expected} bytes, got ${dv.byteLength}`);
    const firstIndex = dv.getUint32(4, true);
    const records: MinuteRecord[] = [];
    for (let i = 0; i < n; i++) records.push(decodeRecord(dv, HISTORY_HEADER_LEN + i * RECORD_LEN));
    return { kind: 'records', firstIndex, records };
  }
  if (type === PACKET_TYPE.END) {
    need(dv, END_LEN, 'END');
    return { kind: 'end', status: dv.getUint8(1), nextIndex: dv.getUint32(4, true) };
  }
  throw new ProtocolError(`HISTORY: unknown packet type 0x${type.toString(16)}`);
}

export function encodeRecordsPacket(firstIndex: number, records: RecordFields[]): Uint8Array {
  if (records.length < 1 || records.length > MAX_RECORDS_PER_PACKET)
    throw new RangeError(`RECORDS: count must be 1..${MAX_RECORDS_PER_PACKET}`);
  const out = new Uint8Array(HISTORY_HEADER_LEN + RECORD_LEN * records.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, PACKET_TYPE.RECORDS);
  dv.setUint8(1, records.length);
  dv.setUint16(2, 0, true);
  dv.setUint32(4, u32(firstIndex, 'first_index'), true);
  records.forEach((r, i) => writeRecord(dv, HISTORY_HEADER_LEN + i * RECORD_LEN, r));
  return out;
}

export function encodeEndPacket(status: number, nextIndex: number): Uint8Array {
  const out = new Uint8Array(END_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, PACKET_TYPE.END);
  dv.setUint8(1, u8(status, 'status'));
  dv.setUint16(2, 0, true);
  dv.setUint32(4, u32(nextIndex, 'next_index'), true);
  return out;
}

// ---------------------------------------------------------------- STATUS

export function decodeStatus(src: Bytes): DeviceStatus {
  const dv = toDataView(src);
  need(dv, STATUS_LEN, 'STATUS');
  checkType(dv, PACKET_TYPE.STATUS, 'STATUS');
  const flags = dv.getUint8(2);
  return {
    fwVersion: dv.getUint8(1),
    flags,
    timeValid: (flags & STATUS_FLAG.TIME_VALID) !== 0,
    calibrated: (flags & STATUS_FLAG.CALIBRATED) !== 0,
    sensorOk: (flags & STATUS_FLAG.SENSOR_OK) !== 0,
    calibState: dv.getUint8(3),
    epochNow: dv.getUint32(4, true),
    uptimeS: dv.getUint32(8, true),
    bootId: dv.getUint16(12, true),
    restRaw: dv.getUint16(14, true),
    maxRaw: dv.getUint16(16, true),
    thresholdPct: dv.getUint8(18),
    batteryPct: dv.getUint8(19),
    oldestIndex: dv.getUint32(20, true),
    nextIndex: dv.getUint32(24, true),
    lastCmd: dv.getUint8(28),
    lastResult: dv.getUint8(29),
    repsToday: dv.getUint16(30, true),
  };
}

export type StatusFields = Omit<DeviceStatus, 'timeValid' | 'calibrated' | 'sensorOk'>;

export function encodeStatus(s: StatusFields): Uint8Array {
  const out = new Uint8Array(STATUS_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, PACKET_TYPE.STATUS);
  dv.setUint8(1, u8(s.fwVersion, 'fw_version'));
  dv.setUint8(2, u8(s.flags, 'flags'));
  dv.setUint8(3, u8(s.calibState, 'calib_state'));
  dv.setUint32(4, u32(s.epochNow, 'epoch_now'), true);
  dv.setUint32(8, u32(s.uptimeS, 'uptime_s'), true);
  dv.setUint16(12, u16(s.bootId, 'boot_id'), true);
  dv.setUint16(14, u16(s.restRaw, 'rest_raw'), true);
  dv.setUint16(16, u16(s.maxRaw, 'max_raw'), true);
  dv.setUint8(18, u8(s.thresholdPct, 'threshold_pct'));
  dv.setUint8(19, u8(s.batteryPct, 'battery_pct'));
  dv.setUint32(20, u32(s.oldestIndex, 'oldest_index'), true);
  dv.setUint32(24, u32(s.nextIndex, 'next_index'), true);
  dv.setUint8(28, u8(s.lastCmd, 'last_cmd'));
  dv.setUint8(29, u8(s.lastResult, 'last_result'));
  dv.setUint16(30, u16(s.repsToday, 'reps_today'), true);
  return out;
}

// ---------------------------------------------------------------- CONTROL encoders

export function encodeSetTime(epochS: number, tzOffsetMin: number): Uint8Array {
  const out = new Uint8Array(7);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, OPCODE.SET_TIME);
  dv.setUint32(1, u32(epochS, 'epoch_s'), true);
  dv.setInt16(5, i16(tzOffsetMin, 'tz_offset_min'), true);
  return out;
}

export const encodeCalibrateRest = (): Uint8Array => Uint8Array.of(OPCODE.CALIBRATE_REST);
export const encodeCalibrateMax = (): Uint8Array => Uint8Array.of(OPCODE.CALIBRATE_MAX);
export const encodeClearHistory = (): Uint8Array => Uint8Array.of(OPCODE.CLEAR_HISTORY);
export const encodeIdentify = (): Uint8Array => Uint8Array.of(OPCODE.IDENTIFY);

export function encodeSyncHistory(fromIndex: number): Uint8Array {
  const out = new Uint8Array(5);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, OPCODE.SYNC_HISTORY);
  dv.setUint32(1, u32(fromIndex, 'from_index'), true);
  return out;
}

export function encodeSetThreshold(thresholdPct: number): Uint8Array {
  if (!Number.isInteger(thresholdPct) || thresholdPct < THRESHOLD_MIN || thresholdPct > THRESHOLD_MAX)
    throw new RangeError(`threshold_pct must be ${THRESHOLD_MIN}..${THRESHOLD_MAX}`);
  return Uint8Array.of(OPCODE.SET_THRESHOLD, thresholdPct);
}

// ---------------------------------------------------------------- CONTROL decoder (used by the simulator)

export type ControlCommand =
  | { op: 0x01; epochS: number; tzOffsetMin: number }
  | { op: 0x02 }
  | { op: 0x03 }
  | { op: 0x04; fromIndex: number }
  | { op: 0x05 }
  | { op: 0x06; thresholdPct: number }
  | { op: 0x07 };

export type ControlDecodeResult = ControlCommand | { error: 'bad_args'; op: number } | { error: 'unknown_opcode'; op: number };

export function decodeControl(src: Bytes): ControlDecodeResult {
  const dv = toDataView(src);
  if (dv.byteLength < 1) return { error: 'bad_args', op: 0 };
  const op = dv.getUint8(0);
  const len = dv.byteLength;
  const bad = { error: 'bad_args' as const, op };
  switch (op) {
    case OPCODE.SET_TIME:
      return len === 7 ? { op, epochS: dv.getUint32(1, true), tzOffsetMin: dv.getInt16(5, true) } : bad;
    case OPCODE.SYNC_HISTORY:
      return len === 5 ? { op, fromIndex: dv.getUint32(1, true) } : bad;
    case OPCODE.SET_THRESHOLD:
      return len === 2 ? { op, thresholdPct: dv.getUint8(1) } : bad;
    case OPCODE.CALIBRATE_REST:
    case OPCODE.CALIBRATE_MAX:
    case OPCODE.CLEAR_HISTORY:
    case OPCODE.IDENTIFY:
      return len === 1 ? ({ op } as ControlCommand) : bad;
    default:
      return { error: 'unknown_opcode', op };
  }
}

/** Browser tz offset in minutes EAST of UTC (e.g. EDT = -240), matching the SET_TIME test vector. */
export function browserTzOffsetMin(date = new Date()): number {
  const v = -date.getTimezoneOffset();
  return v === 0 ? 0 : v; // avoid -0
}
