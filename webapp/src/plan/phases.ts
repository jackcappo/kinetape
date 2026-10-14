import type { InjuryType } from '../types';
import { daysBetween } from '../analytics/time';

export interface Phase {
  title: string;
  /** inclusive start week, exclusive end week (since surgery/injury) */
  fromWeek: number;
  toWeek: number;
  goals: string[];
}

export const INJURY_LABELS: Record<InjuryType, string> = {
  acl_reconstruction: 'ACL reconstruction',
  acl_nonoperative: 'ACL tear (non-operative)',
  meniscus_repair: 'Meniscus repair',
  meniscectomy: 'Partial meniscectomy',
  mcl_sprain: 'MCL sprain',
  tkr: 'Total knee replacement',
  patellar_tendinopathy: 'Patellar tendinopathy',
  other: 'Other knee / leg injury',
};

export const isSurgical = (i: InjuryType) => ['acl_reconstruction', 'meniscus_repair', 'meniscectomy', 'tkr'].includes(i);

/**
 * GENERIC, typical-timeline milestones compiled for orientation only.
 * Real protocols vary by surgeon, graft, concomitant injuries and individual progress.
 */
const ACL: Phase[] = [
  { title: 'Protection & early motion', fromWeek: 0, toWeek: 2, goals: ['Control pain and swelling', 'Full knee extension (straight)', 'Quad activation: quad sets, straight-leg raises', 'Walking with aids as instructed'] },
  { title: 'Restore motion & gait', fromWeek: 2, toWeek: 6, goals: ['Flexion toward ~120°', 'Walk without crutches when cleared', 'Closed-chain strengthening (mini squats, TKEs)', 'Balance work'] },
  { title: 'Strength & control', fromWeek: 6, toWeek: 12, goals: ['Progressive strengthening', 'Single-leg control', 'Stationary bike / low-impact cardio'] },
  { title: 'Advanced strengthening & running prep', fromWeek: 12, toWeek: 24, goals: ['Running progression when cleared (often ~3–4 months)', 'Plyometric basics', 'Strength symmetry tracking'] },
  { title: 'Return to sport', fromWeek: 24, toWeek: 52, goals: ['Agility and sport-specific drills', 'Return-to-sport testing with your clinician (often 9+ months)'] },
];

const NONOP: Phase[] = [
  { title: 'Calm the knee', fromWeek: 0, toWeek: 2, goals: ['Reduce swelling', 'Restore extension', 'Quad activation'] },
  { title: 'Motion & strength', fromWeek: 2, toWeek: 8, goals: ['Full range of motion', 'Closed-chain strengthening', 'Normal walking'] },
  { title: 'Neuromuscular training', fromWeek: 8, toWeek: 16, goals: ['Balance and hop control', 'Progressive loading'] },
  { title: 'Return to activity', fromWeek: 16, toWeek: 40, goals: ['Activity-specific training', 'Clinician-guided return decision'] },
];

const MENISCUS_REPAIR: Phase[] = [
  { title: 'Protect the repair', fromWeek: 0, toWeek: 6, goals: ['Weight-bearing and bend limits as instructed', 'Quad activation', 'Swelling control'] },
  { title: 'Restore motion', fromWeek: 6, toWeek: 12, goals: ['Gradual flexion gains', 'Normal gait', 'Closed-chain strengthening'] },
  { title: 'Strengthening', fromWeek: 12, toWeek: 20, goals: ['Progressive loading', 'Balance'] },
  { title: 'Return to activity', fromWeek: 20, toWeek: 36, goals: ['Running / sport progression when cleared'] },
];

const SHORT: Phase[] = [
  { title: 'Settle & activate', fromWeek: 0, toWeek: 2, goals: ['Swelling control', 'Quad activation', 'Restore motion'] },
  { title: 'Strength & function', fromWeek: 2, toWeek: 6, goals: ['Progressive strengthening', 'Normal gait and stairs'] },
  { title: 'Return to activity', fromWeek: 6, toWeek: 12, goals: ['Activity-specific progression when cleared'] },
];

const TKR: Phase[] = [
  { title: 'Early recovery', fromWeek: 0, toWeek: 3, goals: ['Walking with aids', 'Extension and flexion exercises', 'Swelling control'] },
  { title: 'Motion & independence', fromWeek: 3, toWeek: 8, goals: ['Flexion toward ~110°+', 'Reduce walking aids', 'Strengthening'] },
  { title: 'Strength & endurance', fromWeek: 8, toWeek: 16, goals: ['Longer walks, bike', 'Balance and stairs'] },
  { title: 'Long-term function', fromWeek: 16, toWeek: 52, goals: ['Continued strengthening', 'Return to low-impact activities'] },
];

const TENDON: Phase[] = [
  { title: 'Pain management & isometrics', fromWeek: 0, toWeek: 4, goals: ['Isometric holds (e.g. wall sits) for pain relief', 'Load modification'] },
  { title: 'Isotonic loading', fromWeek: 4, toWeek: 10, goals: ['Slow heavy strengthening'] },
  { title: 'Energy storage', fromWeek: 10, toWeek: 16, goals: ['Gradual plyometrics'] },
  { title: 'Return to sport', fromWeek: 16, toWeek: 26, goals: ['Sport-specific loading'] },
];

export function phasesFor(i: InjuryType): Phase[] {
  switch (i) {
    case 'acl_reconstruction':
      return ACL;
    case 'acl_nonoperative':
      return NONOP;
    case 'meniscus_repair':
      return MENISCUS_REPAIR;
    case 'tkr':
      return TKR;
    case 'patellar_tendinopathy':
      return TENDON;
    default:
      return SHORT;
  }
}

/** Week number (1-based: days 0–6 = week 1). */
export function weekSince(eventDate: string, today: string): { week: number; days: number } {
  const days = daysBetween(eventDate, today);
  return { days, week: Math.floor(days / 7) + 1 };
}

export function currentPhaseIndex(phases: Phase[], days: number): number {
  const weeks = days / 7;
  const i = phases.findIndex((p) => weeks >= p.fromWeek && weeks < p.toWeek);
  if (i >= 0) return i;
  return weeks < 0 ? -1 : phases.length - 1;
}
