/**
 * Cloud agent bridge (BackgroundComposer equivalent).
 *
 * Reconstructed from the original's cloud-agents extension: local agents hold
 * a `CloudAgent` tool that bridges to a background agent running in the
 * provider backend (cursor.com BackgroundComposer). The bridge supports
 * launch / reply / cancel / rename plus status polling for file changes and
 * PR state.
 *
 * Timing constants mirror the original:
 * - poll every 10s while a launch is in flight
 * - 30s RPC timeout
 * - 5h total runtime cap
 * - rate-limit retry: 60s ± 25% jitter
 */

export interface CloudAgentLaunchRequest {
  readonly localAgentId: string;
  readonly prompt: string;
  readonly cwd?: string;
}

export interface CloudAgentHandle {
  readonly cloudAgentId: string;
}

export interface CloudAgentStatus {
  readonly state: "pending" | "running" | "done" | "failed" | "cancelled";
  readonly filesChanged?: string[];
  readonly prUrl?: string;
  readonly error?: string;
}

export interface CloudAgentBackend {
  launch(request: CloudAgentLaunchRequest, signal: AbortSignal): Promise<CloudAgentHandle>;
  reply(cloudAgentId: string, text: string, signal: AbortSignal): Promise<void>;
  cancel(cloudAgentId: string, signal: AbortSignal): Promise<void>;
  rename(cloudAgentId: string, name: string, signal: AbortSignal): Promise<void>;
  status(cloudAgentId: string, signal: AbortSignal): Promise<CloudAgentStatus>;
  exportTranscript(cloudAgentId: string, signal: AbortSignal): Promise<unknown>;
}

export const CLOUD_POLL_INTERVAL_MS = 10_000;
export const CLOUD_RPC_TIMEOUT_MS = 30_000;
export const CLOUD_RUNTIME_CAP_MS = 5 * 60 * 60 * 1000;
export const CLOUD_RATE_LIMIT_BASE_MS = 60_000;
export const CLOUD_RATE_LIMIT_JITTER = 0.25;

export class CloudRpcTimeoutError extends Error {
  constructor() {
    super(`cloud RPC timed out after ${CLOUD_RPC_TIMEOUT_MS}ms`);
    this.name = "CloudRpcTimeoutError";
  }
}

export class CloudRuntimeCapError extends Error {
  constructor() {
    super(`cloud agent exceeded the ${CLOUD_RUNTIME_CAP_MS}ms runtime cap`);
    this.name = "CloudRuntimeCapError";
  }
}

export interface CloudAgentBridgeOptions {
  backend: CloudAgentBackend;
  clock?: () => number;
  pollIntervalMs?: number;
  rpcTimeoutMs?: number;
  runtimeCapMs?: number;
  rateLimitBaseMs?: number;
  rateLimitJitter?: number;
}

export class CloudAgentBridge {
  private readonly backend: CloudAgentBackend;
  private readonly clock: () => number;
  private readonly pollIntervalMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly runtimeCapMs: number;
  private readonly rateLimitBaseMs: number;
  private readonly rateLimitJitter: number;
  private rateLimitedUntil = 0;

  constructor(options: CloudAgentBridgeOptions) {
    this.backend = options.backend;
    this.clock = options.clock ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? CLOUD_POLL_INTERVAL_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? CLOUD_RPC_TIMEOUT_MS;
    this.runtimeCapMs = options.runtimeCapMs ?? CLOUD_RUNTIME_CAP_MS;
    this.rateLimitBaseMs = options.rateLimitBaseMs ?? CLOUD_RATE_LIMIT_BASE_MS;
    this.rateLimitJitter = options.rateLimitJitter ?? CLOUD_RATE_LIMIT_JITTER;
  }

  private withTimeout<T>(signal: AbortSignal, task: (s: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const onExternalAbort = (): void => {
        controller.abort();
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      const timer = setTimeout(() => {
        controller.abort();
        reject(new CloudRpcTimeoutError());
      }, this.rpcTimeoutMs);
      signal.addEventListener("abort", onExternalAbort, { once: true });
      task(controller.signal).then(
        (value) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onExternalAbort);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onExternalAbort);
          reject(error);
        },
      );
    });
  }

  private applyRateLimitIfNeeded(): void {
    const now = this.clock();
    if (now < this.rateLimitedUntil) return;
    const jitter = this.rateLimitBaseMs * this.rateLimitJitter * (Math.random() * 2 - 1);
    this.rateLimitedUntil = now + this.rateLimitBaseMs + jitter;
  }

  /** Launch a background cloud agent; polls until it settles or the runtime
   * cap hits. Rate-limit jitter applies before each launch. */
  async launchAndTrack(
    request: CloudAgentLaunchRequest,
    options: { onStatus?: (status: CloudAgentStatus) => void; signal?: AbortSignal } = {},
  ): Promise<CloudAgentStatus> {
    this.applyRateLimitIfNeeded();
    const signal = options.signal ?? new AbortController().signal;
    const startedAt = this.clock();
    const handle = await this.withTimeout(signal, (s) => this.backend.launch(request, s));
    for (;;) {
      if (signal.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      if (this.clock() - startedAt > this.runtimeCapMs) {
        throw new CloudRuntimeCapError();
      }
      const status = await this.withTimeout(signal, (s) =>
        this.backend.status(handle.cloudAgentId, s),
      );
      options.onStatus?.(status);
      if (status.state !== "pending" && status.state !== "running") return status;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollIntervalMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  async reply(cloudAgentId: string, text: string, signal?: AbortSignal): Promise<void> {
    const s = signal ?? new AbortController().signal;
    await this.withTimeout(s, (inner) => this.backend.reply(cloudAgentId, text, inner));
  }

  async cancel(cloudAgentId: string, signal?: AbortSignal): Promise<void> {
    const s = signal ?? new AbortController().signal;
    await this.withTimeout(s, (inner) => this.backend.cancel(cloudAgentId, inner));
  }

  async rename(cloudAgentId: string, name: string, signal?: AbortSignal): Promise<void> {
    const s = signal ?? new AbortController().signal;
    await this.withTimeout(s, (inner) => this.backend.rename(cloudAgentId, name, inner));
  }

  async exportTranscript(cloudAgentId: string, signal?: AbortSignal): Promise<unknown> {
    const s = signal ?? new AbortController().signal;
    return this.withTimeout(s, (inner) => this.backend.exportTranscript(cloudAgentId, inner));
  }
}

/** Deterministic in-memory backend for tests and offline demos. */
export function createMockCloudBackend(options: {
  /** Sequence of states the launch settles through (default: done). */
  states?: CloudAgentStatus["state"][];
  clock?: () => number;
} = {}): CloudAgentBackend & { launches: CloudAgentLaunchRequest[] } {
  const states = options.states ?? ["done"];
  const launches: CloudAgentLaunchRequest[] = [];
  let nextId = 0;
  const replies: string[] = [];
  const renames: string[] = [];
  let cancelled = false;
  let lastState: CloudAgentStatus["state"] | undefined;
  return {
    launches,
    async launch(request) {
      launches.push(request);
      return { cloudAgentId: `cloud-${++nextId}` };
    },
    async reply(_id, text) {
      replies.push(text);
    },
    async cancel() {
      cancelled = true;
    },
    async rename(_id, name) {
      renames.push(name);
    },
    async status() {
      // Consume the programmed sequence, then stick to the last state.
      const state = (states.length > 0 ? states.shift() : undefined) ?? lastState ?? "done";
      lastState = state;
      return {
        state,
        filesChanged: state === "done" ? ["src/index.ts"] : undefined,
        prUrl: state === "done" ? "https://example.invalid/pr/1" : undefined,
      };
    },
    async exportTranscript() {
      return { entries: [], replies: [...replies], renames: [...renames], cancelled };
    },
  };
}
