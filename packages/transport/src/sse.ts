import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createDeadlinePolicy,
  createIdleWatchdogPolicy,
  createRetryPolicy,
  DeadlineExceededError,
  type DeadlinePolicy,
  type IdleWatchdogPolicy,
  type RetryPolicy,
} from "@open-grokbot/core";

import { eventFamilyForSseChannel } from "./channels.js";

/** Gateway wire contract (mirrors gateway-wire.ts): every command is a POST to
 * `<base>/api/<method>` with a JSON body of the method's single argument; the
 * event stream is a GET to `<base>/events` (SSE). */
export const GATEWAY_API_PREFIX = "/api";
export const GATEWAY_EVENTS_PATH = "/events";
export const GATEWAY_HEALTH_PATH = "/health";
export const GATEWAY_AUTH_SCHEME = "Bearer";
export const GATEWAY_AVATARS_PATH = "/avatars";

export const SSE_RECONNECT_MIN_MS = 1_000;
export const SSE_RECONNECT_MAX_MS = 10_000;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_STALL_TIMEOUT_MS = 35_000;
export const SSE_CONNECT_TIMEOUT_MS = 15_000;
export const SEND_POST_TIMEOUT_MS = 15_000;
export const ROSTER_READ_TIMEOUT_MS = 15_000;

/** One SSE event exactly as framed on the wire. */
export interface GatewaySseEvent {
  readonly channel: string;
  readonly payload: unknown;
}

export interface GatewayConnectionInfo {
  readonly baseUrl: string;
  readonly token?: string;
  /** Extra connection-scoped headers (e.g. pod-proxy tokens). */
  readonly headers?: Record<string, string>;
}

/** The command surface served by the gateway. */
export type GatewayApi = Record<
  string,
  (args: unknown, signal: AbortSignal) => Promise<unknown>
>;

export interface GatewayServerEvent {
  readonly channel: string;
  readonly payload: unknown;
}

export interface GatewaySseClientOptions {
  /** Resolves the live gateway connection before every command and reconnect. */
  readonly resolveConnection: (signal?: AbortSignal) => Promise<GatewayConnectionInfo>;
  readonly onEvent: (event: GatewaySseEvent) => void;
  /** Fired on established stream (generation counts streams) and stream drop. */
  readonly onTransportEvent?: (event: {
    family: "transport-connected" | "transport-down";
    payload: { generation: number; reason?: string };
  }) => void;
  readonly onTransportRetry?: () => void;
  readonly recordStage?: (report: {
    stage: string;
    clientNonce?: string;
    durationMs: number;
    isError?: boolean;
  }) => void;
  readonly timing?: Partial<GatewaySseClientTiming>;
}

export interface GatewaySseClientTiming {
  readonly reconnectBackoff: RetryPolicy;
  readonly connectDeadline: DeadlinePolicy;
  readonly stallWatchdog: IdleWatchdogPolicy;
  readonly sendPostDeadline: DeadlinePolicy;
}

export function createGatewaySseClientTiming(): GatewaySseClientTiming {
  return {
    reconnectBackoff: createRetryPolicy({
      name: "gateway-sse-reconnect-backoff",
      maxAttempts: Number.MAX_SAFE_INTEGER,
      initialDelayMs: SSE_RECONNECT_MIN_MS,
      maxDelayMs: SSE_RECONNECT_MAX_MS,
      backoffFactor: 2,
    }),
    connectDeadline: createDeadlinePolicy({ name: "gateway-sse-connect", timeoutMs: SSE_CONNECT_TIMEOUT_MS }),
    stallWatchdog: createIdleWatchdogPolicy({ name: "gateway-sse-stall", idleMs: SSE_STALL_TIMEOUT_MS }),
    sendPostDeadline: createDeadlinePolicy({ name: "gateway-send-post", timeoutMs: SEND_POST_TIMEOUT_MS }),
  };
}

export class GatewayCommandError extends Error {}

function extractGatewayErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Partial<{ error: string }>;
    return typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : null;
  } catch {
    return null;
  }
}

function withAuth(
  headers: Record<string, string>,
  connection: Pick<GatewayConnectionInfo, "token" | "headers">,
): Record<string, string> {
  const merged: Record<string, string> = { ...headers, ...connection.headers };
  if (connection.token != null && connection.token.length > 0) {
    merged.authorization = `${GATEWAY_AUTH_SCHEME} ${connection.token}`;
  }
  return merged;
}

/** Decoder for SSE blocks: splits a byte stream on blank lines and yields
 * complete blocks; each block's `data:` lines are joined and JSON-parsed. */
export class SseBlockDecoder {
  private buffer = "";

  constructor(private readonly onBlock: (block: string) => void) {}

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let index: number;
    while ((index = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const trimmed = block.trim();
      if (trimmed.length > 0 && !trimmed.startsWith(":")) {
        try {
          this.onBlock(trimmed);
        } catch {
          // a malformed event must not kill the stream
        }
      }
    }
  }
}

function parseSseBlock(block: string): GatewaySseEvent | null {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  if (dataLines.length === 0) return null;
  try {
    const event = JSON.parse(dataLines.join("\n")) as { channel?: unknown; payload?: unknown };
    if (typeof event.channel !== "string" || event.channel.length === 0) return null;
    return { channel: event.channel, payload: event.payload };
  } catch {
    return null;
  }
}

/**
 * The gateway SSE client (mirrors CoordinatorGatewayClient): one long-lived
 * event loop with bounded connect, stall watchdog, floor-resetting backoff and
 * per-command POSTs. sendPrompt gets a bounded deadline plus one idempotent
 * retry guarded by the clientNonce dedupe contract.
 */
export class GatewaySseClient {
  private readonly timing: GatewaySseClientTiming;
  private readonly recordStage?: GatewaySseClientOptions["recordStage"];
  private readonly sendDedupeProvenBaseUrls = new Set<string>();
  private isClosed = false;
  private reconnectGeneration = 0;
  private connectionCount = 0;
  private activeEventLoopController: AbortController | undefined;

  constructor(private readonly options: GatewaySseClientOptions) {
    this.timing = { ...createGatewaySseClientTiming(), ...options.timing };
    this.recordStage = options.recordStage;
  }

  start(): void {
    void this.runEventLoop();
  }

  close(): void {
    this.isClosed = true;
    this.reconnectGeneration += 1;
    this.activeEventLoopController?.abort();
  }

  /** Force a reconnect (host replacement, dev offline toggle). */
  requestReconnect(): Promise<void> {
    this.reconnectGeneration += 1;
    this.activeEventLoopController?.abort();
    return Promise.resolve();
  }

  getConnectionCount(): number {
    return this.connectionCount;
  }

  isLive(): boolean {
    return this.connectionCount > 0 && !this.isClosed;
  }

  /** Uniform command POST. */
  async command<T = unknown>(method: string, args: object): Promise<T> {
    return (await this.request(method, args)) as T;
  }

  /** The latency-critical send: bounded deadline + one idempotent retry. */
  async sendPrompt(args: { clientNonce?: string } & Record<string, unknown>): Promise<unknown> {
    const firstAttempt = { baseUrl: undefined as string | undefined, postStarted: false };
    try {
      return await this.sendPromptAttempt(args, firstAttempt);
    } catch (error) {
      const postNeverDispatched = !firstAttempt.postStarted;
      const dedupeProven =
        firstAttempt.baseUrl != null && this.sendDedupeProvenBaseUrls.has(firstAttempt.baseUrl);
      const isRetryable =
        !this.isClosed &&
        typeof args.clientNonce === "string" &&
        args.clientNonce.length > 0 &&
        !(error instanceof GatewayCommandError) &&
        (postNeverDispatched || dedupeProven);
      if (!isRetryable) throw error;
      try {
        this.options.onTransportRetry?.();
      } catch {
        // best-effort
      }
      return await this.sendPromptAttempt(args, {
        baseUrl: undefined,
        postStarted: false,
      });
    }
  }

  private async sendPromptAttempt(
    args: Record<string, unknown>,
    state: { baseUrl: string | undefined; postStarted: boolean },
  ): Promise<unknown> {
    const connection = await this.resolveConnection();
    state.baseUrl = connection.baseUrl;
    const postStart = performance.now();
    try {
      state.postStarted = true;
      const result = await this.timing.sendPostDeadline.run(async (signal) => {
        const response = await fetch(`${connection.baseUrl}${GATEWAY_API_PREFIX}/sendPrompt`, {
          method: "POST",
          headers: withAuth({ "content-type": "application/json" }, connection),
          body: JSON.stringify(args),
          signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => response.statusText);
          throw new GatewayCommandError(
            extractGatewayErrorMessage(detail) ?? `gateway sendPrompt failed: ${detail}`,
          );
        }
        return (await response.json()) as unknown;
      });
      // Capability probe: this gateway resolves sends at durable acceptance.
      if (
        typeof result === "object" &&
        result != null &&
        (result as { accepted?: boolean }).accepted === true
      ) {
        this.sendDedupeProvenBaseUrls.add(connection.baseUrl);
      }
      this.recordStage?.({
        stage: "gateway-post",
        clientNonce: typeof args.clientNonce === "string" ? args.clientNonce : undefined,
        durationMs: performance.now() - postStart,
      });
      return result;
    } catch (error) {
      this.recordStage?.({
        stage: "gateway-post",
        clientNonce: typeof args.clientNonce === "string" ? args.clientNonce : undefined,
        durationMs: performance.now() - postStart,
        isError: true,
      });
      throw error;
    }
  }

  private async resolveConnection(): Promise<GatewayConnectionInfo> {
    return await this.options.resolveConnection();
  }

  private async request(method: string, args: object): Promise<unknown> {
    const connection = await this.resolveConnection();
    const response = await fetch(`${connection.baseUrl}${GATEWAY_API_PREFIX}/${method}`, {
      method: "POST",
      headers: withAuth({ "content-type": "application/json" }, connection),
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new GatewayCommandError(
        extractGatewayErrorMessage(detail) ?? `gateway ${method} failed: ${detail}`,
      );
    }
    return (await response.json()) as unknown;
  }

  private async runEventLoop(): Promise<void> {
    let failedAttempts = 0;
    while (!this.isClosed) {
      const attemptGeneration = this.reconnectGeneration;
      try {
        await this.streamEvents(() => {
          failedAttempts = 0;
        }, attemptGeneration);
      } catch {
        // reconnect below
      }
      if (this.isClosed) break;
      if (attemptGeneration !== this.reconnectGeneration) {
        failedAttempts = 0;
        continue;
      }
      const backoffController = new AbortController();
      this.activeEventLoopController = backoffController;
      failedAttempts += 1;
      const wait = this.timing.reconnectBackoff.schedule(failedAttempts, backoffController.signal);
      try {
        await wait.elapsed;
      } catch {
        // aborted
      } finally {
        wait.dispose();
      }
      if (this.activeEventLoopController === backoffController) {
        this.activeEventLoopController = undefined;
      }
    }
  }

  private async streamEvents(resetBackoff: () => void, attemptGeneration: number): Promise<void> {
    const controller = new AbortController();
    this.activeEventLoopController = controller;
    const connectStart = performance.now();
    let connection: GatewayConnectionInfo | undefined;
    let didConnect = false;
    try {
      const handshake = await this.timing.connectDeadline.run(async (deadlineSignal) => {
        const resolved = await this.options.resolveConnection(deadlineSignal);
        connection = resolved;
        const response = await fetch(`${resolved.baseUrl}${GATEWAY_EVENTS_PATH}`, {
          headers: withAuth({ accept: "text/event-stream" }, resolved),
          signal: controller.signal,
        });
        if (controller.signal.aborted || attemptGeneration !== this.reconnectGeneration) {
          void response.body?.cancel().catch(() => {});
          throw new Error("gateway connect superseded");
        }
        if (!response.ok || response.body == null) {
          throw new GatewayCommandError(`gateway events failed: ${response.status}`);
        }
        return response.body.getReader();
      }, controller.signal);
      const reader = handshake;
      resetBackoff();
      this.connectionCount += 1;
      didConnect = true;
      this.options.onTransportEvent?.({
        family: "transport-connected",
        payload: { generation: this.connectionCount },
      });
      const decoder = new SseBlockDecoder((block) => {
        const event = parseSseBlock(block);
        if (event == null) return;
        // The event goes out on its channel regardless; family mapping is for
        // the port fan-out. Unknown channels pass through untouched.
        this.options.onEvent(event);
      });
      let stalled = false;
      const stallWatchdog = this.timing.stallWatchdog.arm(() => {
        stalled = true;
        controller.abort();
      });
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          stallWatchdog.kick();
          decoder.push(result.value);
        }
      } finally {
        stallWatchdog.dispose();
        controller.abort();
      }
      this.options.onTransportEvent?.({
        family: "transport-down",
        payload: { generation: this.connectionCount, reason: stalled ? "stalled" : "stream-ended" },
      });
    } catch (error) {
      if (error instanceof DeadlineExceededError) controller.abort();
      if (didConnect) {
        this.options.onTransportEvent?.({
          family: "transport-down",
          payload: { generation: this.connectionCount, reason: String(error) },
        });
      }
      throw error;
    } finally {
      if (this.activeEventLoopController === controller) {
        this.activeEventLoopController = undefined;
      }
    }
  }
}

/** The gateway SSE server (mirrors gateway-server.ts): routes commands and
 * serves the event stream with heartbeat, reconnect hint and channel filter. */
export interface GatewaySseServerOptions {
  readonly api: GatewayApi;
  /** Event source: the host publishes {channel, payload} events here. */
  readonly subscribe: (listener: (event: GatewayServerEvent) => void) => () => void;
  readonly heartbeatMs?: number;
}

export interface RunningGatewayServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startGatewayServer(
  options: GatewaySseServerOptions,
  listenPort = 0,
  host = "127.0.0.1",
): Promise<RunningGatewayServer> {
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    void handleRequest(req, res, url, options, heartbeatMs);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : 0;
  const baseUrl = `http://${host}:${port}`;
  return {
    port,
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-close lingering SSE connections so close() never hangs on an
        // open event stream.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL,
  options: GatewaySseServerOptions,
  heartbeatMs: number,
): Promise<void> {
  try {
    if (url.pathname === GATEWAY_EVENTS_PATH && req.method === "GET") {
      handleEvents(res, url, options, heartbeatMs);
      return;
    }
    if (url.pathname === GATEWAY_HEALTH_PATH && req.method === "GET") {
      respondJson(res, { ok: true, pid: process.pid, isBusy: false, activeAgentId: null, startedAt: Date.now() });
      return;
    }
    if (url.pathname.startsWith(GATEWAY_API_PREFIX) && req.method === "POST") {
      const method = url.pathname.slice(GATEWAY_API_PREFIX.length + 1);
      if (method.length === 0 || method.includes("/")) {
        respondError(res, 404, "unknown command");
        return;
      }
      const body = await readBody(req);
      let args: unknown;
      try {
        args = body.length === 0 ? {} : JSON.parse(body);
      } catch {
        respondError(res, 400, "invalid JSON body");
        return;
      }
      const handler = options.api[method];
      if (handler == null) {
        respondError(res, 404, `unknown command: ${method}`);
        return;
      }
      try {
        const value = await handler(args, new AbortController().signal);
        respondJson(res, value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respondError(res, 500, message);
      }
      return;
    }
    respondError(res, 404, "not found");
  } catch (error) {
    try {
      respondError(res, 500, error instanceof Error ? error.message : String(error));
    } catch {
      // response already sent
    }
  }
}

function handleEvents(
  res: import("node:http").ServerResponse,
  url: URL,
  options: GatewaySseServerOptions,
  heartbeatMs: number,
): void {
  const subscribed = parseSubscribedChannels(url);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write("retry: 1000\n\n");
  const unsubscribe = options.subscribe((event) => {
    if (subscribed != null && !subscribed.has(event.channel)) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // client gone; close below
    }
  });
  const heartbeat = setInterval(() => {
    try {
      res.write(":ping\n\n");
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
      res.destroy();
    }
  }, heartbeatMs);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function parseSubscribedChannels(url: URL): ReadonlySet<string> | undefined {
  const raw = url.searchParams.get("channels");
  if (raw === null) return undefined;
  const channels = raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return channels.length > 0 ? new Set(channels) : undefined;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function respondJson(res: import("node:http").ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}

function respondError(res: import("node:http").ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** Convenience: resolve a connection for loopback (no token). */
export function loopbackConnection(baseUrl: string): GatewayConnectionInfo {
  return { baseUrl };
}
