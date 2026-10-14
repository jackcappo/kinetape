/** App-level domain types (device-layer types live in src/device/types.ts). */

export type ThemePref = 'system' | 'light' | 'dark';

export type InjuryType =
  | 'acl_reconstruction'
  | 'acl_nonoperative'
  | 'meniscus_repair'
  | 'meniscectomy'
  | 'mcl_sprain'
  | 'tkr'
  | 'patellar_tendinopathy'
  | 'other';

export interface RecoveryPlan {
  injury: InjuryType;
  side: 'left' | 'right';
  /** Surgery date (or injury date for non-operative), YYYY-MM-DD */
  eventDate: string;
  muscle: string;
  ptName: string;
  notes: string;
}

export interface Goals {
  activeMinutes: number;
  reps: number;
  sessions: number;
}

export interface Settings {
  id: 'app';
  goals: Goals;
  /** minutes after local midnight */
  wakeStartMin: number;
  wakeEndMin: number;
  timeFormat: '12h' | '24h';
  activationUnit: 'percent' | 'permille';
  theme: ThemePref;
  plan: RecoveryPlan;
  /** exercise ids in the daily program */
  program: string[];
  demoAnchor?: number;
  lastDevice?: { kind: 'ble' | 'sim'; id: string; name: string };
  onboarded?: boolean;
}

export interface JournalEntry {
  /** YYYY-MM-DD (local) */
  date: string;
  /** 0–10 */
  pain: number;
  /** 0 none, 1 mild, 2 moderate, 3 severe */
  swelling: number;
  /** knee flexion in degrees (self-reported) */
  romFlexion?: number;
  /** knee extension in degrees (0 = full; negative = lacking extension, positive = hyperextension) */
  romExtension?: number;
  notes: string;
  updatedAt: number;
}

export interface RepResult {
  holdMs: number;
  peakPermille: number;
  good: boolean;
}

export interface SetResult {
  reps: RepResult[];
}

export interface SessionResult {
  id: string;
  exerciseId: string;
  exerciseName: string;
  startedAt: number;
  endedAt: number;
  targetSets: number;
  targetReps: number;
  targetHoldS: number;
  qualityTargetPct: number;
  sets: SetResult[];
  totalReps: number;
  goodReps: number;
  avgHoldS: number;
  avgPeakPct: number;
  maxPeakPct: number;
  completed: boolean;
  calibrated: boolean;
  source: 'device' | 'demo';
  /** calibration (max_raw) in effect, to flag recalibrations on charts */
  calibMaxRaw?: number;
}

export const SWELLING_LABELS = ['None', 'Mild', 'Moderate', 'Severe'] as const;
