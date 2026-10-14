import { db, loadSettings, saveSettings } from '../db/db';
import { SimulatedTransport } from '../device/SimulatedTransport';
import { DEMO_DEVICE_ID, DEMO_DEVICE_NAME, DEMO_REST_RAW, generateDemo } from './generate';
import { browserTzOffsetMin } from '../protocol/codec';

/** Seed the database with the demo history (idempotent per anchor). Returns the anchor. */
export async function ensureDemoSeeded(force = false): Promise<number> {
  const settings = await loadSettings();
  if (settings.demoAnchor && !force) {
    const cur = await db.cursors.get(DEMO_DEVICE_ID);
    if (cur) return settings.demoAnchor;
  }
  const anchor = Date.now();
  const ds = generateDemo(anchor, anchor);
  await db.transaction('rw', [db.records, db.cursors, db.calibrations, db.sessions, db.journal, db.settings], async () => {
    await db.records.where('deviceId').equals(DEMO_DEVICE_ID).delete();
    await db.calibrations.where('deviceId').equals(DEMO_DEVICE_ID).delete();
    await db.sessions.filter((s) => s.source === 'demo').delete();
    await db.records.bulkPut(ds.stored);
    await db.calibrations.bulkAdd(ds.calibrations);
    await db.sessions.bulkPut(ds.sessions);
    // don't overwrite entries the user typed
    const existing = new Set(await db.journal.toCollection().primaryKeys());
    await db.journal.bulkPut(ds.journal.filter((j) => !existing.has(j.date)));
    await db.cursors.put({ deviceId: DEMO_DEVICE_ID, generation: 0, cursor: ds.splitIndex, name: DEMO_DEVICE_NAME, lastSyncAt: anchor - 26 * 3600 * 1000 });
    await saveSettings({ ...settings, demoAnchor: anchor, plan: { ...settings.plan, eventDate: ds.surgeryDate, injury: 'acl_reconstruction' } });
  });
  return anchor;
}

/** Build a simulated KineTape whose log continues the demo dataset up to now. */
export function createDemoTransport(anchor: number): SimulatedTransport {
  const now = Date.now();
  const ds = generateDemo(anchor, now);
  return new SimulatedTransport({
    deviceId: DEMO_DEVICE_ID,
    name: DEMO_DEVICE_NAME,
    bootId: ds.currentBoot.bootId,
    uptimeS: Math.floor((now - ds.currentBoot.bootStartMs) / 1000),
    restRaw: DEMO_REST_RAW,
    maxRaw: ds.maxRaw,
    calibrated: true,
    thresholdPct: 30,
    tzOffsetMin: browserTzOffsetMin(),
    history: { firstIndex: 0, records: ds.log },
    historyPacingMs: 3,
    seed: now & 0xffff,
  });
}
