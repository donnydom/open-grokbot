/**
 * Coordinator process entrypoint (child side).
 *
 * Bootstrapping mirrors the original: the parent passes a `--bootstrap=`
 * argument carrying a JSON payload (host spec, gateway endpoint, port
 * carrier choice). On a fork-ipc carrier the coordinator immediately starts
 * answering on `process.send` / `process.on("message")`; on a parent-port
 * carrier it waits for the handoff message with the three ports.
 *
 * Exit-code contract (reconstructed from the original):
 *   0 = clean shutdown, 1 = protocol breach, 2 = crash (supervisor restarts).
 */

import { CoordinatorCore, bootstrapCoordinatorChild } from "./coordinator.js";

export interface CoordinatorBootstrap {
  /** Gateway base URL for command forwarding (POST /api/<method>). */
  gatewayBaseUrl?: string;
  /** Host process spec (entry script + bootstrap JSON). */
  hostEntry?: string;
  /** Plain-Node fork-ipc carrier. */
  carrier?: "fork-ipc";
}

export function parseBootstrap(argv: string[]): CoordinatorBootstrap | null {
  const flag = argv.find((arg) => arg.startsWith("--bootstrap="));
  if (!flag) return null;
  try {
    return JSON.parse(flag.slice("--bootstrap=".length)) as CoordinatorBootstrap;
  } catch {
    return null;
  }
}

export function runCoordinatorEntry(bootstrap: CoordinatorBootstrap | null): void {
  const core = new CoordinatorCore({
    executeCommand:
      bootstrap?.gatewayBaseUrl != null
        ? async (method, args) => {
            const res = await fetch(`${bootstrap.gatewayBaseUrl}/api/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args ?? {}),
            });
            if (!res.ok) {
              throw Object.assign(new Error(`gateway ${res.status}`), {
                name: "GatewayCommandError",
              });
            }
            return res.json();
          }
        : undefined,
    host: bootstrap?.hostEntry
      ? {
          spec: { entry: bootstrap.hostEntry },
          spawn: async (spec) => {
            const { fork } = await import("node:child_process");
            const child = fork(spec.entry, {
              stdio: ["ignore", "inherit", "inherit", "ipc"],
            });
            return {
              send: (msg) => child.send(msg as never),
              on: ((event: string, listener: unknown) =>
                child.on(event as never, listener as never)) as never,
              kill: () => child.kill(),
            };
          },
        }
      : undefined,
  });

  bootstrapCoordinatorChild(
    core,
    (msg) => {
      if (process.send) process.send(msg as never);
    },
    (handler) => {
      process.on("message", handler);
    },
  );

  process.on("disconnect", () => {
    void core.shutdown();
    process.exit(0);
  });
}
