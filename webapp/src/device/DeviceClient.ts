/**
 * DeviceClient — implements the "Typical app session" from PROTOCOL.md on top of any
 * DeviceTransport:
 *   1. connect, subscribe STATUS/HISTORY/LIVE, read STATUS
 *   2. SET_TIME(now, browser tz)
 *   3. SYNC_HISTORY(stored cursor) → collect RECORDS until END → persist next_index
 *      (resync from 0 if STATUS.next_index < cursor)
 *   4. stream LIVE
 */
import { CALIB_STATE, OPCODE, OPCODE_NAME, RESULT, RESULT_NAME } from '../protocol/constants';
import {
  browserTzOffsetMin,
  decodeHistoryPacket,
  decodeLive,
  decodeStatus,
  encodeCalibrateMax,
  encodeCalibrateRest,
  encodeClearHistory,
  encodeIdentify,
  encodeSetThreshold,
  encodeSetTime,
  encodeSyncHistory,
  type DeviceStatus,
  type LivePacket,
  type MinuteRecord,
} from '../protocol/codec';
import { Emitter } from '../lib/emitter';
import type { CursorState, DeviceTransport, StoredRecord, SyncStore, TimeSource, TransportState } from './types';

export type ClientPhase = 'disconnected' | 'connecting' | 'session' | 'syncing' | 'ready' | 'reconnecting' | 'error';

export interface SyncResult {
  fromIndex: number;
  nextIndex: number;
  received: number;
  added: number;
  /** device log was cleared / reflashed → we started a new local generation from index 0 */
  resynced: boolean;
  /** records lost because the device ring overwrote them before we synced */
  lostToRing: number;
  complete: boolean;
  timeUnknown: number;
  generation: number;
  at: number;
  durationMs: number;
  /** set when the device ended the transfer with END.status != 0 (e.g. MTU too small) */
  error?: string;
}

export interface SyncProgress {
  received: number;
  expected: number;
}

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface CalibrationOutcome {
  result: number;
  resultName: string;
  status: DeviceStatus;
}

type Events = {
  status: DeviceStatus;
  live: LivePacket;
  phase: ClientPhase;
  sync: SyncResult;
  syncProgress: SyncProgress | null;
  log: LogEntry;
};

export interface DeviceClientOptions {
  now?: () => number;
  tzOffsetMin?: () => number;
  commandTimeoutMs?: number;
  historyIdleTimeoutMs?: number;
}

export class DeviceCommandError extends Error {
  constructor(
    message: string,
    public readonly result: number,
  ) {
    super(message);
    this.name = 'DeviceCommandError';
  }
}

export class SyncInterruptedError extends Error {
  constructor(
    message: string,
    public readonly partial: SyncResult,
  ) {
    super(message);
    this.name = 'SyncInterruptedError';
  }
}

interface ResolvedTime {
  epoch?: number;
  timeSource: TimeSource;
}

/**
 * Resolve wall-clock time for decoded records (pure, exported for tests).
 *  - time_valid=1 → t is epoch.
 *  - time_valid=0 and boot_id == STATUS.boot_id and STATUS.epoch_now != 0 →
 *      epoch = epoch_now − uptime_s + t   (PROTOCOL.md "Unsynced time")
 *  - otherwise, if a later record of the same boot (contiguous indices) has a known time,
 *    estimate epoch = anchor − (anchorIndex − index) × 60 ("app may estimate")
 *  - else unknown.
 */
export function resolveRecordTimes(
  entries: { index: number; rec: MinuteRecord }[],
  status: Pick<DeviceStatus, 'bootId' | 'epochNow' | 'uptimeS'> | null,
): Map<number, ResolvedTime> {
  const out = new Map<number, ResolvedTime>();
  const sorted = [...entries].sort((a, b) => a.index - b.index);
  for (const { index, rec } of sorted) {
    if (rec.timeValid) out.set(index, { epoch: rec.t, timeSource: 'device' });
    else if (status && status.epochNow !== 0 && rec.bootId === status.bootId)
      out.set(index, { epoch: status.epochNow - status.uptimeS + rec.t, timeSource: 'converted' });
    else out.set(index, { timeSource: 'unknown' });
  }
  // backward pass for estimation
  let anchor: { index: number; epoch: number; bootId: number } | null = null;
  let prevIndex: number | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { index, rec } = sorted[i];
    if (prevIndex !== null && prevIndex !== index + 1) anchor = null; // index gap breaks the chain
    if (anchor && anchor.bootId !== rec.bootId) anchor = null;
    const res = out.get(index)!;
    if (res.epoch !== undefined) anchor = { index, epoch: res.epoch, bootId: rec.bootId };
    else if (anchor) out.set(index, { epoch: anchor.epoch - (anchor.index - index) * 60, timeSource: 'estimated' });
    prevIndex = index;
  }
  return out;
}

export class DeviceClient {
  readonly events = new Emitter<Events>();
  status: DeviceStatus | null = null;
  phase: ClientPhase = 'disconnected';
  lastSync: SyncResult | null = null;
  liveStats = { received: 0, lost: 0 };
  logEntries: LogEntry[] = [];

  private unsubs: (() => void)[] = [];
  private lastLiveSeq: number | null = null;
  private syncPromise: Promise<SyncResult> | null = null;
  private sessionPromise: Promise<void> | null = null;
  private cmdChain: Promise<unknown> = Promise.resolve();
  private now: () => number;
  private tz: () => number;
  private commandTimeoutMs: number;
  private historyIdleTimeoutMs: number;
  private historyListeners = new Set<(dv: DataView) => void>();
  private stateListeners = new Set<(s: TransportState) => void>();

  constructor(
    readonly transport: DeviceTransport,
    private store: SyncStore,
    opts: DeviceClientOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.tz = opts.tzOffsetMin ?? (() => browserTzOffsetMin());
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 4000;
    this.historyIdleTimeoutMs = opts.historyIdleTimeoutMs ?? 6000;

    this.unsubs.push(
      transport.onNotify('status', (dv) => {
        try {
          this.setStatus(decodeStatus(dv));
        } catch (e) {
          this.log('warn', `Bad STATUS packet: ${(e as Error).message}`);
        }
      }),
      transport.onNotify('live', (dv) => {
        try {
          const p = decodeLive(dv);
          this.liveStats.received++;
          if (this.lastLiveSeq !== null) {
            const gap = (p.seq - this.lastLiveSeq - 1 + 0x10000) & 0xffff;
            if (gap > 0 && gap < 1000) this.liveStats.lost += gap;
          }
          this.lastLiveSeq = p.seq;
          this.events.emit('live', p);
        } catch (e) {
          this.log('warn', `Bad LIVE packet: ${(e as Error).message}`);
        }
      }),
      transport.onNotify('history', (dv) => this.historyListeners.forEach((l) => l(dv))),
      transport.onStateChange((s) => this.onTransportState(s)),
    );
  }

  get deviceId() {
    return this.transport.deviceId;
  }

  // ------------------------------------------------------------------ plumbing

  private log(level: LogEntry['level'], msg: string) {
    const e = { at: this.now(), level, msg };
    this.logEntries.push(e);
    if (this.logEntries.length > 200) this.logEntries.shift();
    this.events.emit('log', e);
  }

  private setPhase(p: ClientPhase) {
    if (this.phase === p) return;
    this.phase = p;
    this.events.emit('phase', p);
  }

  private setStatus(s: DeviceStatus) {
    this.status = s;
    this.events.emit('status', s);
  }

  private onTransportState(s: TransportState) {
    this.stateListeners.forEach((l) => l(s));
    if (s === 'reconnecting') {
      this.log('warn', 'Connection lost — reconnecting…');
      this.setPhase('reconnecting');
    } else if (s === 'disconnected') {
      this.setPhase('disconnected');
    } else if (s === 'connected' && this.phase === 'reconnecting') {
      this.log('info', 'Reconnected — resuming session');
      const prior = this.sessionPromise ?? Promise.resolve();
      void prior
        .catch(() => undefined)
        .then(() => this.runSession())
        .catch((e) => this.log('error', `Session failed after reconnect: ${(e as Error).message}`));
    }
  }

  /** Serialize CONTROL writes so command acks can't interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.cmdChain.then(fn, fn);
    this.cmdChain = p.catch(() => undefined);
    return p;
  }

  private waitForStatus(pred: (s: DeviceStatus) => boolean, timeoutMs: number) {
    let off: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<DeviceStatus>((resolve, reject) => {
      off = this.events.on('status', (s) => {
        if (pred(s)) {
          off();
          clearTimeout(timer);
          resolve(s);
        }
      });
      timer = setTimeout(() => {
        off();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    return {
      promise,
      cancel: () => {
        off();
        clearTimeout(timer);
      },
    };
  }

  async readStatus(): Promise<DeviceStatus> {
    const s = decodeStatus(await this.transport.readStatus());
    this.setStatus(s);
    return s;
  }

  /** Write a CONTROL command and wait for the STATUS notification that acknowledges it. */
  private async command(bytes: Uint8Array, op: number): Promise<DeviceStatus> {
    const w = this.waitForStatus((s) => s.lastCmd === op, this.commandTimeoutMs);
    try {
      await this.transport.writeControl(bytes);
    } catch (e) {
      w.cancel();
      throw e;
    }
    let s: DeviceStatus;
    try {
      s = await w.promise;
    } catch {
      // No notification seen — fall back to reading STATUS.
      s = await this.readStatus();
      if (s.lastCmd !== op) this.log('warn', `${OPCODE_NAME[op]}: no STATUS acknowledgement`);
    }
    if (s.lastCmd === op && s.lastResult !== RESULT.OK)
      this.log('warn', `${OPCODE_NAME[op]} → ${RESULT_NAME[s.lastResult] ?? s.lastResult}`);
    return s;
  }

  // ------------------------------------------------------------------ session

  async connect(): Promise<void> {
    this.setPhase('connecting');
    try {
      await this.transport.connect();
      this.log('info', `Connected to ${this.transport.name}`);
      await this.runSession();
    } catch (e) {
      this.log('error', `Connect failed: ${(e as Error).message}`);
      const ts = this.transport.state;
      if (ts === 'connected') this.setPhase('error');
      else if (ts !== 'reconnecting') this.setPhase('disconnected');
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect();
    this.setPhase('disconnected');
  }

  dispose() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.events.clear();
  }

  /** Steps 1–3 of the typical session. Safe to call again (e.g. after reconnect). */
  runSession(): Promise<void> {
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = (async () => {
      this.setPhase('session');
      this.lastLiveSeq = null;
      const first = await this.readStatus();
      if (first.fwVersion !== 1) this.log('warn', `Device reports fw_version ${first.fwVersion}; app speaks protocol v1`);
      await this.setTime();
      // Fresh snapshot (epoch_now/uptime_s/next_index) for unsynced-time conversion and sync.
      const s = await this.readStatus();
      await this.observeCalibration(s, 'observed');
      await this.sync();
      this.setPhase('ready');
    })().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  setTime(): Promise<DeviceStatus> {
    return this.exclusive(async () => {
      const epoch = Math.floor(this.now() / 1000);
      // firmware rejects |tz| > 840 min (UTC-14..+14) as bad_args
      const tz = Math.max(-840, Math.min(840, Math.round(this.tz())));
      const s = await this.command(encodeSetTime(epoch, tz), OPCODE.SET_TIME);
      if (s.lastCmd === OPCODE.SET_TIME && s.lastResult === RESULT.OK) this.log('info', 'Device clock set');
      return s;
    });
  }

  private async observeCalibration(s: DeviceStatus, source: 'observed' | 'wizard') {
    if (!s.calibrated) return;
    const last = await this.store.getLastCalibration(this.deviceId);
    if (!last || last.restRaw !== s.restRaw || last.maxRaw !== s.maxRaw) {
      await this.store.addCalibration({ deviceId: this.deviceId, at: this.now(), restRaw: s.restRaw, maxRaw: s.maxRaw, source });
      if (last) this.log('info', `Calibration changed (rest ${s.restRaw}, max ${s.maxRaw})`);
    }
  }

  // ------------------------------------------------------------------ sync

  sync(): Promise<SyncResult> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.exclusive(() => this.doSync(0)).finally(() => {
      this.syncPromise = null;
      this.events.emit('syncProgress', null);
      if (this.phase === 'syncing') this.setPhase('ready');
    });
    return this.syncPromise;
  }

  private async doSync(attempt: number): Promise<SyncResult> {
    const started = this.now();
    const prevPhase = this.phase;
    if (prevPhase === 'ready') this.setPhase('syncing');
    const status = this.status ?? (await this.readStatus());
    const deviceId = this.deviceId;
    let cur: CursorState = (await this.store.getCursor(deviceId)) ?? { deviceId, generation: 0, cursor: 0 };
    let resynced = false;
    if (status.nextIndex < cur.cursor) {
      this.log('warn', `Device log is behind our cursor (${status.nextIndex} < ${cur.cursor}) — it was cleared or reflashed. Resyncing from 0.`);
      cur = { ...cur, generation: cur.generation + 1, cursor: 0 };
      resynced = true;
      await this.store.setCursor({ ...cur, name: this.transport.name });
    }
    const from = cur.cursor;
    const lostToRing = Math.max(0, status.oldestIndex - from);
    if (lostToRing > 0) this.log('warn', `${lostToRing} minute records were overwritten on the device before they could be synced.`);
    const expected = Math.max(0, status.nextIndex - Math.max(from, status.oldestIndex));

    const received = new Map<number, MinuteRecord>();
    let end: { status: number; nextIndex: number } | null = null;
    let failure: Error | null = null;

    await new Promise<void>((resolve) => {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(idle);
        this.historyListeners.delete(onHistory);
        this.stateListeners.delete(onState);
        offStatus();
      };
      const fail = (e: Error) => {
        failure = e;
        cleanup();
        resolve();
      };
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => fail(new Error('History transfer timed out')), this.historyIdleTimeoutMs);
      };
      const onHistory = (dv: DataView) => {
        try {
          const p = decodeHistoryPacket(dv);
          if (p.kind === 'records') {
            p.records.forEach((r, i) => received.set(p.firstIndex + i, r));
            this.events.emit('syncProgress', { received: received.size, expected });
            armIdle();
          } else {
            end = { status: p.status, nextIndex: p.nextIndex };
            cleanup();
            resolve();
          }
        } catch (e) {
          this.log('warn', `Bad HISTORY packet: ${(e as Error).message}`);
        }
      };
      const onState = (s: TransportState) => {
        if (s !== 'connected') fail(new Error('Connection lost during sync'));
      };
      const offStatus = this.events.on('status', (s) => {
        if (s.lastCmd === OPCODE.SYNC_HISTORY && s.lastResult !== RESULT.OK)
          fail(new DeviceCommandError(`SYNC_HISTORY rejected: ${RESULT_NAME[s.lastResult] ?? s.lastResult}`, s.lastResult));
      });
      this.historyListeners.add(onHistory);
      this.stateListeners.add(onState);
      this.events.emit('syncProgress', { received: 0, expected });
      armIdle();
      this.transport.writeControl(encodeSyncHistory(from)).catch((e: Error) => fail(e));
    });

    // ---- finalize: contiguous run from the first index the device sent
    const keys = [...received.keys()].sort((a, b) => a - b);
    const start = keys.length ? Math.min(keys[0], Math.max(from, status.oldestIndex)) : from;
    // If the device started later than expected (ring moved on during the transfer) we accept its start.
    let contiguous = keys.length ? keys[0] : from;
    while (received.has(contiguous)) contiguous++;
    const endInfo = end as { status: number; nextIndex: number } | null;

    let endError: string | undefined;
    let newCursor = from;
    let complete = false;
    if (endInfo && endInfo.status === 0) {
      if (endInfo.nextIndex < from) {
        // END disagrees with our cursor: the log was reset between STATUS and SYNC.
        cur = { ...cur, generation: cur.generation + 1, cursor: 0 };
        await this.store.setCursor({ ...cur, name: this.transport.name });
        if (attempt < 2) return this.doSync(attempt + 1);
      }
      if (!keys.length) {
        newCursor = Math.max(from, endInfo.nextIndex);
        complete = true;
      } else if (contiguous >= endInfo.nextIndex) {
        newCursor = endInfo.nextIndex;
        complete = true;
      } else {
        newCursor = contiguous;
        this.log('warn', `History had a gap at index ${contiguous}; will re-request`);
      }
    } else {
      if (endInfo) {
        endError = `Device could not send history (END status ${endInfo.status}). This can happen if the BLE MTU is too small for a record; try reconnecting.`;
        this.log('error', endError);
      }
      if (keys.length) newCursor = Math.max(from, contiguous);
    }

    // ---- resolve time and persist
    const latest = this.status ?? status;
    const entries = keys.map((index) => ({ index, rec: received.get(index)! }));
    const times = resolveRecordTimes(entries, latest);
    let timeUnknown = 0;
    const rows: StoredRecord[] = entries.map(({ index, rec }) => {
      const t = times.get(index)!;
      if (t.timeSource === 'unknown') timeUnknown++;
      return {
        deviceId,
        generation: cur.generation,
        index,
        t: rec.t,
        bootId: rec.bootId,
        flags: rec.flags,
        sensorOk: rec.sensorOk,
        mean: rec.meanActivationPermille,
        peak: rec.peakActivationPermille,
        reps: rec.reps,
        activeSeconds: rec.activeSeconds,
        epoch: t.epoch,
        timeSource: t.timeSource,
      };
    });
    const added = rows.length ? await this.store.upsertRecords(rows) : 0;
    const at = this.now();
    await this.store.setCursor({ deviceId, generation: cur.generation, cursor: newCursor, name: this.transport.name, lastSyncAt: complete ? at : cur.lastSyncAt });

    const result: SyncResult = {
      fromIndex: start,
      nextIndex: newCursor,
      received: received.size,
      added,
      resynced,
      lostToRing,
      complete,
      timeUnknown,
      generation: cur.generation,
      at,
      durationMs: at - started,
      error: endError,
    };

    if (failure) {
      const f = failure as Error;
      this.log('error', `Sync interrupted after ${received.size} records: ${f.message}. Progress saved; it will resume from index ${newCursor}.`);
      throw new SyncInterruptedError(f.message, result);
    }
    if (!complete && endInfo && endInfo.status === 0 && attempt < 2) {
      const again = await this.doSync(attempt + 1);
      return { ...again, received: again.received + result.received, added: again.added + result.added, resynced: again.resynced || resynced };
    }
    this.lastSync = result;
    this.log('info', `Synced ${received.size} records (${added} new) — cursor ${newCursor}`);
    this.events.emit('sync', result);
    return result;
  }

  // ------------------------------------------------------------------ commands

  /**
   * Run CALIBRATE_REST or CALIBRATE_MAX and wait for the async sampling to finish.
   * Resolves with the final last_result (0 ok, 2 busy, 4 failed …).
   */
  calibrate(kind: 'rest' | 'max'): Promise<CalibrationOutcome> {
    return this.exclusive(async () => {
      const op = kind === 'rest' ? OPCODE.CALIBRATE_REST : OPCODE.CALIBRATE_MAX;
      const sampleMs = kind === 'rest' ? 3000 : 5000;
      let sawSampling = false;
      const w = this.waitForStatus((s) => {
        if (s.lastCmd !== op) return false;
        // rejected immediately (busy / bad_args) — firmware never started sampling
        if (!sawSampling && s.lastResult !== RESULT.OK) return true;
        if (s.calibState !== CALIB_STATE.IDLE) {
          sawSampling = true;
          return false;
        }
        // idle again after sampling → finished; last_result carries the outcome (0 ok / 4 failed).
        // (idle + ok without having seen sampling could be a stale periodic STATUS: keep waiting)
        return sawSampling;
      }, sampleMs + this.commandTimeoutMs + 2000);
      try {
        await this.transport.writeControl(op === OPCODE.CALIBRATE_REST ? encodeCalibrateRest() : encodeCalibrateMax());
      } catch (e) {
        w.cancel();
        throw e;
      }
      let s: DeviceStatus;
      try {
        s = await w.promise;
      } catch {
        // poll as a fallback
        s = await this.readStatus();
        const deadline = this.now() + 6000;
        while (s.calibState !== CALIB_STATE.IDLE && this.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          s = await this.readStatus();
        }
      }
      if (s.lastResult === RESULT.OK) await this.observeCalibration(s, 'wizard');
      this.log(s.lastResult === RESULT.OK ? 'info' : 'warn', `${OPCODE_NAME[op]} → ${RESULT_NAME[s.lastResult] ?? s.lastResult}`);
      return { result: s.lastResult, resultName: RESULT_NAME[s.lastResult] ?? String(s.lastResult), status: s };
    });
  }

  /** Throws RangeError synchronously for values outside 5..95. */
  setThreshold(pct: number): Promise<number> {
    const bytes = encodeSetThreshold(pct);
    return this.exclusive(async () => (await this.command(bytes, OPCODE.SET_THRESHOLD)).lastResult);
  }

  identify(): Promise<number> {
    return this.exclusive(async () => (await this.command(encodeIdentify(), OPCODE.IDENTIFY)).lastResult);
  }

  /** CLEAR_HISTORY: wipes the device log. Already-synced data stays in the app (new generation). */
  clearHistory(): Promise<number> {
    return this.exclusive(async () => {
      const s = await this.command(encodeClearHistory(), OPCODE.CLEAR_HISTORY);
      if (s.lastResult === RESULT.OK) {
        const cur = (await this.store.getCursor(this.deviceId)) ?? { deviceId: this.deviceId, generation: 0, cursor: 0 };
        await this.store.setCursor({ ...cur, generation: cur.generation + 1, cursor: 0 });
      }
      return s.lastResult;
    });
  }
}
