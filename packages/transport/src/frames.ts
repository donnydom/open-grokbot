/** Wire frames for the coordinator MessagePort protocol.
 *
 * Client -> server: lifecycle (ready/shutdown), request {requestId, method, args}
 * Server -> client: lifecycle, reply {requestId, outcome}, event {family, payload}
 * Any frame that violates the direction contract is a protocol breach and
 * settles the session (mirrors the original renderer-port-server contract).
 */

export type ClientFrame =
  | { kind: "lifecycle"; phase: "ready" | "shutdown"; reason?: string }
  | { kind: "request"; requestId: string; method: string; args?: unknown };

export type ServerFrame =
  | { kind: "lifecycle"; phase: "ready" | "shutdown"; reason?: string; detail?: string }
  | { kind: "reply"; requestId: string; outcome: ReplyOutcome }
  | { kind: "event"; family: string; payload: unknown };

export type ReplyOutcome =
  | { kind: "ok"; value: unknown }
  | { kind: "error"; errorName: string; errorMessage: string; errorStack?: string | null }
  | { kind: "unknown-method"; method: string };

export function isClientFrame(value: unknown): value is ClientFrame {
  if (typeof value !== "object" || value == null) return false;
  const frame = value as Record<string, unknown>;
  if (frame.kind === "lifecycle") {
    return frame.phase === "ready" || frame.phase === "shutdown";
  }
  if (frame.kind === "request") {
    return (
      typeof frame.requestId === "string" &&
      typeof frame.method === "string" &&
      frame.requestId.length > 0
    );
  }
  return false;
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (typeof value !== "object" || value == null) return false;
  const frame = value as Record<string, unknown>;
  if (frame.kind === "lifecycle") {
    return frame.phase === "ready" || frame.phase === "shutdown";
  }
  if (frame.kind === "event") {
    return typeof frame.family === "string" && frame.family.length > 0;
  }
  if (frame.kind === "reply") {
    return typeof frame.requestId === "string" && typeof frame.outcome === "object";
  }
  return false;
}

export function makeRequest(requestId: string, method: string, args?: unknown): ClientFrame {
  return args === undefined
    ? { kind: "request", requestId, method }
    : { kind: "request", requestId, method, args };
}

export function makeOkReply(requestId: string, value: unknown): ServerFrame {
  return { kind: "reply", requestId, outcome: { kind: "ok", value } };
}

export function makeErrorReply(requestId: string, error: unknown): ServerFrame {
  if (error instanceof Error) {
    return {
      kind: "reply",
      requestId,
      outcome: {
        kind: "error",
        errorName: error.name,
        errorMessage: error.message,
        ...(error.stack != null ? { errorStack: error.stack } : {}),
      },
    };
  }
  return {
    kind: "reply",
    requestId,
    outcome: { kind: "error", errorName: "Error", errorMessage: String(error) },
  };
}

export function makeUnknownMethodReply(requestId: string, method: string): ServerFrame {
  return { kind: "reply", requestId, outcome: { kind: "unknown-method", method } };
}

export function makeEvent(family: string, payload: unknown): ServerFrame {
  return { kind: "event", family, payload };
}
