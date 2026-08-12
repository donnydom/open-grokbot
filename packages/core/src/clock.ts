/** Injectable time surface, so policies and schedulers can be driven by a
 * deterministic clock in tests. Mirrors the design used by the original
 * platform's scheduling layer. */
export interface Clock {
  now(): number;
  monotonicNow(): number;
}

/** Production clock: wall time via Date.now(), monotonic via performance.now(). */
export const realClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
};

/** Deterministic clock for tests: advance time manually. */
export class ManualClock implements Clock {
  private wall = 0;
  private mono = 0;

  now(): number {
    return this.wall;
  }

  monotonicNow(): number {
    return this.mono;
  }

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
}

/** A cancellable timer handle. */
export interface TimerHandle {
  dispose(): void;
}

export function schedule(delayMs: number, fn: () => void): TimerHandle {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError("delayMs must be a finite non-negative number");
  }
  let active = true;
  const timer = globalThis.setTimeout(() => {
    if (!active) return;
    active = false;
    fn();
  }, delayMs);
  timer.unref?.();
  return {
    dispose() {
      if (!active) return;
      active = false;
      globalThis.clearTimeout(timer);
    },
  };
}
