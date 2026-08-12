/** Subagent runtime: parent-derived background runs (corresponds to
 * subagent-runtime.ts + sand-subagent-management-tools of the original host).
 * A subagent is a spawned runner instance tracked with lineage (parent agent +
 * originating tool call), steer (interrupt + new prompt) and abort support.
 *
 * The runtime owns bookkeeping (registry, metadata, duplicate suppression,
 * steer queueing before start); the actual run + interrupt semantics are
 * injected by the host (the runner package), so this module stays free of
 * execution concerns. */

import type { MessagingHub } from "./types.js";

export type SubagentStatus = "running" | "completed" | "failed" | "aborted";

export interface SubagentMeta {
  readonly subagentAgentId: string;
  readonly parentAgentId: string;
  readonly subagentType: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly startedAtMs: number;
  readonly lineage?: { readonly parentAgentToolCallId?: string };
}

export interface SubagentRecord {
  readonly subagentType: string;
  readonly title: string;
  readonly startedAtMs: number;
  readonly status: SubagentStatus;
  readonly completedAtMs?: number;
}

export interface SubagentRunHandle {
  /** Interrupt the running subagent and redirect it. Returns true when a live
   * run was steered. */
  steer(prompt: string): boolean;
  /** Abort the running subagent. Returns true when a live run was aborted. */
  abort(): boolean;
}

export interface SubagentRuntimeHost {
  readonly hub: MessagingHub;
  /** The parent agent's conversation id. */
  getConversationId(): string;
  /** Start the subagent's turn loop. The handle is live once the promise
   * resolves; `settled` resolves when the run truly ends (completed, steered
   * to a finish, or aborted). Calls before the handle is live return false
   * and the runtime queues them. */
  runSubagent(params: {
    readonly subagentAgentId: string;
    readonly prompt: string;
  }): Promise<{ readonly handle: SubagentRunHandle; readonly settled: Promise<void> }>;
  /** Notify subscribers that the async-tasks view changed. */
  emitAsyncTasksChanged(): void;
}

export class SubagentRuntime {
  private readonly backgroundSubagentRuns = new Map<string, Promise<void>>();
  private readonly subagentMeta = new Map<string, SubagentMeta>();
  private readonly subagentRegistry = new Map<string, SubagentRecord>();
  private readonly pendingSubagentSteers = new Map<string, string>();
  private readonly liveHandles = new Map<string, SubagentRunHandle>();

  constructor(private readonly host: SubagentRuntimeHost) {}

  /** Dispatch a background subagent run; no-ops when the id is already running. */
  dispatchBackgroundSubagent(params: {
    readonly subagentAgentId: string;
    readonly subagentType: string;
    readonly toolCallId: string;
    readonly prompt: string;
    readonly lineage?: { readonly parentAgentToolCallId?: string };
  }): boolean {
    if (this.backgroundSubagentRuns.has(params.subagentAgentId)) return false;
    const title = params.prompt.split("\n")[0]?.slice(0, 80) ?? params.subagentType;
    const parentAgentId = this.host.getConversationId();
    this.subagentMeta.set(params.subagentAgentId, {
      subagentAgentId: params.subagentAgentId,
      parentAgentId,
      subagentType: params.subagentType,
      toolCallId: params.toolCallId,
      title,
      startedAtMs: Date.now(),
      ...(params.lineage != null ? { lineage: params.lineage } : {}),
    });
    this.subagentRegistry.set(params.subagentAgentId, {
      subagentType: params.subagentType,
      title,
      startedAtMs: Date.now(),
      status: "running",
    });
    const run = (async () => {
      try {
        const { handle, settled } = await this.host.runSubagent({
          subagentAgentId: params.subagentAgentId,
          prompt: params.prompt,
        });
        this.liveHandles.set(params.subagentAgentId, handle);
        // A steer queued before the run started applies first.
        const queuedSteer = this.pendingSubagentSteers.get(params.subagentAgentId);
        if (queuedSteer != null) {
          this.pendingSubagentSteers.delete(params.subagentAgentId);
          handle.steer(queuedSteer);
        }
        await settled;
        this.settle(params.subagentAgentId, "completed");
      } catch (error) {
        console.error(`[messaging] subagent ${params.subagentAgentId} failed`, error);
        this.settle(params.subagentAgentId, "failed");
      }
    })();
    this.backgroundSubagentRuns.set(params.subagentAgentId, run);
    this.host.emitAsyncTasksChanged();
    return true;
  }

  /** Steer a running subagent: interrupts and redirects it. */
  steerSubagent(subagentAgentId: string, prompt: string): boolean {
    const handle = this.liveHandles.get(subagentAgentId);
    if (handle != null && handle.steer(prompt)) return true;
    // Run not live yet: queue the steer for when it starts.
    this.pendingSubagentSteers.set(subagentAgentId, prompt);
    return this.backgroundSubagentRuns.has(subagentAgentId);
  }

  /** Abort a running subagent. */
  abortSubagent(subagentAgentId: string): boolean {
    const handle = this.liveHandles.get(subagentAgentId);
    if (handle != null && handle.abort()) {
      this.settle(subagentAgentId, "aborted");
      return true;
    }
    return false;
  }

  /** Wait for a subagent to finish (used by the parent's await tool). */
  async awaitSubagent(subagentAgentId: string): Promise<void> {
    const run = this.backgroundSubagentRuns.get(subagentAgentId);
    if (run != null) await run;
  }

  list(): readonly SubagentRecord[] {
    return [...this.subagentRegistry.values()];
  }

  getMeta(subagentAgentId: string): SubagentMeta | undefined {
    return this.subagentMeta.get(subagentAgentId);
  }

  isRunning(subagentAgentId: string): boolean {
    return this.subagentRegistry.get(subagentAgentId)?.status === "running";
  }

  private settle(subagentAgentId: string, status: SubagentStatus): void {
    const record = this.subagentRegistry.get(subagentAgentId);
    if (record == null) return;
    // Idempotent: a terminal state (abort won the race) is never overwritten.
    if (record.status !== "running") return;
    this.subagentRegistry.set(subagentAgentId, {
      ...record,
      status,
      ...(status !== "running" ? { completedAtMs: Date.now() } : {}),
    });
    this.liveHandles.delete(subagentAgentId);
    this.backgroundSubagentRuns.delete(subagentAgentId);
    this.host.emitAsyncTasksChanged();
  }
}
