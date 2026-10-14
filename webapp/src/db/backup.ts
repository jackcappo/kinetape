import type { StoredRecord } from '../device/types';
import type { JournalEntry, SessionResult, Settings } from '../types';
import { db, type CalibrationRow } from './db';
import type { CursorState } from '../device/types';

export const BACKUP_FORMAT = 'kinetape-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  records: StoredRecord[];
  cursors: CursorState[];
  calibrations: CalibrationRow[];
  sessions: SessionResult[];
  journal: JournalEntry[];
  settings: Settings[];
}

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

const localIso = (epochS: number) => {
  const d = new Date(epochS * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function recordsCsv(records: StoredRecord[]): string {
  const sorted = [...records].sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0) || a.index - b.index);
  return toCsv(
    ['utc_iso', 'local_time', 'time_source', 'device_id', 'generation', 'index', 'boot_id', 'sensor_ok', 'mean_activation_pct', 'peak_activation_pct', 'reps', 'active_seconds'],
    sorted.map((r) => [
      r.epoch !== undefined ? new Date(r.epoch * 1000).toISOString() : '',
      r.epoch !== undefined ? localIso(r.epoch) : '',
      r.timeSource,
      r.deviceId,
      r.generation,
      r.index,
      r.bootId,
      r.sensorOk ? 1 : 0,
      (r.mean / 10).toFixed(1),
      (r.peak / 10).toFixed(1),
      r.reps,
      r.activeSeconds,
    ]),
  );
}

export function sessionsCsv(sessions: SessionResult[]): string {
  return toCsv(
    ['started_local', 'ended_local', 'exercise', 'target_sets', 'target_reps', 'target_hold_s', 'quality_target_pct', 'total_reps', 'good_reps', 'avg_hold_s', 'avg_peak_pct', 'max_peak_pct', 'completed', 'calibrated', 'source'],
    [...sessions]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((s) => [
        localIso(s.startedAt / 1000),
        localIso(s.endedAt / 1000),
        s.exerciseName,
        s.targetSets,
        s.targetReps,
        s.targetHoldS,
        s.qualityTargetPct,
        s.totalReps,
        s.goodReps,
        s.avgHoldS,
        s.avgPeakPct,
        s.maxPeakPct,
        s.completed ? 1 : 0,
        s.calibrated ? 1 : 0,
        s.source,
      ]),
  );
}

export function journalCsv(journal: JournalEntry[]): string {
  return toCsv(
    ['date', 'pain_0_10', 'swelling_0_3', 'knee_flexion_deg', 'knee_extension_deg', 'notes'],
    [...journal].sort((a, b) => (a.date < b.date ? -1 : 1)).map((j) => [j.date, j.pain, j.swelling, j.romFlexion, j.romExtension, j.notes]),
  );
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function exportBackup(): Promise<Backup> {
  const [records, cursors, calibrations, sessions, journal, settings] = await Promise.all([
    db.records.toArray(),
    db.cursors.toArray(),
    db.calibrations.toArray(),
    db.sessions.toArray(),
    db.journal.toArray(),
    db.settings.toArray(),
  ]);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), records, cursors, calibrations, sessions, journal, settings };
}

/** Validate a parsed backup object; throws with a readable message. */
export function validateBackup(x: unknown): Backup {
  const b = x as Partial<Backup>;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new Error('Not a KineTape backup file.');
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) throw new Error(`Unsupported backup version ${b.version}.`);
  for (const k of ['records', 'cursors', 'calibrations', 'sessions', 'journal', 'settings'] as const)
    if (!Array.isArray(b[k])) throw new Error(`Backup is missing "${k}".`);
  return b as Backup;
}

/** Import (merge or replace). Records dedupe by their (deviceId, generation, index) key. */
export async function importBackup(b: Backup, mode: 'merge' | 'replace') {
  await db.transaction('rw', [db.records, db.cursors, db.calibrations, db.sessions, db.journal, db.settings], async () => {
    if (mode === 'replace') await Promise.all([db.records.clear(), db.cursors.clear(), db.calibrations.clear(), db.sessions.clear(), db.journal.clear(), db.settings.clear()]);
    await db.records.bulkPut(b.records);
    // keep the further-ahead cursor when merging
    for (const c of b.cursors) {
      const ex = mode === 'merge' ? await db.cursors.get(c.deviceId) : undefined;
      if (!ex || ex.generation < c.generation || (ex.generation === c.generation && ex.cursor < c.cursor)) await db.cursors.put(c);
    }
    await db.calibrations.bulkPut(b.calibrations);
    await db.sessions.bulkPut(b.sessions);
    await db.journal.bulkPut(b.journal);
    if (mode === 'replace' || !(await db.settings.get('app'))) await db.settings.bulkPut(b.settings);
  });
}
