import type { Clock } from "./clock.js";
import { realClock, schedule, type TimerHandle } from "./clock.js";

/** Run lanes, in priority order: user messages always beat agent-to-agent
 * wakeups, which beat background work. */
export type RunLane = "user" | "agent" | "background";

export const RUN_LANE_PRIORITY: readonly RunLane[] = ["user", "agent", "background"];

export interface EnqueueOptions {
  readonly lane: RunLane;
  /** Human/telemetry tag for what queued this run: "user" | "agent" | "automation" | "channel" | "broadcast" | "group" | ... */
  readonly source: string;
  /** Wall-clock instant the triggering input was durably accepted. */
  readonly acceptedAtMs?: number;
  /** Ack-fulfillment token, when this run answers a user send. */
  readonly ackToken?: string;
}

export interface ActiveRunInfo {
  readonly lane: RunLane;
  readonly source: string;
  readonly runtimeMs: number;
  readonly phase: "running" | "watchdog-grace";
  readonly acceptedAtMs?: number;
}

export interface RunQueueDiagnostics {
  readonly agentId: string;
  readonly depthUser: number;
  readonly depthAgent: number;
  readonly depthBackground: number;
  readonly depthTotal: number;
  readonly oldestPendingUserAgeMs?: number;
  readonly active?: ActiveRunInfo;
  readonly zombieCount: number;
}

export interface RunSchedulerOptions {
  /** Time a run may occupy the queue before the watchdog grace window starts. */
  readonly watchdogMs?: number;
  /** Extra time after the watchdog fires before a wedged run is escaped. */
  readonly graceMs?: number;
  readonly clock?: Clock;
  /** Called with every accepted task (queueing telemetry). */
  readonly onAccepted?: (info: {
    agentId: string;
    lane: RunLane;
    source: string;
    position: number;
    depthUser: number;
    depthAgent: number;
    depthBackground: number;
  }) => void;
  /** Called when a wedged run is escaped (watchdog escape telemetry). */
  readonly onEscaped?: (info: { agentId: string; source: string; lane: RunLane }) => void;
}

interface QueuedTask {
  readonly lane: RunLane;
  readonly source: string;
  readonly enqueuedAtMs: number;
  readonly acceptedAtMs?: number;
  readonly ackToken?: string;
  readonly task: () => Promise<void>;
  /** Caller-facing promise: settles when the task settles OR is escaped. */
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  /** Real settlement, resolved only when the task truly finishes; zombies track this. */
  readonly settled: Promise<void>;
  readonly markSettled: () => void;
}

interface ActiveTask {
  readonly item: QueuedTask;
  readonly startedAtMs: number;
  phase: "running" | "watchdog-grace";
  watchdogTimer?: TimerHandle;
  graceTimer?: TimerHandle;
}

interface AgentQueue {
  pendingUser: QueuedTask[];
  pendingAgent: QueuedTask[];
  pendingBackground: QueuedTask[];
  active: ActiveTask | null;
  zombies: Set<Promise<void>>;
}

/**
 * Per-agent exclusive run queue with three priority lanes.
 *
 * - One agent executes at most one task at a time; enqueued tasks are pumped
 *   in lane order (user > agent > background).
 * - A watchdog escapes wedged runs: after `watchdogMs` the run enters a grace
 *   window; if it still has not settled after `graceMs`, the caller-facing
 *   promise is resolved early (so a send can never hang on a wedged turn)
 *   while the run continues as a tracked "zombie". `drain()` still waits for
 *   zombies to actually settle, so teardown never races a live turn.
 */
export class RunScheduler {
  private readonly queues = new Map<string, AgentQueue>();
  private readonly watchdogMs: number;
  private readonly graceMs: number;
  private readonly clock: Clock;
  private readonly onAccepted?: RunSchedulerOptions["onAccepted"];
  private readonly onEscaped?: RunSchedulerOptions["onEscaped"];
  private disposed = false;

  constructor(options: RunSchedulerOptions = {}) {
    this.watchdogMs = options.watchdogMs ?? 120_000;
    this.graceMs = options.graceMs ?? 30_000;
    this.clock = options.clock ?? realClock;
    this.onAccepted = options.onAccepted;
    this.onEscaped = options.onEscaped;
  }

  /** Enqueue one exclusive task for `agentId`. The returned promise settles
   * with the task's own outcome (or early, on a watchdog escape). */
  enqueue(agentId: string, task: () => Promise<void>, options: EnqueueOptions): Promise<void> {
    const queue = this.queueFor(agentId);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let markSettled!: () => void;
    const settled = new Promise<void>((res) => {
      markSettled = res;
    });
    const item: QueuedTask = {
      lane: options.lane,
      source: options.source,
      enqueuedAtMs: this.clock.now(),
      ...(options.acceptedAtMs != null ? { acceptedAtMs: options.acceptedAtMs } : {}),
      ...(options.ackToken != null ? { ackToken: options.ackToken } : {}),
      task,
      promise,
      resolve,
      reject,
      settled,
      markSettled,
    };
    if (item.lane === "user") queue.pendingUser.push(item);
    else if (item.lane === "agent") queue.pendingAgent.push(item);
    else queue.pendingBackground.push(item);

    let pendingAhead =
      queue.pendingUser.length + queue.pendingAgent.length + queue.pendingBackground.length - 1;
    if (item.lane === "user") pendingAhead = queue.pendingUser.length - 1;
    else if (item.lane === "agent") pendingAhead = queue.pendingUser.length + queue.pendingAgent.length - 1;

    this.onAccepted?.({
      agentId,
      lane: item.lane,
      source: item.source,
      position: (queue.active != null ? 1 : 0) + pendingAhead,
      depthUser: queue.pendingUser.length,
      depthAgent: queue.pendingAgent.length,
      depthBackground: queue.pendingBackground.length,
    });
    // Start pumping on a microtask so enqueue returns before the task runs.
    void Promise.resolve().then(() => this.pump(agentId));
    return promise;
  }

  /** Resolves once every task known to the queue AT CALL TIME — running,
   * pending, AND escaped-but-still-running zombies — has actually settled. */
  async drain(agentId: string): Promise<void> {
    const queue = this.queues.get(agentId);
    if (queue == null) return;
    const snapshot: Promise<void>[] = [
      ...(queue.active != null ? [queue.active.item.settled] : []),
      ...queue.zombies,
      ...queue.pendingUser.map((i) => i.promise),
      ...queue.pendingAgent.map((i) => i.promise),
      ...queue.pendingBackground.map((i) => i.promise),
    ];
    await Promise.allSettled(snapshot);
  }

  getActiveLane(agentId: string): RunLane | undefined {
    return this.queues.get(agentId)?.active?.item.lane;
  }

  getDiagnostics(): readonly RunQueueDiagnostics[] {
    const now = this.clock.now();
    const out: RunQueueDiagnostics[] = [];
    for (const [agentId, queue] of this.queues) {
      const depthUser = queue.pendingUser.length;
      const depthAgent = queue.pendingAgent.length;
      const depthBackground = queue.pendingBackground.length;
      const active = queue.active;
      if (depthUser === 0 && depthAgent === 0 && depthBackground === 0 && active == null) {
        continue;
      }
      const oldestUser = queue.pendingUser[0];
      out.push({
        agentId,
        depthUser,
        depthAgent,
        depthBackground,
        depthTotal: depthUser + depthAgent + depthBackground + (active != null ? 1 : 0),
        ...(oldestUser != null ? { oldestPendingUserAgeMs: now - oldestUser.enqueuedAtMs } : {}),
        ...(active != null
          ? {
              active: {
                lane: active.item.lane,
                source: active.item.source,
                runtimeMs: now - active.startedAtMs,
                phase: active.phase,
                ...(active.item.acceptedAtMs != null
                  ? { acceptedAtMs: active.item.acceptedAtMs }
                  : {}),
              },
            }
          : {}),
        zombieCount: queue.zombies.size,
      });
    }
    return out;
  }

  /** Stops all timers. Pending tasks are neither started nor rejected. */
  dispose(): void {
    this.disposed = true;
    for (const queue of this.queues.values()) {
      queue.active?.watchdogTimer?.dispose();
      queue.active?.graceTimer?.dispose();
      queue.active = null;
    }
  }

  private queueFor(agentId: string): AgentQueue {
    const existing = this.queues.get(agentId);
    if (existing != null) return existing;
    const created: AgentQueue = {
      pendingUser: [],
      pendingAgent: [],
      pendingBackground: [],
      active: null,
      zombies: new Set(),
    };
    this.queues.set(agentId, created);
    return created;
  }

  private pump(agentId: string): void {
    if (this.disposed) return;
    const queue = this.queues.get(agentId);
    if (queue == null || queue.active != null) return;
    let next: QueuedTask | undefined;
    if (queue.pendingUser.length > 0) next = queue.pendingUser.shift();
    else if (queue.pendingAgent.length > 0) next = queue.pendingAgent.shift();
    else next = queue.pendingBackground.shift();
    if (next == null) return;

    const startedAtMs = this.clock.monotonicNow();
    const active: ActiveTask = {
      item: next,
      startedAtMs,
      phase: "running",
    };
    queue.active = active;
    this.armWatchdog(agentId, active);

    const settle = () => {
      if (queue.active === active) {
        queue.active = null;
      } else {
        // Escaped earlier: stop tracking the zombie once it truly settles.
        queue.zombies.delete(active.item.settled);
      }
      active.watchdogTimer?.dispose();
      active.graceTimer?.dispose();
      next.markSettled();
      void Promise.resolve().then(() => this.pump(agentId));
    };
    void Promise.resolve()
      .then(() => next.task())
      .then(
        () => {
          next.resolve();
          settle();
        },
        (error: unknown) => {
          next.reject(error);
          settle();
        },
      );
  }

  private armWatchdog(agentId: string, active: ActiveTask): void {
    const { item } = active;
    active.watchdogTimer = schedule(this.watchdogMs, () => {
      if (this.disposed || active.phase !== "running") return;
      active.phase = "watchdog-grace";
      active.graceTimer = schedule(this.graceMs, () => {
        if (this.disposed || active.phase !== "watchdog-grace") return;
        // Escape: release the caller, keep tracking the zombie.
        active.phase = "watchdog-grace";
        const queue = this.queues.get(agentId);
        queue?.zombies.add(item.settled);
        if (queue?.active === active) queue.active = null;
        item.resolve();
        this.onEscaped?.({ agentId, source: item.source, lane: item.lane });
      });
    });
  }
}
