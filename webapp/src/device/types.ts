/**
 * Device layer contracts. A DeviceTransport only moves raw bytes (DataViews) — all
 * decoding happens in DeviceClient via src/protocol, so the simulator and real BLE
 * exercise exactly the same codec paths.
 */

export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type NotifyChannel = 'status' | 'history' | 'live';

export interface DeviceTransport {
  readonly kind: 'ble' | 'sim';
  /** Stable id for this physical device (Web Bluetooth device.id, or sim id). */
  readonly deviceId: string;
  readonly name: string;
  readonly state: TransportState;
  /** Connect and subscribe to STATUS, HISTORY and LIVE notifications. */
  connect(): Promise<void>;
  /** User-initiated disconnect (no auto-reconnect). */
  disconnect(): Promise<void>;
  /** Read the STATUS characteristic. */
  readStatus(): Promise<DataView>;
  /** Write to CONTROL (write with response). */
  writeControl(bytes: Uint8Array): Promise<void>;
  onNotify(channel: NotifyChannel, cb: (value: DataView) => void): () => void;
  /** State changes. After an automatic reconnect the transport goes reconnecting → connected. */
  onStateChange(cb: (state: TransportState) => void): () => void;
}

export type TimeSource = 'device' | 'converted' | 'estimated' | 'unknown';

/** A minute record as persisted by the app. */
export interface StoredRecord {
  deviceId: string;
  /** Local "log generation": bumped whenever we detect the device log was cleared/reflashed. */
  generation: number;
  /** Device log index (unique within deviceId+generation). */
  index: number;
  /** Raw device t (epoch or seconds since boot). */
  t: number;
  bootId: number;
  flags: number;
  sensorOk: boolean;
  mean: number;
  peak: number;
  reps: number;
  activeSeconds: number;
  /** Unix epoch seconds (UTC) of the minute start, if known. */
  epoch?: number;
  timeSource: TimeSource;
}

export interface CursorState {
  deviceId: string;
  generation: number;
  cursor: number;
  name?: string;
  lastSyncAt?: number;
}

export interface CalibrationEvent {
  deviceId: string;
  /** epoch ms when the app observed / performed it */
  at: number;
  restRaw: number;
  maxRaw: number;
  source: 'wizard' | 'observed' | 'demo';
}

/** Persistence used by DeviceClient — Dexie in the app, in-memory in tests. */
export interface SyncStore {
  getCursor(deviceId: string): Promise<CursorState | undefined>;
  setCursor(state: CursorState): Promise<void>;
  /** Insert records, deduplicating by (deviceId, generation, index). Returns number of new rows. */
  upsertRecords(records: StoredRecord[]): Promise<number>;
  getLastCalibration(deviceId: string): Promise<CalibrationEvent | undefined>;
  addCalibration(ev: CalibrationEvent): Promise<void>;
}

const RANK: Record<TimeSource, number> = { device: 3, converted: 2, estimated: 1, unknown: 0 };
export const timeSourceRank = (s: TimeSource) => RANK[s];

export const recordKey = (r: Pick<StoredRecord, 'deviceId' | 'generation' | 'index'>) =>
  `${r.deviceId}|${r.generation}|${r.index}`;

/** In-memory SyncStore (tests, and a fallback when IndexedDB is unavailable). */
export class MemorySyncStore implements SyncStore {
  cursors = new Map<string, CursorState>();
  records = new Map<string, StoredRecord>();
  calibrations: CalibrationEvent[] = [];

  async getCursor(deviceId: string) {
    const c = this.cursors.get(deviceId);
    return c ? { ...c } : undefined;
  }
  async setCursor(state: CursorState) {
    this.cursors.set(state.deviceId, { ...state });
  }
  async upsertRecords(records: StoredRecord[]) {
    let added = 0;
    for (const r of records) {
      const k = recordKey(r);
      const existing = this.records.get(k);
      if (!existing) {
        this.records.set(k, { ...r });
        added++;
      } else if (timeSourceRank(r.timeSource) > timeSourceRank(existing.timeSource)) {
        this.records.set(k, { ...r });
      }
    }
    return added;
  }
  async getLastCalibration(deviceId: string) {
    const list = this.calibrations.filter((c) => c.deviceId === deviceId).sort((a, b) => a.at - b.at);
    return list[list.length - 1];
  }
  async addCalibration(ev: CalibrationEvent) {
    this.calibrations.push({ ...ev });
  }
  all(): StoredRecord[] {
    return [...this.records.values()].sort((a, b) => a.generation - b.generation || a.index - b.index);
  }
}
