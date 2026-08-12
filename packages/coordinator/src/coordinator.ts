/**
 * Coordinator core: the process-supervision and fan-out hub.
 *
 * Responsibilities (mirroring the original node-agent-coordinator):
 *
 * 1. Own port sessions for the three planes (control / data / mainData) and
 *    route `request` frames to a command executor (which, in the original,
 *    forwards them to the host as `POST /api/<method>` HTTP commands).
 * 2. Fan out SSE gateway events to typed event families on the data plane
 *    (`event` frames), honouring the family mapping from
 *    `@open-grokbot/transport`. Unknown channels pass through untouched so
 *    protocol evolution never breaks the pipeline.
 * 3. Supervise the host process. Exit-code contract (reconstructed):
 *    0 = clean shutdown, 1 = protocol breach (kill-by-contract), 2 = crash
 *    that warrants a restart attempt. The supervisor restarts on 2 with a
 *    bounded exponential backoff.
 *
 * The coordinator itself is transport-agnostic: carriers (parent-port /
 * fork-ipc) drive the same core, so identical code runs inside a real child
 * process (fork-ipc, plain Node) or in Electron (parent-port handoff).
 */

import { createServer as createHttpServer } from "node:http";
import {
  createPortServer,
  eventFamilyForSseChannel,
  type PortServer,
  type ServerFrame,
} from "@open-grokbot/transport";
import { createRetryPolicy } from "@open-grokbot/core";
import {
  type CoordinatorPlane,
  type IpcProcessLike,
  acceptHandoff,
  demuxForkIpc,
  isHandoffMessage,
} from "./carrier.js";
import { COORDINATOR_METHOD_NAMES } from "./rpc-contract.js";

export interface HostProcessSpec {
  /** Absolute path of the script executed by the host process. */
  entry: string;
  /** Bootstrap JSON handed to the host (mirrors the original --bootstrap). */
  bootstrap?: unknown;
}

export interface CoordinatorOptions {
  /** Commands from the coordinator are forwarded to this executor. In the
   * original this is the gateway HTTP client (POST /api/<method>). */
  executeCommand?: (method: string, args: unknown) => Promise<unknown>;
  /** Optional host supervisor. Omit to run the coordinator without a host. */
  host?: {
    spec: HostProcessSpec;
    spawn: (spec: HostProcessSpec) => IpcProcessLike | Promise<IpcProcessLike>;
  };
  onEvent?: (family: string, payload: unknown) => void;
  onHostStatus?: (status: { pid: number | null; healthy: boolean }) => void;
  exitCodeContract?: { protocolBreach: number; crashRestart: number };
  restartBackoff?: { baseMs: number; maxMs: number };
  clock?: () => number;
}

const DEFAULT_EXIT_CONTRACT = { protocolBreach: 1, crashRestart: 2 };
const DEFAULT_RESTART_BACKOFF = { baseMs: 1000, maxMs: 30000 };

/** One coordinator plane: a port server plus the mutable endpoint that feeds
 * it. The endpoint slots are swapped by the carrier wiring (handoff ports or
 * fork-ipc pipe) after construction; the server calls the endpoint object's
 * properties dynamically, so late binding works. */
export interface CoordinatorPlaneSession {
  readonly plane: CoordinatorPlane;
  readonly server: PortServer;
  readonly endpoint: {
    post: (frame: ServerFrame) => void;
    close: () => void;
  };
}

export class CoordinatorCore {
  readonly planes: Record<CoordinatorPlane, CoordinatorPlaneSession>;
  private hostProcess: IpcProcessLike | null = null;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private readonly clock: () => number;
  private readonly options: Required<Pick<CoordinatorOptions, "exitCodeContract" | "restartBackoff">> &
    CoordinatorOptions;

  constructor(options: CoordinatorOptions = {}) {
    this.options = {
      ...options,
      exitCodeContract: options.exitCodeContract ?? DEFAULT_EXIT_CONTRACT,
      restartBackoff: options.restartBackoff ?? DEFAULT_RESTART_BACKOFF,
    };
    this.clock = options.clock ?? Date.now;
    this.planes = this.createPlanes();
  }

  private createPlanes(): Record<CoordinatorPlane, CoordinatorPlaneSession> {
    const build = (plane: CoordinatorPlane): CoordinatorPlaneSession => {
      const endpoint: { post: (frame: ServerFrame) => void; close: () => void } = {
        post: () => {},
        close: () => {},
      };
      const server = createPortServer(endpoint, {
        dispatch: (method, args) => this.handleRequest(plane, method, args),
      });
      return { plane, server, endpoint };
    };
    return { control: build("control"), data: build("data"), mainData: build("mainData") };
  }

  private async handleRequest(
    plane: CoordinatorPlane,
    method: string,
    args: unknown,
  ): Promise<unknown> {
    if (!COORDINATOR_METHOD_NAMES.has(method)) {
      throw Object.assign(new Error(`unknown method ${method}`), { name: "UnknownMethodError" });
    }
    if (method === "hello") return { version: 1 };
    if (method === "ping") return { pong: true };
    if (method === "hostStatus") {
      return { pid: this.hostProcess ? -1 : null, healthy: this.hostProcess != null };
    }
    if (method === "restartHost") {
      await this.restartHost();
      return { ok: true };
    }
    const executor = this.options.executeCommand;
    if (!executor) {
      throw Object.assign(new Error(`no command executor for ${method}`), {
        name: "NoExecutorError",
      });
    }
    return executor(method, args);
  }

  /** Fan out a gateway SSE event to the data plane as a typed event frame. */
  dispatchSseEvent(channel: string, payload: unknown): void {
    const family = eventFamilyForSseChannel(channel);
    this.planes.data.server.postEvent(family ?? channel, payload);
    this.options.onEvent?.(family ?? channel, payload);
  }

  async startHost(): Promise<void> {
    if (!this.options.host || this.hostProcess) return;
    const { spawn, spec } = this.options.host;
    const child = await spawn(spec);
    this.hostProcess = child;
    child.on("exit", (code) => this.handleHostExit(code));
    child.on("error", () => this.options.onHostStatus?.({ pid: null, healthy: false }));
    this.restartAttempts = 0;
    this.options.onHostStatus?.({ pid: -1, healthy: true });
  }

  private handleHostExit(code: number | null): void {
    this.hostProcess = null;
    this.options.onHostStatus?.({ pid: null, healthy: false });
    if (code === this.options.exitCodeContract.crashRestart && this.options.host) {
      const backoffMs = this.computeBackoff(this.restartAttempts);
      this.restartAttempts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.startHost();
      }, backoffMs);
    }
  }

  private computeBackoff(attempt: number): number {
    const { baseMs, maxMs } = this.options.restartBackoff;
    return Math.min(maxMs, baseMs * 2 ** attempt);
  }

  async restartHost(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.hostProcess?.kill();
    this.hostProcess = null;
    await this.startHost();
  }

  /** Feed a raw inbound message into the matching plane session. */
  handleInbound(plane: CoordinatorPlane, message: unknown): void {
    this.planes[plane].server.handleMessage(message);
  }

  handlePortClosed(plane: CoordinatorPlane): void {
    this.planes[plane].server.handlePortClosed();
  }

  /** HTTP health surface (probe for supervisors, mirrors /healthz-style checks). */
  async listen(port = 0): Promise<number> {
    const server = createHttpServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, host: this.hostProcess != null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    this.httpServer = server;
    const address = server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async shutdown(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.hostProcess?.kill();
    this.hostProcess = null;
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }
}

/**
 * Child-side bootstrap: wire one coordinator core to whatever carrier message
 * arrives — a handoff with three ports, or a fork-ipc pipe. Outgoing server
 * frames are multiplexed back with a `{channel}` envelope on fork-ipc (the
 * data plane is the default channel, matching the original's liberal parse).
 */
export function bootstrapCoordinatorChild(
  core: CoordinatorCore,
  postMessage: (msg: unknown) => void,
  onMessage: (handler: (msg: unknown) => void) => void,
): void {
  // Default (fork-ipc) wiring: outgoing frames are multiplexed back on the
  // pipe. control/mainData use a {channel} envelope; data is the bare channel.
  for (const plane of ["control", "data", "mainData"] as CoordinatorPlane[]) {
    const session = core.planes[plane];
    session.endpoint.post = (frame) => {
      if (plane === "control" || plane === "mainData") {
        postMessage({ channel: plane, data: frame });
      } else {
        postMessage(frame);
      }
    };
  }
  onMessage((msg) => {
    if (isHandoffMessage(msg)) {
      // Three-port handoff: attach the parent-owned ends as endpoints.
      const ports = acceptHandoff(msg).ports;
      for (const plane of ["control", "data", "mainData"] as CoordinatorPlane[]) {
        const port = ports[plane];
        if (!port) continue;
        const session = core.planes[plane];
        session.endpoint.post = (frame) => port.postMessage(frame);
        session.endpoint.close = () => port.close?.();
        port.on("message", (event) => session.server.handleMessage(event.data));
      }
      return;
    }
    const { plane, data } = demuxForkIpc(msg);
    core.planes[plane].server.handleMessage(data);
  });
}

/** Retry policy helper re-export for carrier-facing code. */
export { createRetryPolicy };
