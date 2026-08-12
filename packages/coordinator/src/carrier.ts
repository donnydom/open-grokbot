/**
 * Port carriers for the coordinator process.
 *
 * The original platform boots `node-agent-coordinator` as an Electron
 * `utilityProcess` and hands it three MessagePorts (control / data / mainData)
 * via a single "handoff" message. For tests and plain-Node deployments it
 * instead uses `child_process.fork` with one shared IPC pipe, where the
 * control and mainData planes are multiplexed with a `{channel}` envelope.
 *
 * This module models both carriers behind one interface so the coordinator
 * core never cares which transport it runs on.
 */

/** Minimal structural type for a MessagePort (browser / worker_threads / Electron). */
export interface MessagePortLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start?(): void;
  close?(): void;
  unref?(): void;
}

/** Structural type for a process we can speak IPC with. */
export interface IpcProcessLike {
  send(message: unknown): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): void;
  connected?: boolean;
  disconnect?(): void;
}

export const HANDSOFF_MESSAGE_TYPE = "handoff";

export interface HandoffMessage {
  type: typeof HANDSOFF_MESSAGE_TYPE;
  controlPort: MessagePortLike;
  dataPort: MessagePortLike;
  mainDataPort: MessagePortLike;
}

export type CoordinatorPlane = "control" | "data" | "mainData";

/** Envelope used by the fork-ipc carrier to multiplex planes on one pipe. */
export interface ForkIpcEnvelope {
  channel: "control" | "mainData";
  data: unknown;
}

export function isHandoffMessage(value: unknown): value is HandoffMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === HANDSOFF_MESSAGE_TYPE
  );
}

export function isForkIpcEnvelope(value: unknown): value is ForkIpcEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const channel = (value as { channel?: unknown }).channel;
  return channel === "control" || channel === "mainData";
}

/**
 * Handles a handoff message on the child side, yielding one MessagePort per
 * plane. This mirrors the coordinator's bootstrap: the parent owns the other
 * ends of the three MessageChannels and starts the port sessions after
 * spawning the child.
 */
export function acceptHandoff(message: unknown): {
  ports: Record<CoordinatorPlane, MessagePortLike | null>;
} {
  if (!isHandoffMessage(message)) return { ports: { control: null, data: null, mainData: null } };
  return {
    ports: {
      control: message.controlPort,
      data: message.dataPort,
      mainData: message.mainDataPort,
    },
  };
}

/**
 * Demultiplexes a fork-ipc envelope into the plane it belongs to. Used by the
 * coordinator entrypoint when the carrier is a plain Node IPC pipe (fork
 * mode). Raw frames (no envelope) are treated as control-plane data, matching
 * the original's liberal parsing.
 */
export function demuxForkIpc(message: unknown): { plane: CoordinatorPlane; data: unknown } {
  if (isForkIpcEnvelope(message)) {
    return { plane: message.channel, data: message.data };
  }
  return { plane: "control", data: message };
}

export function envelopeForPlane(plane: "control" | "mainData", data: unknown): ForkIpcEnvelope {
  return { channel: plane, data };
}
