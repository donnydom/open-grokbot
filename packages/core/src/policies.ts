import type { Clock, TimerHandle } from "./clock.js";
import { schedule } from "./clock.js";

/** A retry/backoff policy: computes wait delays for attempt numbers. */
export interface RetryPolicy {
  readonly name: string;
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Backoff factor applied per attempt (>= 1). */
  readonly backoffFactor?: number;
  /** Wait for attempt `attempt` (1-based); aborts on `signal`. */
  schedule(attempt: number, signal?: AbortSignal): { elapsed: Promise<void>; dispose(): void };
}

export function createRetryPolicy(options: {
  name: string;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor?: number;
}): RetryPolicy {
  const factor = options.backoffFactor ?? 2;
  return {
    name: options.name,
    maxAttempts: options.maxAttempts,
    initialDelayMs: options.initialDelayMs,
    maxDelayMs: options.maxDelayMs,
    backoffFactor: factor,
    schedule(attempt: number, signal?: AbortSignal) {
      const capped = Math.min(attempt, 32); // avoid exponent overflow
      const delay = Math.min(
        options.initialDelayMs * Math.pow(factor, capped - 1),
        options.maxDelayMs,
      );
      return waitForDelay(delay, signal);
    },
  };
}

/** A deadline policy: runs `work` and rejects with DeadlineExceededError after timeoutMs. */
export class DeadlineExceededError extends Error {
  readonly code = "deadline_exceeded";
  constructor(policyName: string) {
    super(`Deadline exceeded for ${policyName}`);
    this.name = "DeadlineExceededError";
  }
}

export interface DeadlinePolicy {
  readonly name: string;
  readonly timeoutMs: number;
  run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createDeadlinePolicy(options: {
  name: string;
  timeoutMs: number;
  clock?: Clock;
}): DeadlinePolicy {
  return {
    name: options.name,
    timeoutMs: options.timeoutMs,
    async run(work, signal) {
      if (signal?.aborted) throw abortReason(signal);
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      let timeout!: TimerHandle;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = schedule(options.timeoutMs, () => {
          controller.abort();
          reject(new DeadlineExceededError(options.name));
        });
      });
      try {
        return await Promise.race([work(controller.signal), timeoutPromise]);
      } finally {
        timeout.dispose();
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
  };
}

/** An idle watchdog: `kick()` resets the window; if idleMs elapses without a
 * kick, the callback fires (used to detect stalled streams). */
export interface IdleWatchdogPolicy {
  readonly name: string;
  readonly idleMs: number;
  arm(onIdle: () => void): { kick(): void; dispose(): void };
}

export function createIdleWatchdogPolicy(options: {
  name: string;
  idleMs: number;
}): IdleWatchdogPolicy {
  return {
    name: options.name,
    idleMs: options.idleMs,
    arm(onIdle) {
      let timer: TimerHandle | undefined;
      let disposed = false;
      const armTimer = () => {
        timer?.dispose();
        if (disposed) return;
        timer = schedule(options.idleMs, () => {
          if (disposed) return;
          disposed = true;
          onIdle();
        });
      };
      armTimer();
      return {
        kick() {
          if (!disposed) armTimer();
        },
        dispose() {
          disposed = true;
          timer?.dispose();
        },
      };
    },
  };
}

/** A polling policy: run `work` every intervalMs (used for heartbeats). */
export interface PollingPolicy {
  readonly name: string;
  readonly intervalMs: number;
  start(work: () => void | Promise<void>): TimerHandle;
}

export function createPollingPolicy(options: {
  name: string;
  intervalMs: number;
}): PollingPolicy {
  return {
    name: options.name,
    intervalMs: options.intervalMs,
    start(work) {
      let disposed = false;
      let timer: TimerHandle | undefined;
      const tick = async () => {
        if (disposed) return;
        try {
          await work();
        } catch {
          // polling work must never throw into the timer
        }
        if (disposed) return;
        timer = schedule(options.intervalMs, tick);
      };
      timer = schedule(options.intervalMs, tick);
      return {
        dispose() {
          disposed = true;
          timer?.dispose();
        },
      };
    },
  };
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function waitForDelay(
  delayMs: number,
  signal?: AbortSignal,
): { elapsed: Promise<void>; dispose(): void } {
  if (signal?.aborted) {
    return {
      elapsed: Promise.reject(abortReason(signal)),
      dispose() {},
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      if (timer != null) clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Deliberately NOT unref'd: a pending retry/backoff wait must keep the
    // process (and a test runner) alive until it settles.
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
  });
  return {
    elapsed,
    dispose() {
      if (timer != null) clearTimeout(timer);
    },
  };
}
