import { createEventBus, type EventBus } from "@open-grokbot/core";
import {
  isClientFrame,
  isServerFrame,
  makeEvent,
  makeErrorReply,
  makeOkReply,
  makeUnknownMethodReply,
  type ClientFrame,
  type ServerFrame,
} from "./frames.js";

/** The physical channel abstraction: structured clone over MessagePort, IPC, or an in-memory pair. */
export interface PortChannel {
  post(frame: unknown): void;
  close(): void;
}

export type RequestDispatch = (
  method: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

export interface PortServerOptions {
  /** The request table; unknown methods settle as the reserved unknown-method reply. */
  readonly dispatch: RequestDispatch;
  /** Called once the client announced ready. */
  readonly onReady?: () => void;
}

export type PortSettlement =
  | { outcome: "clean"; detail?: string }
  | { outcome: "protocol-breach"; detail: string };

export interface PortServer {
  readonly settled: Promise<PortSettlement>;
  handleMessage(value: unknown): void;
  handlePortClosed(): void;
  postEvent(family: string, payload: unknown): void;
}

/**
 * The server side of a coordinator port session: enforces the frame contract
 * (hello before request, direction ownership), dispatches requests against the
 * injected table, and fans events out to the client. Any breach settles the
 * session and the caller decides process fate (exit code 1 in the coordinator).
 */
export function createPortServer(
  endpoint: { post: (frame: ServerFrame) => void; close(): void },
  options: PortServerOptions,
): PortServer {
  const events = createEventBus<{ settled: PortSettlement }>();
  let settled = false;
  let ready = false;

  const settle = (settlement: PortSettlement): void => {
    if (settled) return;
    settled = true;
    events.emit("settled", settlement);
  };

  const breach = (detail: string): void => {
    try {
      endpoint.post({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail });
    } catch {
      // peer is gone; settlement alone carries the failure
    }
    settle({ outcome: "protocol-breach", detail });
  };

  const handleMessage = (value: unknown): void => {
    if (settled) return;
    if (!isClientFrame(value)) {
      breach("malformed frame");
      return;
    }
    const frame = value as ClientFrame;
    if (frame.kind === "lifecycle") {
      if (frame.phase === "shutdown") {
        settle({ outcome: "clean", detail: "client shutdown" });
        return;
      }
      if (ready) {
        breach("duplicate ready");
        return;
      }
      ready = true;
      endpoint.post({ kind: "lifecycle", phase: "ready" });
      options.onReady?.();
      return;
    }
    // request frame
    if (!ready) {
      breach("request frame before hello");
      return;
    }
    void handleRequest(frame);
  };

  const handleRequest = async (frame: Extract<ClientFrame, { kind: "request" }>): Promise<void> => {
    const { requestId, method, args } = frame;
    if (settled) return;
    const controller = new AbortController();
    try {
      const value = await options.dispatch(method, args, controller.signal);
      if (settled) return;
      endpoint.post(makeOkReply(requestId, value));
    } catch (error) {
      if (settled) return;
      endpoint.post(makeErrorReply(requestId, error));
    }
  };

  const handlePortClosed = (): void => {
    settle({ outcome: "clean", detail: "port closed" });
  };

  const postEvent = (family: string, payload: unknown): void => {
    if (settled || !ready) return;
    try {
      endpoint.post(makeEvent(family, payload));
    } catch {
      // peer gone; next close settles
    }
  };

  const settledPromise = new Promise<PortSettlement>((resolve) => {
    events.on("settled", resolve);
  });

  return {
    settled: settledPromise,
    handleMessage,
    handlePortClosed,
    postEvent,
  };
}

/** Client-side session over a PortChannel. */
export interface PortClient {
  readonly settled: Promise<PortSettlement>;
  /** Send a request and await its reply. */
  request(method: string, args?: unknown, timeoutMs?: number): Promise<unknown>;
  /** One-way event sink; returns unsubscribe. */
  onEvent(family: string, handler: (payload: unknown) => void): () => void;
  close(): void;
  handleMessage(value: unknown): void;
}

export function createPortClient(
  channel: PortChannel,
  options?: { readonly eventBus?: EventBus<Record<string, unknown>> },
): PortClient {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const events = createEventBus<{ settled: PortSettlement }>();
  let settled = false;
  let nextRequestId = 0;
  let ready = false;

  const settle = (settlement: PortSettlement): void => {
    if (settled) return;
    settled = true;
    for (const { reject } of pending.values()) {
      reject(new Error("port closed"));
    }
    pending.clear();
    events.emit("settled", settlement);
  };

  const handleMessage = (value: unknown): void => {
    if (!isServerFrame(value)) {
      settle({ outcome: "protocol-breach", detail: "malformed frame from server" });
      return;
    }
    const frame = value as ServerFrame;
    if (frame.kind === "lifecycle") {
      if (frame.phase === "shutdown") {
        settle(
          frame.reason === "protocol-error"
            ? { outcome: "protocol-breach", detail: frame.detail ?? "server protocol error" }
            : { outcome: "clean", detail: "server shutdown" },
        );
      }
      if (frame.phase === "ready") ready = true;
      return;
    }
    if (frame.kind === "event") {
      const set = listeners.get(frame.family);
      if (set != null) {
        for (const handler of [...set]) {
          try {
            handler(frame.payload);
          } catch (error) {
            console.error(`[port-client] event handler for ${frame.family} failed`, error);
          }
        }
      }
      return;
    }
    // reply
    const waiter = pending.get(frame.requestId);
    if (waiter == null) return; // late reply for an abandoned request
    pending.delete(frame.requestId);
    const outcome = frame.outcome;
    if (outcome.kind === "ok") {
      waiter.resolve(outcome.value);
    } else if (outcome.kind === "unknown-method") {
      waiter.reject(new Error(`unknown method: ${outcome.method}`));
    } else {
      const error = new Error(outcome.errorMessage);
      error.name = outcome.errorName;
      waiter.reject(error);
    }
  };

  const request = (method: string, args?: unknown, timeoutMs?: number): Promise<unknown> => {
    const requestId = `r${++nextRequestId}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs != null && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!pending.delete(requestId)) return;
          reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      pending.set(requestId, {
        resolve: (value) => {
          if (timer != null) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer != null) clearTimeout(timer);
          reject(error);
        },
      });
    });
    channel.post({
      kind: "request",
      requestId,
      method,
      ...(args !== undefined ? { args } : {}),
    });
    return promise;
  };

  const onEvent = (family: string, handler: (payload: unknown) => void): (() => void) => {
    let set = listeners.get(family);
    if (set == null) {
      set = new Set();
      listeners.set(family, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  };

  const close = (): void => {
    if (ready) {
      try {
        channel.post({ kind: "lifecycle", phase: "shutdown" });
      } catch {
        // ignore
      }
    }
    channel.close();
    settle({ outcome: "clean", detail: "client close" });
  };

  const settledPromise = new Promise<PortSettlement>((resolve) => {
    events.on("settled", resolve);
  });

  return { settled: settledPromise, request, onEvent, close, handleMessage };
}

/** In-memory channel pair for tests and single-process composition. */
export function createInMemoryPortPair(): { serverSide: PortChannel; clientSide: PortChannel } {
  let serverSideClosed = false;
  let clientSideClosed = false;
  const serverListeners = new Set<(frame: unknown) => void>();
  const clientListeners = new Set<(frame: unknown) => void>();
  return {
    serverSide: {
      post: (frame) => {
        if (clientSideClosed) return;
        for (const listener of [...clientListeners]) listener(frame);
      },
      close: () => {
        serverSideClosed = true;
        clientListeners.clear();
      },
    },
    clientSide: {
      post: (frame) => {
        if (serverSideClosed) return;
        for (const listener of [...serverListeners]) listener(frame);
      },
      close: () => {
        clientSideClosed = true;
        serverListeners.clear();
      },
    },
  };
}
