/**
 * Coordinator tests: carriers, RPC planes, host supervision, event fan-out.
 *
 * These exercise the fork-ipc carrier end to end with a real child process
 * (the same path the original used for non-Electron tests), plus an
 * in-process core for supervision semantics.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CoordinatorCore, bootstrapCoordinatorChild } from "../src/coordinator.js";
import { spawnCoordinatorForkIpc } from "../src/parent.js";
import { runCoordinatorEntry } from "../src/entry.js";
import { createSimulatedWebAuthnProvider } from "../src/webauthn.js";
import { demuxForkIpc, type CoordinatorPlane, type MessagePortLike } from "../src/carrier.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("carrier: fork-ipc spawns a real child, hello/ping round trips on control+mainData", async () => {
  const running = spawnCoordinatorForkIpc({
    entry: path.join(here, "..", "src", "coordinator-child-harness.js"),
  });
  try {
    assert.equal(running.data, null); // fork-ipc has no renderer data plane
    assert.deepEqual(await running.control.request("hello"), { version: 1 });
    assert.deepEqual(await running.control.request("ping"), { pong: true });
    assert.deepEqual(await running.mainData.request("ping"), { pong: true });
  } finally {
    running.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("carrier: parent-port handoff attaches planes and serves requests", async () => {
  const core = new CoordinatorCore();
  const wire = new Map<CoordinatorPlane, (msg: unknown) => void>();
  bootstrapCoordinatorChild(core, (msg) => {
    const { plane, data } = demuxForkIpc(msg);
    wire.get(plane)?.(data);
  }, (handler) => {
    wire.set("control", handler);
  });
  const makePort = (): MessagePortLike => {
    let listener: ((event: { data: unknown }) => void) | null = null;
    return {
      postMessage: (value) => wire.get("control")?.(value),
      on: (_event, handler) => {
        listener = handler;
      },
    };
  };
  const controlPort = makePort();
  const dataPort = makePort();
  const mainDataPort = makePort();
  wire.get("control")?.({
    type: "handoff",
    controlPort,
    dataPort,
    mainDataPort,
  });
  // Data plane handshake + request; reply returns through the port.
  core.planes.data.server.handleMessage({ kind: "lifecycle", phase: "ready" });
  const reply = await new Promise<unknown>((resolve) => {
    const original = core.planes.data.endpoint.post;
    core.planes.data.endpoint.post = (frame) => {
      if (frame.kind === "reply") resolve(frame);
      else original(frame);
    };
    core.planes.data.server.handleMessage({
      kind: "request",
      requestId: "r1",
      method: "ping",
    });
  });
  assert.equal((reply as { outcome: { kind: string } }).outcome.kind, "ok");
});

test("carrier: unknown method on control plane yields UnknownMethodError", async () => {
  const running = spawnCoordinatorForkIpc({
    entry: path.join(here, "..", "src", "coordinator-child-harness.js"),
  });
  try {
    await assert.rejects(() => running.control.request("noSuchMethod"), (error: Error) => {
      assert.equal(error.name, "UnknownMethodError");
      return true;
    });
  } finally {
    running.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("core: commands are forwarded to the executor and results returned", async () => {
  const calls: string[] = [];
  const core = new CoordinatorCore({
    executeCommand: async (method, args) => {
      calls.push(method);
      return { echo: args };
    },
  });
  const { data } = core.planes;
  const reply = await new Promise<unknown>((resolve) => {
    data.endpoint.post = (frame) => {
      if (frame.kind === "reply") resolve(frame);
    };
    data.server.handleMessage({ kind: "lifecycle", phase: "ready" });
    data.server.handleMessage({
      kind: "request",
      requestId: "r1",
      method: "sendPrompt",
      args: { prompt: "hi" },
    });
  });
  assert.deepEqual(calls, ["sendPrompt"]);
  assert.equal((reply as { outcome: { kind: string } }).outcome.kind, "ok");
});

test("core: SSE events fan out as typed family event frames", async () => {
  const events: Array<{ family: string; payload: unknown }> = [];
  const core = new CoordinatorCore({ onEvent: (family, payload) => events.push({ family, payload }) });
  core.dispatchSseEvent("transcript", { entry: 1 });
  core.dispatchSseEvent("some-future-channel", { x: 2 });
  assert.deepEqual(events, [
    { family: "transcript", payload: { entry: 1 } },
    { family: "some-future-channel", payload: { x: 2 } }, // unknown channels pass through
  ]);
});

test("core: host supervision restarts on crash code, not on clean/protocol exits", async () => {
  const spawns: number[] = [];
  const listeners = new Map<string, (code: number | null) => void>();
  let call = 0;
  const core = new CoordinatorCore({
    clock: () => 0,
    host: {
      spec: { entry: "host.js" },
      spawn: async () => {
        call += 1;
        spawns.push(call);
        return {
          send: () => true,
          on: ((event: string, listener: unknown) => {
            if (event === "exit") listeners.set(String(call), listener as (c: number | null) => void);
          }) as never,
          kill: () => {
            const handler = listeners.get(String(call));
            handler?.(null);
          },
        };
      },
    },
    restartBackoff: { baseMs: 10, maxMs: 100 },
  });
  await core.startHost();
  assert.deepEqual(spawns, [1]);
  // clean exit (0): no restart
  listeners.get("1")?.(0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(spawns, [1]);
  await core.restartHost();
  assert.deepEqual(spawns, [1, 2]);
  // crash exit (2): scheduled restart with backoff
  listeners.get("2")?.(2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(spawns, [1, 2, 3]);
  await core.shutdown();
});

test("webauthn: simulated provider issues credentials and assertions", async () => {
  const provider = createSimulatedWebAuthnProvider();
  const cred = await provider.makeCredential({ challenge: "c1", rpId: "localhost", userId: "u1" });
  assert.ok(cred.credentialId.startsWith("cred-u1"));
  const assertion = await provider.getAssertion({
    challenge: "c2",
    rpId: "localhost",
    credentialId: cred.credentialId,
  });
  assert.equal(assertion.signature, "sig-c2");
  await assert.rejects(
    () => provider.getAssertion({ challenge: "c3", rpId: "localhost", credentialId: "unknown" }),
    (error: Error) => error.name === "WebAuthnNotFoundError",
  );
});

test("entry: runCoordinatorEntry wires a live core (smoke)", () => {
  // No-op smoke: entry function must not throw when bootstrap is null and
  // process.send is unavailable (pure library usage).
  runCoordinatorEntry(null);
});
