import Dexie, { type Table } from 'dexie';
import type { CalibrationEvent, CursorState, StoredRecord, SyncStore } from '../device/types';
import { timeSourceRank } from '../device/types';
import type { JournalEntry, SessionResult, Settings } from '../types';
import { defaultSettings } from './defaults';

export type CalibrationRow = CalibrationEvent & { id?: number };

export class KineTapeDB extends Dexie {
  records!: Table<StoredRecord, [string, number, number]>;
  cursors!: Table<CursorState, string>;
  calibrations!: Table<CalibrationRow, number>;
  sessions!: Table<SessionResult, string>;
  journal!: Table<JournalEntry, string>;
  settings!: Table<Settings, string>;

  constructor(name = 'kinetape') {
    super(name);
    this.version(1).stores({
      records: '[deviceId+generation+index], epoch, deviceId',
      cursors: 'deviceId',
      calibrations: '++id, deviceId, at',
      sessions: 'id, startedAt, exerciseId',
      journal: 'date',
      settings: 'id',
    });
  }
}

export const db = new KineTapeDB();

/** Dexie-backed SyncStore used by DeviceClient in the app. */
export class DexieSyncStore implements SyncStore {
  constructor(private d: KineTapeDB = db) {}

  getCursor(deviceId: string) {
    return this.d.cursors.get(deviceId);
  }

  async setCursor(state: CursorState) {
    await this.d.cursors.put(state);
  }

  async upsertRecords(records: StoredRecord[]) {
    if (!records.length) return 0;
    return this.d.transaction('rw', this.d.records, async () => {
      const keys = records.map((r) => [r.deviceId, r.generation, r.index] as [string, number, number]);
      const existing = await this.d.records.bulkGet(keys);
      const toPut: StoredRecord[] = [];
      let added = 0;
      records.forEach((r, i) => {
        const ex = existing[i];
        if (!ex) {
          added++;
          toPut.push(r);
        } else if (timeSourceRank(r.timeSource) > timeSourceRank(ex.timeSource)) toPut.push(r);
      });
      if (toPut.length) await this.d.records.bulkPut(toPut);
      return added;
    });
  }

  async getLastCalibration(deviceId: string) {
    const list = await this.d.calibrations.where('deviceId').equals(deviceId).sortBy('at');
    return list[list.length - 1];
  }

  async addCalibration(ev: CalibrationEvent) {
    await this.d.calibrations.add({ ...ev });
  }
}

export async function loadSettings(): Promise<Settings> {
  const s = await db.settings.get('app');
  if (!s) return defaultSettings();
  // merge defaults for forward compatibility
  const d = defaultSettings();
  return { ...d, ...s, goals: { ...d.goals, ...s.goals }, plan: { ...d.plan, ...s.plan } };
}

export async function saveSettings(s: Settings) {
  await db.settings.put(s);
}

export async function recordsBetween(fromEpochS: number, toEpochS: number): Promise<StoredRecord[]> {
  return db.records.where('epoch').between(fromEpochS, toEpochS, true, false).toArray();
}

export async function clearAllData() {
  await db.transaction('rw', [db.records, db.cursors, db.calibrations, db.sessions, db.journal, db.settings], async () => {
    await Promise.all([
      db.records.clear(),
      db.cursors.clear(),
      db.calibrations.clear(),
      db.sessions.clear(),
      db.journal.clear(),
      db.settings.clear(),
    ]);
  });
}
