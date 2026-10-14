/**
 * A fake KineTape "firmware" that speaks protocol v1 bytes.
 *
 * It mirrors the firmware behaviour described in PROTOCOL.md: 100 Hz sampling with EMA,
 * hysteresis rep detection, minute summaries in a ring log, STATUS / LIVE / HISTORY
 * notifications, async calibration and paced SYNC_HISTORY. Everything it emits is encoded
 * with src/protocol and therefore decoded by the very same decoders as a real device.
 */
import {
  BATTERY_UNKNOWN,
  CALIB_STATE,
  DEFAULT_THRESHOLD_PCT,
  LIVE_FLAG,
  MAX_RECORDS_PER_PACKET,
  OPCODE,
  RECORD_FLAG,
  RESULT,
  STATUS_FLAG,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from '../protocol/constants';
import {
  decodeControl,
  encodeEndPacket,
  encodeLive,
  encodeRecordsPacket,
  encodeStatus,
  type RecordFields,
  type StatusFields,
} from '../protocol/codec';
import { Rng } from '../lib/random';
import type { NotifyChannel } from './types';

export interface SimHistory {
  /** index of records[0] */
  firstIndex: number;
  records: RecordFields[];
}

export interface SimOptions {
  bootId?: number;
  /** Uptime (s) at construction. */
  uptimeS?: number;
  /** If set, the device already has wall-clock time (epoch seconds at construction). */
  epochAtStart?: number;
  tzOffsetMin?: number;
  restRaw?: number;
  maxRaw?: number;
  calibrated?: boolean;
  thresholdPct?: number;
  history?: SimHistory;
  /** Ring capacity in records (default 7 days × 1440). */
  capacity?: number;
  /** Run the real-time 100 Hz signal engine + 20 Hz LIVE (default true). */
  realtime?: boolean;
  historyPacingMs?: number;
  calibRestMs?: number;
  calibMaxMs?: number;
  statusIntervalMs?: number;
  seed?: number;
  now?: () => number;
}

type Segment = { level: number; ms: number };

export interface SimHooks {
  notify(channel: NotifyChannel, bytes: Uint8Array): void;
  /** Fired when the firmware wants to blink its LED. */
  identify?(): void;
  /** For fault injection: the device asks its transport to drop the link. */
  dropLink?(): void;
}

const TRUE_REST = 300;
const TRUE_MAX = 3300;

export class SimDevice {
  // persisted ("NVS") state
  bootId: number;
  restRaw: number;
  maxRaw: number;
  calibrated: boolean;
  thresholdPct: number;
  tzOffsetMin: number;

  // runtime
  private bootMs: number;
  private timeSetEpochMs: number | null = null; // wall clock (ms) at the moment time was set
  private timeSetAtMs = 0; // local now() at that moment
  private log: RecordFields[] = [];
  oldestIndex = 0;
  nextIndex = 0;
  private capacity: number;
  calibState: number = CALIB_STATE.IDLE;
  lastCmd = 0;
  lastResult = 0;
  private seq = 0;
  private syncing = false;

  // signal engine
  private rng: Rng;
  private level = 0;
  private filtered = TRUE_REST;
  private contracting = false;
  private contractionStartMs = 0;
  private sensorBadSinceMs: number | null = null;
  private sampleClockMs = 0;
  sensorOk = true;
  private segments: Segment[] = [];
  private segmentLeftMs = 0;
  private currentTarget = 0.02;
  /** Manual "flex" override from the demo UI (0..1), null = automatic pattern. */
  manualLevel: number | null = null;
  /** Coach mode: produce reps with this shape (used by guided exercise in demo). */
  coach: { holdMs: number; relaxMs: number; level: number } | null = null;
  /** Fault injection */
  sensorFault = false;
  failNextMaxCalibration = false;
  /** Drop the link after this many HISTORY packets of the next sync (test hook). */
  dropAfterPackets: number | null = null;

  // minute accumulator
  private acc = this.newAcc(0, false);
  private repsTodayBase = 0;
  private repsTodayKey = '';

  private timers: ReturnType<typeof setInterval>[] = [];
  private calibTimer: ReturnType<typeof setTimeout> | null = null;
  private calibSamples: number[] = [];
  private nowFn: () => number;
  private realtime: boolean;
  private opts: Required<Pick<SimOptions, 'historyPacingMs' | 'calibRestMs' | 'calibMaxMs' | 'statusIntervalMs'>>;
  hooks: SimHooks | null = null;
  /** Whether a central is connected (notifications only flow when true). */
  connected = false;
  /** Whether the central subscribed to STATUS + HISTORY (set by the transport on connect). */
  historySubscribed = false;
  /** Negotiated ATT MTU (fault injection: < 27 → no room for a record). */
  mtu = 185;

  constructor(o: SimOptions = {}) {
    this.nowFn = o.now ?? (() => Date.now());
    this.rng = new Rng(o.seed ?? 42);
    this.bootId = o.bootId ?? 1;
    this.restRaw = o.restRaw ?? TRUE_REST + 10;
    this.maxRaw = o.maxRaw ?? 4095;
    this.calibrated = o.calibrated ?? false;
    this.thresholdPct = o.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
    this.tzOffsetMin = o.tzOffsetMin ?? 0;
    this.capacity = o.capacity ?? 7 * 1440;
    this.realtime = o.realtime ?? true;
    this.opts = {
      historyPacingMs: o.historyPacingMs ?? 4,
      calibRestMs: o.calibRestMs ?? 3000,
      calibMaxMs: o.calibMaxMs ?? 5000,
      statusIntervalMs: o.statusIntervalMs ?? 5000,
    };
    const now = this.nowFn();
    this.bootMs = now - (o.uptimeS ?? 0) * 1000;
    if (o.epochAtStart !== undefined) {
      this.timeSetEpochMs = o.epochAtStart * 1000;
      this.timeSetAtMs = now;
    }
    if (o.history) {
      this.log = o.history.records.slice();
      this.oldestIndex = o.history.firstIndex;
      this.nextIndex = o.history.firstIndex + this.log.length;
      this.trimRing();
    }
    this.restCalibrated = this.maxCalibrated = this.calibrated;
    this.acc = this.startAccumulator();
    this.recomputeRepsTodayBase();
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    if (!this.realtime || this.timers.length) return;
    this.timers.push(setInterval(() => this.tick(), 50));
    this.timers.push(setInterval(() => this.notifyStatus(), this.opts.statusIntervalMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.calibTimer) clearTimeout(this.calibTimer);
  }

  // ------------------------------------------------------------------ time

  private now() {
    return this.nowFn();
  }
  uptimeMs() {
    return Math.max(0, Math.floor(this.now() - this.bootMs));
  }
  get timeValid() {
    return this.timeSetEpochMs !== null;
  }
  /** Current epoch seconds or 0 if time not set. */
  epochNow(): number {
    if (this.timeSetEpochMs === null) return 0;
    return Math.floor((this.timeSetEpochMs + (this.now() - this.timeSetAtMs)) / 1000);
  }

  // ------------------------------------------------------------------ log

  /** Append a record to the ring (also used by tests and the demo seeder). */
  appendRecord(r: RecordFields) {
    this.log.push(r);
    this.nextIndex++;
    this.trimRing();
  }

  private trimRing() {
    const excess = this.log.length - this.capacity;
    if (excess > 0) {
      this.log.splice(0, excess);
      this.oldestIndex += excess;
    }
  }

  getRecord(index: number): RecordFields | undefined {
    return this.log[index - this.oldestIndex];
  }

  clearLog() {
    this.log = [];
    this.oldestIndex = 0;
    this.nextIndex = 0;
  }

  /** Simulate a power cycle: new boot id, time lost, uptime 0. */
  reboot() {
    this.bootId = (this.bootId + 1) & 0xffff;
    this.bootMs = this.now();
    this.timeSetEpochMs = null;
    this.acc = this.startAccumulator();
    this.recomputeRepsTodayBase();
  }

  // ------------------------------------------------------------------ status

  statusFields(): StatusFields {
    const flags =
      (this.timeValid ? STATUS_FLAG.TIME_VALID : 0) |
      (this.calibrated ? STATUS_FLAG.CALIBRATED : 0) |
      (this.sensorOk ? STATUS_FLAG.SENSOR_OK : 0);
    return {
      fwVersion: 1,
      flags,
      calibState: this.calibState,
      epochNow: this.epochNow(),
      uptimeS: Math.floor(this.uptimeMs() / 1000),
      bootId: this.bootId,
      restRaw: this.restRaw,
      maxRaw: this.maxRaw,
      thresholdPct: this.thresholdPct,
      batteryPct: BATTERY_UNKNOWN,
      oldestIndex: this.oldestIndex,
      nextIndex: this.nextIndex,
      lastCmd: this.lastCmd,
      lastResult: this.lastResult,
      repsToday: Math.min(0xffff, this.repsToday()),
    };
  }

  statusBytes(): Uint8Array {
    return encodeStatus(this.statusFields());
  }

  notifyStatus() {
    this.send('status', this.statusBytes());
  }

  private send(channel: NotifyChannel, bytes: Uint8Array) {
    if (this.connected && this.hooks) this.hooks.notify(channel, bytes);
  }

  private dayKey(): string {
    if (this.timeValid) return 'd' + Math.floor((this.epochNow() + this.tzOffsetMin * 60) / 86400);
    return 'b' + this.bootId;
  }

  private recomputeRepsTodayBase() {
    this.repsTodayKey = this.dayKey();
    let sum = 0;
    if (this.timeValid) {
      const day = Math.floor((this.epochNow() + this.tzOffsetMin * 60) / 86400);
      for (const r of this.log)
        if (r.flags & RECORD_FLAG.TIME_VALID && Math.floor((r.t + this.tzOffsetMin * 60) / 86400) === day) sum += r.reps;
    } else {
      for (const r of this.log) if (r.bootId === this.bootId) sum += r.reps;
    }
    this.repsTodayBase = sum;
  }

  repsToday(): number {
    if (this.dayKey() !== this.repsTodayKey) this.recomputeRepsTodayBase();
    return this.repsTodayBase + this.acc.reps;
  }

  // ------------------------------------------------------------------ CONTROL

  handleControl(bytes: Uint8Array) {
    const cmd = decodeControl(bytes);
    if ('error' in cmd) {
      this.finishCmd(cmd.op, cmd.error === 'bad_args' ? RESULT.BAD_ARGS : RESULT.UNKNOWN_OPCODE);
      return;
    }
    switch (cmd.op) {
      case OPCODE.SET_TIME: {
        // firmware rejects epoch 0 and |tz| > 840 min as bad_args
        if (cmd.epochS === 0 || Math.abs(cmd.tzOffsetMin) > 840) {
          this.finishCmd(cmd.op, RESULT.BAD_ARGS);
          return;
        }
        this.timeSetEpochMs = cmd.epochS * 1000;
        this.timeSetAtMs = this.now();
        this.tzOffsetMin = cmd.tzOffsetMin;
        this.recomputeRepsTodayBase();
        this.finishCmd(cmd.op, RESULT.OK);
        return;
      }
      case OPCODE.CALIBRATE_REST:
      case OPCODE.CALIBRATE_MAX:
        this.startCalibration(cmd.op);
        return;
      case OPCODE.SYNC_HISTORY:
        if (this.syncing) {
          this.finishCmd(cmd.op, RESULT.BUSY);
          return;
        }
        // firmware: nothing is sent (and last_result=4) unless the central subscribed STATUS + HISTORY
        if (!this.historySubscribed) {
          this.finishCmd(cmd.op, RESULT.FAILED);
          return;
        }
        this.finishCmd(cmd.op, RESULT.OK);
        if (this.recordsPerPacket() === 0) {
          // MTU too small for even one record: firmware sends only END with status=1
          this.send('history', encodeEndPacket(1, this.nextIndex));
          return;
        }
        void this.streamHistory(cmd.fromIndex);
        return;
      case OPCODE.CLEAR_HISTORY:
        if (this.syncing) {
          this.finishCmd(cmd.op, RESULT.BUSY);
          return;
        }
        this.clearLog();
        this.finishCmd(cmd.op, RESULT.OK);
        return;
      case OPCODE.SET_THRESHOLD:
        if (cmd.thresholdPct < THRESHOLD_MIN || cmd.thresholdPct > THRESHOLD_MAX) {
          this.finishCmd(cmd.op, RESULT.BAD_ARGS);
          return;
        }
        this.thresholdPct = cmd.thresholdPct;
        this.finishCmd(cmd.op, RESULT.OK);
        return;
      case OPCODE.IDENTIFY:
        this.hooks?.identify?.();
        this.finishCmd(cmd.op, RESULT.OK);
        return;
    }
  }

  private finishCmd(op: number, result: number) {
    this.lastCmd = op;
    this.lastResult = result;
    this.notifyStatus();
  }

  private startCalibration(op: number) {
    if (this.calibState !== CALIB_STATE.IDLE) {
      this.finishCmd(op, RESULT.BUSY);
      return;
    }
    const isRest = op === OPCODE.CALIBRATE_REST;
    this.calibState = isRest ? CALIB_STATE.SAMPLING_REST : CALIB_STATE.SAMPLING_MAX;
    this.calibSamples = [];
    const weak = !isRest && this.failNextMaxCalibration;
    this.failNextMaxCalibration = false;
    this.calibWeak = weak;
    this.finishCmd(op, RESULT.OK); // notify at start
    this.calibTimer = setTimeout(
      () => {
        this.calibTimer = null;
        let samples = this.calibSamples;
        if (!samples.length) {
          // no realtime engine (tests): synthesise a plausible window
          samples = isRest
            ? [TRUE_REST + 8, TRUE_REST + 12, TRUE_REST + 10]
            : weak
              ? [this.restRaw + 20, this.restRaw + 40]
              : [TRUE_REST + 900, TRUE_MAX - 180, TRUE_MAX - 150];
        }
        let result: number = RESULT.OK;
        if (isRest) {
          this.restRaw = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
          this.restCalibrated = true;
        } else {
          const peak = Math.round(Math.max(...samples));
          if (peak < this.restRaw + 100) result = RESULT.FAILED;
          else {
            this.maxRaw = peak;
            this.maxCalibrated = true;
          }
        }
        if (this.restCalibrated && this.maxCalibrated) this.calibrated = true;
        this.calibState = CALIB_STATE.IDLE;
        this.finishCmd(op, result); // notify at end with the outcome
      },
      isRest ? this.opts.calibRestMs : this.opts.calibMaxMs,
    );
  }
  private calibWeak = false;
  private restCalibrated = false;
  private maxCalibrated = false;

  /** Records per RECORDS packet so that 8 + 16n ≤ MTU − 3 (max 10). */
  recordsPerPacket(): number {
    return Math.max(0, Math.min(MAX_RECORDS_PER_PACKET, Math.floor((this.mtu - 3 - 8) / 16)));
  }

  private async streamHistory(fromIndex: number) {
    this.syncing = true;
    try {
      const start = Math.max(fromIndex, this.oldestIndex);
      const end = this.nextIndex; // snapshot
      const per = this.recordsPerPacket();
      let sent = 0;
      for (let i = start; i < end; i += per) {
        if (!this.connected) return;
        const n = Math.min(per, end - i);
        const recs: RecordFields[] = [];
        for (let k = 0; k < n; k++) {
          const r = this.getRecord(i + k);
          if (r) recs.push(r);
        }
        if (recs.length) this.send('history', encodeRecordsPacket(i, recs));
        sent++;
        if (this.dropAfterPackets !== null && sent >= this.dropAfterPackets) {
          this.dropAfterPackets = null;
          this.hooks?.dropLink?.();
          return;
        }
        await new Promise((r) => setTimeout(r, this.opts.historyPacingMs));
      }
      if (!this.connected) return;
      this.send('history', encodeEndPacket(0, end));
    } finally {
      this.syncing = false;
    }
  }

  // ------------------------------------------------------------------ signal engine (realtime)

  private newAcc(startT: number, timeValid: boolean) {
    return {
      startT,
      timeValid,
      endUptimeMs: 0,
      endEpochMs: 0,
      sum: 0,
      count: 0,
      peak: 0,
      reps: 0,
      activeSamples: 0,
      sensorOkWhole: true,
    };
  }

  private startAccumulator() {
    if (this.timeValid) {
      const e = this.epochNow();
      const start = Math.floor(e / 60) * 60;
      const acc = this.newAcc(start, true);
      acc.endEpochMs = (start + 60) * 1000;
      return acc;
    }
    const upS = Math.floor(this.uptimeMs() / 1000);
    const start = Math.floor(upS / 60) * 60;
    const acc = this.newAcc(start, false);
    acc.endUptimeMs = (start + 60) * 1000;
    return acc;
  }

  private closeMinuteIfDue() {
    const a = this.acc;
    const due = a.timeValid ? this.epochNow() * 1000 >= a.endEpochMs : this.uptimeMs() >= a.endUptimeMs;
    if (!due) return;
    const mean = a.count ? Math.round(a.sum / a.count) : 0;
    const rec: RecordFields = {
      t: a.startT,
      bootId: this.bootId,
      flags: (a.timeValid ? RECORD_FLAG.TIME_VALID : 0) | (a.sensorOkWhole ? RECORD_FLAG.SENSOR_OK : 0),
      meanActivationPermille: mean,
      peakActivationPermille: a.peak,
      reps: a.reps,
      activeSeconds: Math.min(60, Math.round(a.activeSamples / 100)),
    };
    this.appendRecord(rec);
    this.repsTodayBase += a.reps;
    // "from the next minute on": once time is valid, new accumulators follow wall-clock minutes
    this.acc = this.startAccumulator();
    if (this.dayKey() !== this.repsTodayKey) this.recomputeRepsTodayBase();
  }

  private nextSegment(): Segment {
    if (!this.segments.length) this.planBout();
    return this.segments.shift()!;
  }

  private planBout() {
    const r = this.rng;
    if (this.coach) {
      const c = this.coach;
      this.segments.push({ level: c.level * r.range(0.9, 1.08), ms: c.holdMs * r.range(0.92, 1.12) + 250 });
      this.segments.push({ level: 0.02, ms: c.relaxMs * r.range(0.85, 1.2) });
      return;
    }
    const roll = r.float();
    if (roll < 0.45) {
      this.segments.push({ level: r.range(0.0, 0.05), ms: r.range(6000, 20000) });
    } else if (roll < 0.72) {
      const reps = r.int(4, 8);
      const lvl = r.range(0.45, 0.85);
      for (let i = 0; i < reps; i++) {
        this.segments.push({ level: lvl * r.range(0.9, 1.1), ms: r.range(1800, 4200) });
        this.segments.push({ level: 0.03, ms: r.range(1500, 3000) });
      }
      this.segments.push({ level: 0.02, ms: r.range(4000, 9000) });
    } else {
      const steps = r.int(6, 14);
      for (let i = 0; i < steps; i++) {
        this.segments.push({ level: r.range(0.2, 0.38), ms: r.range(380, 650) });
        this.segments.push({ level: 0.05, ms: r.range(400, 700) });
      }
    }
  }

  /** Replace the automatic pattern immediately (e.g. when coach mode toggles). */
  resetPattern() {
    this.segments = [];
    this.segmentLeftMs = 0;
  }

  private targetLevel(dtMs: number): number {
    if (this.calibState === CALIB_STATE.SAMPLING_REST) return 0.0;
    if (this.calibState === CALIB_STATE.SAMPLING_MAX) return this.calibWeak ? 0.01 : this.manualLevel ?? 0.97;
    if (this.manualLevel !== null) return this.manualLevel;
    this.segmentLeftMs -= dtMs;
    if (this.segmentLeftMs <= 0) {
      const s = this.nextSegment();
      this.currentTarget = s.level;
      this.segmentLeftMs = s.ms;
    }
    return this.currentTarget;
  }

  /** One 50 ms tick = 5 samples at 100 Hz + one LIVE notification. */
  tick() {
    const thrOn = this.thresholdPct * 10;
    const thrOff = thrOn * 0.6;
    let activation = 0;
    for (let i = 0; i < 5; i++) {
      const target = this.targetLevel(10);
      const k = target > this.level ? 0.09 : 0.07;
      this.level += (target - this.level) * k;
      let raw: number;
      if (this.sensorFault) raw = this.rng.range(0, 4);
      else {
        const tremor = this.level > 0.3 ? this.rng.normal(0, 18 * this.level) : 0;
        raw = TRUE_REST + this.level * (TRUE_MAX - TRUE_REST) + this.rng.normal(0, 5) + tremor;
      }
      raw = Math.max(0, Math.min(4095, Math.round(raw)));
      this.filtered = this.filtered + 0.2 * (raw - this.filtered);
      // durations are measured on the 100 Hz sample clock, like the firmware's sampling loop
      this.sampleClockMs += 10;
      const nowMs = this.sampleClockMs;
      // sensor fault detection: raw stuck at rails for > 2 s
      if (raw <= 5 || raw >= 4090) {
        if (this.sensorBadSinceMs === null) this.sensorBadSinceMs = nowMs;
        if (nowMs - this.sensorBadSinceMs > 2000 && this.sensorOk) {
          this.sensorOk = false;
          this.notifyStatus();
        }
      } else {
        this.sensorBadSinceMs = null;
        if (!this.sensorOk) {
          this.sensorOk = true;
          this.notifyStatus();
        }
      }
      const span = Math.max(1, this.maxRaw - this.restRaw);
      activation = Math.round(Math.max(0, Math.min(1, (this.filtered - this.restRaw) / span)) * 1000);
      if (this.calibState !== CALIB_STATE.IDLE) this.calibSamples.push(this.filtered);
      // rep detection
      if (!this.contracting && activation >= thrOn) {
        this.contracting = true;
        this.contractionStartMs = nowMs;
      } else if (this.contracting && activation < thrOff) {
        this.contracting = false;
        if (nowMs - this.contractionStartMs >= 200) this.acc.reps++;
      }
      const a = this.acc;
      a.sum += activation;
      a.count++;
      if (activation > a.peak) a.peak = activation;
      if (activation >= thrOn) a.activeSamples++;
      if (!this.sensorOk) a.sensorOkWhole = false;
    }
    this.closeMinuteIfDue();
    const flags =
      (this.contracting ? LIVE_FLAG.CONTRACTING : 0) |
      (this.calibrated ? LIVE_FLAG.CALIBRATED : 0) |
      (this.sensorOk ? LIVE_FLAG.SENSOR_OK : 0);
    this.send(
      'live',
      encodeLive({
        flags,
        seq: this.seq,
        uptimeMs: this.uptimeMs() >>> 0,
        raw: Math.round(this.filtered),
        activationPermille: activation,
      }),
    );
    this.seq = (this.seq + 1) & 0xffff;
  }
}
