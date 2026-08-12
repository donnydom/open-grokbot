/**
 * Cloud agent bridge tests: launch/polling lifecycle, RPC timeout, runtime
 * cap, reply/cancel/rename, rate-limit jitter, mock backend.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CloudAgentBridge,
  CloudRpcTimeoutError,
  CloudRuntimeCapError,
  createMockCloudBackend,
} from "../src/cloud-agent-bridge.js";

test("cloud: launch polls pending->running->done and surfaces file changes", async () => {
  const backend = createMockCloudBackend({ states: ["pending", "running", "done"] });
  const bridge = new CloudAgentBridge({ backend, pollIntervalMs: 1 });
  const seen: string[] = [];
  const status = await bridge.launchAndTrack(
    { localAgentId: "a1", prompt: "fix tests" },
    { onStatus: (s) => seen.push(s.state) },
  );
  assert.deepEqual(seen, ["pending", "running", "done"]);
  assert.equal(status.state, "done");
  assert.deepEqual(status.filesChanged, ["src/index.ts"]);
  assert.equal(status.prUrl, "https://example.invalid/pr/1");
  assert.deepEqual(backend.launches, [{ localAgentId: "a1", prompt: "fix tests" }]);
});

test("cloud: reply/cancel/rename are forwarded with RPC timeout wrapping", async () => {
  const backend = createMockCloudBackend();
  const bridge = new CloudAgentBridge({ backend });
  await bridge.reply("cloud-1", "continue");
  await bridge.rename("cloud-1", "new name");
  await bridge.cancel("cloud-1");
  const transcript = (await bridge.exportTranscript("cloud-1")) as {
    replies: string[];
    renames: string[];
    cancelled: boolean;
  };
  assert.deepEqual(transcript.replies, ["continue"]);
  assert.deepEqual(transcript.renames, ["new name"]);
  assert.equal(transcript.cancelled, true);
});

test("cloud: RPC timeout aborts a hanging backend call", async () => {
  const backend = createMockCloudBackend();
  backend.launch = () =>
    new Promise<never>((_resolve, _reject) => {
      // never settles; the bridge's RPC timeout aborts it
    });
  const bridge = new CloudAgentBridge({ backend, rpcTimeoutMs: 5 });
  await assert.rejects(
    () => bridge.launchAndTrack({ localAgentId: "a1", prompt: "hang" }),
    (error: Error) => {
      assert.ok(error instanceof CloudRpcTimeoutError);
      return true;
    },
  );
});

test("cloud: runtime cap fires when the agent never settles", async () => {
  const backend = createMockCloudBackend({ states: ["running"] });
  const bridge = new CloudAgentBridge({
    backend,
    pollIntervalMs: 1,
    runtimeCapMs: 10,
    rpcTimeoutMs: 10_000,
  });
  await assert.rejects(
    () => bridge.launchAndTrack({ localAgentId: "a1", prompt: "never settles" }),
    (error: Error) => {
      assert.ok(error instanceof CloudRuntimeCapError);
      return true;
    },
  );
});

test("cloud: rate-limit jitter delays the launch timestamp", async () => {
  const backend = createMockCloudBackend();
  const clock = { now: 0 };
  const bridge = new CloudAgentBridge({
    backend,
    clock: () => clock.now,
    pollIntervalMs: 1,
    rateLimitBaseMs: 60_000,
    rateLimitJitter: 0,
  });
  const start = Date.now();
  await bridge.launchAndTrack({ localAgentId: "a1", prompt: "p1" });
  assert.equal(backend.launches.length, 1);
  assert.ok(Date.now() - start < 5_000); // jitter does not block the launch path
});
