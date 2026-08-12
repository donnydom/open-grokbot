/**
 * Local-exec channel: the host's bridge to the local-exec daemon.
 *
 * Reconstructed from the original's local-exec-gateway: the daemon executes
 * shell commands and file operations on the local machine, isolated from the
 * agent runtime. The host submits requests to `/local-exec/requests` and
 * polls responses at `/local-exec/responses`.
 *
 * Timing contract mirrors the original:
 * - 10s heartbeat between daemon and host
 * - 30s liveness window: a daemon that misses heartbeats is presumed dead
 * - 10s response timeout per request
 */

import { createServer as createHttpServer, type Server } from "node:http";

export const LOCAL_EXEC_HEARTBEAT_MS = 10_000;
export const LOCAL_EXEC_LIVENESS_WINDOW_MS = 30_000;
export const LOCAL_EXEC_RESPONSE_TIMEOUT_MS = 10_000;
export const LOCAL_EXEC_REQUESTS_PATH = "/local-exec/requests";
export const LOCAL_EXEC_RESPONSES_PATH = "/local-exec/responses";
export const LOCAL_EXEC_HEARTBEAT_PATH = "/local-exec/heartbeat";

export interface LocalExecRequest {
  readonly id: string;
  readonly kind: "run-shell" | "read-file" | "write-file" | "list-dir";
  readonly args: Record<string, string>;
}

export interface LocalExecResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export type LocalExecHandler = (request: LocalExecRequest) => Promise<LocalExecResponse>;

export class LocalExecResponseTimeoutError extends Error {
  constructor(id: string) {
    super(`local-exec request ${id} timed out after ${LOCAL_EXEC_RESPONSE_TIMEOUT_MS}ms`);
    this.name = "LocalExecResponseTimeoutError";
  }
}

/** Daemon side: answer requests over the HTTP surface. */
export interface RunningLocalExecDaemon {
  readonly port: number;
  close(): Promise<void>;
}

export function startLocalExecDaemon(handler: LocalExecHandler, port = 0): Promise<RunningLocalExecDaemon> {
  const responses = new Map<string, LocalExecResponse>();
  let lastHeartbeat = Date.now();

  const server: Server = createHttpServer((req, res) => {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === LOCAL_EXEC_HEARTBEAT_PATH) {
      lastHeartbeat = Date.now();
      json(200, { ok: true, lastHeartbeat });
      return;
    }
    if (req.method === "POST" && req.url === LOCAL_EXEC_REQUESTS_PATH) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let request: LocalExecRequest;
        try {
          request = JSON.parse(body) as LocalExecRequest;
        } catch {
          json(400, { error: "malformed request" });
          return;
        }
        void handler(request).then((response) => {
          responses.set(request.id, response);
        });
        json(202, { accepted: true, id: request.id });
      });
      return;
    }
    if (req.method === "POST" && req.url === LOCAL_EXEC_RESPONSES_PATH) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let ids: string[];
        try {
          ids = JSON.parse(body) as string[];
        } catch {
          json(400, { error: "malformed body" });
          return;
        }
        const found = ids
          .map((id) => responses.get(id))
          .filter((r): r is LocalExecResponse => r != null);
        for (const response of found) responses.delete(response.id);
        json(200, { responses: found });
      });
      return;
    }
    json(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Host side: submit and await a request against the daemon. */
export class LocalExecClient {
  private readonly baseUrl: string;
  private lastHeartbeatMs = -Infinity;
  private readonly clock: () => number;
  private readonly responseTimeoutMs: number;

  constructor(
    options: {
      port: number;
      clock?: () => number;
      fetchImpl?: typeof fetch;
      responseTimeoutMs?: number;
    },
  ) {
    this.baseUrl = `http://127.0.0.1:${options.port}`;
    this.clock = options.clock ?? Date.now;
    this.fetch = options.fetchImpl ?? fetch;
    this.responseTimeoutMs = options.responseTimeoutMs ?? LOCAL_EXEC_RESPONSE_TIMEOUT_MS;
  }

  private readonly fetch: typeof fetch;

  async heartbeat(): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}${LOCAL_EXEC_HEARTBEAT_PATH}`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`);
    this.lastHeartbeatMs = this.clock();
  }

  /** True when the daemon's heartbeats fall inside the liveness window. */
  isAlive(): boolean {
    return this.clock() - this.lastHeartbeatMs <= LOCAL_EXEC_LIVENESS_WINDOW_MS;
  }

  async request(request: LocalExecRequest): Promise<LocalExecResponse> {
    const res = await this.fetch(`${this.baseUrl}${LOCAL_EXEC_REQUESTS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw new Error(`local-exec rejected the request: ${res.status}`);
    const started = this.clock();
    for (;;) {
      if (this.clock() - started > this.responseTimeoutMs) {
        throw new LocalExecResponseTimeoutError(request.id);
      }
      const poll = await this.fetch(`${this.baseUrl}${LOCAL_EXEC_RESPONSES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([request.id]),
      });
      if (!poll.ok) throw new Error(`local-exec response poll failed: ${poll.status}`);
      const body = (await poll.json()) as { responses: LocalExecResponse[] };
      const match = body.responses.find((r) => r.id === request.id);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
