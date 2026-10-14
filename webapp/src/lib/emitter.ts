/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void {
    let set = this.handlers[event];
    if (!set) {
      set = new Set();
      this.handlers[event] = set;
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers[event];
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[emitter] handler for ${String(event)} threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers = {};
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
