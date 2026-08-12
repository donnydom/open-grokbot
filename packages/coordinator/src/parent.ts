/**
 * Parent-side launcher for the coordinator.
 *
 * Two carriers, mirroring the original:
 *
 * - `fork-ipc`: `child_process.fork` with one shared IPC pipe. The parent
 *   speaks the frame protocol on the pipe directly; control/mainData frames
 *   are wrapped in a `{channel}` envelope. This is the plain-Node path the
 *   original used for tests, and it is fully exercised by our test suite.
 *
 * - `parent-port` (Electron only): the parent creates three MessageChannels
 *   and hands the child ends to the utility process via a single handoff
 *   message. We model the contract here (same handoff shape) so an Electron
 *   shell can plug in `utilityProcess.fork` + `MessageChannel` verbatim; the
 *   structural types make that drop-in.
 */

import { fork, type ChildProcess } from "node:child_process";
import {
  createPortClient,
  type PortClient,
} from "@open-grokbot/transport";
import { demuxForkIpc } from "./carrier.js";
import type { CoordinatorBootstrap } from "./entry.js";
import type { HandoffMessage } from "./carrier.js";

export interface SpawnCoordinatorOptions {
  entry: string;
  bootstrap?: CoordinatorBootstrap;
}

export interface RunningCoordinator {
  readonly child: ChildProcess;
  /** Data plane client. Only populated on the parent-port carrier (Electron);
   * the fork-ipc carrier has no renderer, matching the original's test path. */
  readonly data: PortClient | null;
  /** Control plane client (lifecycle + WebAuthn). */
  readonly control: PortClient;
  /** MainData plane client (host supervision for the main process). */
  readonly mainData: PortClient;
  stop(): void;
}

/**
 * Spawns the coordinator over a fork-ipc carrier and returns the plane
 * clients. control/mainData share one IPC pipe wrapped in `{channel}`
 * envelopes; there is no data plane on this carrier (no renderer in plain
 * Node), exactly like the original's non-Electron test path.
 */
export function spawnCoordinatorForkIpc(options: SpawnCoordinatorOptions): RunningCoordinator {
  const args: string[] = [];
  if (options.bootstrap) {
    args.push(`--bootstrap=${JSON.stringify(options.bootstrap)}`);
  }
  const child = fork(options.entry, args, { stdio: ["ignore", "inherit", "inherit", "ipc"] });

  const build = (plane: "control" | "mainData"): PortClient => {
    const channel = {
      post: (frame: unknown) => child.send({ channel: plane, data: frame } as never),
      close: () => {},
    };
    const client = createPortClient(channel);
    // Announce readiness; the server rejects requests until hello.
    channel.post({ kind: "lifecycle", phase: "ready" });
    child.on("message", (msg) => {
      const demuxed = demuxForkIpc(msg);
      if (demuxed.plane === plane) client.handleMessage(demuxed.data);
    });
    return client;
  };

  const running: RunningCoordinator = {
    child,
    data: null,
    control: build("control"),
    mainData: build("mainData"),
    stop: () => child.disconnect(),
  };
  return running;
}

/** Electron-side helper types for the parent-port carrier. */
export interface ParentPortHandoff {
  /** Send a handoff message to the utility process. */
  postHandoff(handoff: HandoffMessage): void;
}

export { demuxForkIpc };
