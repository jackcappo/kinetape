export interface ExercisePreset {
  id: string;
  name: string;
  short: string;
  sets: number;
  reps: number;
  /** target hold per rep (s) */
  holdS: number;
  /** rest between sets (s) */
  restS: number;
  /** contraction quality target, % of calibrated max */
  qualityTargetPct: number;
  /** relax time between reps the coach suggests (s) */
  relaxS: number;
  instructions: string[];
  cue: string;
}

/** Generic, commonly prescribed knee-rehab exercises. Always follow your PT's prescription. */
export const EXERCISES: ExercisePreset[] = [
  {
    id: 'quad_sets',
    name: 'Quad sets',
    short: 'Tighten the thigh, press the knee down',
    sets: 3,
    reps: 10,
    holdS: 5,
    restS: 45,
    qualityTargetPct: 50,
    relaxS: 3,
    instructions: [
      'Sit or lie with your leg straight and a small towel roll under the knee.',
      'Tighten the muscle on top of your thigh, pressing the back of the knee into the towel.',
      'Hold, then fully relax between reps.',
    ],
    cue: 'Squeeze and press the knee down',
  },
  {
    id: 'straight_leg_raise',
    name: 'Straight-leg raises',
    short: 'Lock the knee, lift the leg',
    sets: 3,
    reps: 10,
    holdS: 3,
    restS: 60,
    qualityTargetPct: 45,
    relaxS: 3,
    instructions: [
      'Lie on your back, other knee bent with the foot flat.',
      'Tighten the thigh first so the knee is straight, then lift the leg to the height of the other knee.',
      'Hold briefly, lower slowly, relax.',
    ],
    cue: 'Tighten, then lift',
  },
  {
    id: 'short_arc_quads',
    name: 'Short-arc quads',
    short: 'Straighten the knee over a roll',
    sets: 3,
    reps: 12,
    holdS: 3,
    restS: 45,
    qualityTargetPct: 45,
    relaxS: 2,
    instructions: [
      'Lie with a firm roll (e.g. a coffee can wrapped in a towel) under the knee.',
      'Straighten the knee fully by lifting the heel, keeping the back of the knee on the roll.',
      'Hold at full extension, lower slowly.',
    ],
    cue: 'Lift the heel, straighten fully',
  },
  {
    id: 'terminal_knee_extension',
    name: 'Terminal knee extension',
    short: 'Band behind the knee, straighten',
    sets: 3,
    reps: 15,
    holdS: 2,
    restS: 45,
    qualityTargetPct: 55,
    relaxS: 2,
    instructions: [
      'Stand with a resistance band looped behind the knee and anchored in front of you.',
      'Start with the knee slightly bent, then straighten it against the band by tightening the thigh.',
      'Hold, then slowly return.',
    ],
    cue: 'Push the knee back into the band',
  },
  {
    id: 'wall_sit',
    name: 'Wall sits',
    short: 'Back on the wall, partial squat hold',
    sets: 3,
    reps: 1,
    holdS: 30,
    restS: 60,
    qualityTargetPct: 40,
    relaxS: 5,
    instructions: [
      'Stand with your back against a wall, feet shoulder-width and about a foot in front.',
      'Slide down only as far as your PT has cleared (often a shallow bend early on).',
      'Hold with weight even on both legs, then slide back up.',
    ],
    cue: 'Hold steady, even weight',
  },
];

export const exerciseById = (id: string) => EXERCISES.find((e) => e.id === id);
