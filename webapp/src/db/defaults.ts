import type { Settings } from '../types';
import { toDateKey } from '../analytics/time';

export function defaultSettings(): Settings {
  const d = new Date();
  d.setDate(d.getDate() - 21);
  return {
    id: 'app',
    goals: { activeMinutes: 60, reps: 200, sessions: 2 },
    wakeStartMin: 7 * 60,
    wakeEndMin: 22 * 60,
    timeFormat: '12h',
    activationUnit: 'percent',
    theme: 'system',
    plan: {
      injury: 'acl_reconstruction',
      side: 'right',
      eventDate: toDateKey(d),
      muscle: 'Quadriceps (vastus medialis)',
      ptName: '',
      notes: '',
    },
    program: ['quad_sets', 'straight_leg_raise', 'short_arc_quads', 'terminal_knee_extension', 'wall_sit'],
  };
}
