/**
 * Turns the LIVE stream into discrete contractions (reps) using the device's own
 * `contracting` flag (firmware hysteresis), measuring hold time and peak activation.
 * Mirrors the firmware rule: a contraction shorter than 200 ms is not a rep.
 */
export interface LiveSample {
  uptimeMs: number;
  activationPermille: number;
  contracting: boolean;
}

export interface RepEvent {
  startMs: number;
  endMs: number;
  holdMs: number;
  peakPermille: number;
}

export const MIN_REP_MS = 200;

export class RepTracker {
  private active = false;
  private startMs = 0;
  private lastMs = 0;
  private peak = 0;

  /** Feed one LIVE sample; returns a RepEvent when a contraction ends. */
  push(s: LiveSample): RepEvent | null {
    // uptime going backwards (device reboot / wrap) resets state
    if (s.uptimeMs < this.lastMs) this.reset();
    this.lastMs = s.uptimeMs;
    if (s.contracting) {
      if (!this.active) {
        this.active = true;
        this.startMs = s.uptimeMs;
        this.peak = 0;
      }
      this.peak = Math.max(this.peak, s.activationPermille);
      return null;
    }
    if (this.active) {
      this.active = false;
      const holdMs = s.uptimeMs - this.startMs;
      if (holdMs >= MIN_REP_MS) return { startMs: this.startMs, endMs: s.uptimeMs, holdMs, peakPermille: this.peak };
    }
    return null;
  }

  /** Current contraction in progress (for live hold timers). */
  current(nowMs: number): { holdMs: number; peakPermille: number } | null {
    return this.active ? { holdMs: nowMs - this.startMs, peakPermille: this.peak } : null;
  }

  get isContracting() {
    return this.active;
  }

  reset() {
    this.active = false;
    this.peak = 0;
    this.startMs = 0;
    this.lastMs = 0;
  }
}
