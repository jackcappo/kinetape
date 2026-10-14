import { describe, expect, it } from 'vitest';
import { recordsCsv, toCsv, validateBackup } from './backup';

describe('CSV / backup helpers', () => {
  it('escapes CSV cells', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'he said "hi"'], [1, undefined]])).toBe('a,b\r\n"x,y","he said ""hi"""\r\n1,\r\n');
  });
  it('exports minute records with percent values and unknown-time rows', () => {
    const csv = recordsCsv([
      { deviceId: 'd', generation: 0, index: 1, t: 60, bootId: 2, flags: 2, sensorOk: true, mean: 250, peak: 905, reps: 3, activeSeconds: 12, timeSource: 'unknown' },
      { deviceId: 'd', generation: 0, index: 0, t: 1760000000, bootId: 2, flags: 3, sensorOk: true, mean: 0, peak: 15, reps: 0, activeSeconds: 0, epoch: 1760000000, timeSource: 'device' },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',unknown,d,0,1,2,1,25.0,90.5,3,12');
    expect(lines[2].startsWith('2025-10-09T08:53:20.000Z')).toBe(true);
  });
  it('validates backup files', () => {
    expect(() => validateBackup({})).toThrow(/Not a KineTape backup/);
    expect(() => validateBackup({ format: 'kinetape-backup', version: 99 })).toThrow(/Unsupported/);
    const ok = { format: 'kinetape-backup', version: 1, exportedAt: '', records: [], cursors: [], calibrations: [], sessions: [], journal: [], settings: [] };
    expect(validateBackup(ok)).toBe(ok);
  });
});
