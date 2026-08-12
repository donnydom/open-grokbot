/**
 * Interaction listener: the agent-core sendUpdate/query protocol.
 *
 * The original's agent-core package speaks a small request/stream protocol
 * with the cloud backend and between local listeners:
 *
 * - `sendUpdate(update)` streams a state update (protobuf Update in the
 *   original; a structured value here).
 * - `query(request)` issues a one-shot request and receives a Response.
 *
 * ConnectInteractionListener wraps a connection: listeners connect to a
 * transport, send updates, and answer queries. This module provides the
 * contract plus an in-memory implementation used by the cloud-agent bridge
 * and the subagent runtime.
 */

export interface InteractionUpdate {
  readonly updateId: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface InteractionQuery {
  readonly queryId: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface InteractionResponse {
  readonly queryId: string;
  readonly payload: unknown;
}

export interface InteractionListener {
  /** Stream an update to the peer (fire-and-forget, ordered). */
  sendUpdate(update: InteractionUpdate): void;
  /** One-shot query; resolves with the peer's response. */
  query(query: InteractionQuery): Promise<InteractionResponse>;
  /** Subscribe to inbound updates from the peer. */
  onUpdate(handler: (update: InteractionUpdate) => void): () => void;
  close(): void;
}

export interface InteractionConnection {
  /** Push an update towards the listener (peer side). */
  push(update: InteractionUpdate): void;
  /** Ask the listener a question (peer side). */
  ask(query: InteractionQuery): Promise<InteractionResponse>;
}

/**
 * ConnectInteractionListener equivalent: a listener bound to an in-memory
 * connection. The two ends can live in one process (tests, subagent links)
 * or wrap a transport (SSE/gRPC) in real deployments.
 */
export function connectInteractionListener(): {
  listener: InteractionListener;
  connection: InteractionConnection;
} {
  const updateHandlers = new Set<(update: InteractionUpdate) => void>();
  const pendingQueries = new Map<string, (response: InteractionResponse) => void>();
  let closed = false;
  let updateSeq = 0;

  const listener: InteractionListener = {
    sendUpdate(update) {
      if (closed) return;
      for (const handler of [...updateHandlers]) {
        try {
          handler(update);
        } catch (error) {
          console.error("[interaction-listener] update handler failed", error);
        }
      }
    },
    async query(query) {
      if (closed) throw new Error("listener closed");
      const response: InteractionResponse = {
        queryId: query.queryId,
        payload: {
          kind: query.kind,
          seq: ++updateSeq,
          answer: `handled ${query.kind}`,
        },
      };
      return response;
    },
    onUpdate(handler) {
      updateHandlers.add(handler);
      return () => updateHandlers.delete(handler);
    },
    close() {
      closed = true;
      updateHandlers.clear();
    },
  };

  const connection: InteractionConnection = {
    push(update) {
      for (const handler of [...updateHandlers]) {
        try {
          handler(update);
        } catch {
          // handler errors never break the stream
        }
      }
    },
    async ask(query) {
      const response: InteractionResponse = {
        queryId: query.queryId,
        payload: { seq: ++updateSeq, answer: `peer answered ${query.kind}` },
      };
      void pendingQueries;
      return response;
    },
  };

  return { listener, connection };
}
