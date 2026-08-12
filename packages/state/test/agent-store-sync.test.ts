/**
 * Agent store sync tests: etag conditional writes, conflict merge, exclusive
 * lock, lock expiry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentStoreSync,
  BcsConflictError,
  BcsLockHeldError,
  createInMemoryBcsBackend,
} from "../src/agent-store-sync.js";

test("bcs: update writes with etag and reads back the resource", async () => {
  const backend = createInMemoryBcsBackend();
  const sync = new AgentStoreSync({ backend });
  const result = await sync.update("agent-1", () => ({ name: "Alpha" }));
  assert.ok(result.etag.startsWith("etag-"));
  const read = await sync.get("agent-1");
  assert.deepEqual(read?.value, { name: "Alpha" });
});

test("bcs: concurrent conditional write conflicts and merges", async () => {
  const backend = createInMemoryBcsBackend();
  const merge = (remote: unknown, local: unknown): unknown => ({
    ...(remote as Record<string, unknown>),
    ...(local as Record<string, unknown>),
  });
  await backend.put("agent-1", { name: "Alpha" }, null);
  // Simulate a racing writer: the first conditional put reports an etag
  // conflict (the other device won), then the merge combines both fields and
  // the retry succeeds.
  let firstPut = true;
  const racing: typeof backend = {
    ...backend,
    put: async (resourceId, value, expectedEtag) => {
      if (resourceId === "agent-1" && firstPut) {
        firstPut = false;
        return { etag: "etag-other", conflict: true };
      }
      return backend.put(resourceId, value, expectedEtag);
    },
  };
  const sync = new AgentStoreSync({ backend: racing, merge });
  const result = await sync.update("agent-1", (current) => ({
    ...(current as Record<string, unknown>),
    tools: ["bash"],
  }));
  assert.deepEqual(result.value, { name: "Alpha", tools: ["bash"] });
  assert.equal(result.conflictsResolved, 1);
});

test("bcs: hard conflict (both merge retries fail) surfaces BcsConflictError", async () => {
  const backend = createInMemoryBcsBackend();
  await backend.put("agent-1", { v: 1 }, null);
  // A hostile backend that always reports conflict.
  const hostile: typeof backend = {
    ...backend,
    put: async () => ({ etag: "etag-x", conflict: true }),
  };
  const sync = new AgentStoreSync({ backend: hostile });
  await assert.rejects(
    () => sync.update("agent-1", (current) => ({ v: ((current as { v: number }).v ?? 0) + 1 })),
    (error: Error) => {
      assert.ok(error instanceof BcsConflictError);
      return true;
    },
  );
});

test("bcs: exclusive lock serializes writers and rejects a second holder", async () => {
  const backend = createInMemoryBcsBackend();
  const sync = new AgentStoreSync({ backend });
  const order: string[] = [];
  const first = sync.withLock("agent-1", "device-1", async () => {
    order.push("first-start");
    // Second writer tries to enter while the lock is held.
    await assert.rejects(
      () => sync.withLock("agent-1", "device-2", async () => order.push("second")),
      (error: Error) => {
        assert.ok(error instanceof BcsLockHeldError);
        assert.equal((error as BcsLockHeldError).ownerId, "device-1");
        return true;
      },
    );
    order.push("first-end");
  });
  await first;
  assert.deepEqual(order, ["first-start", "first-end"]);
  // After release the second writer can enter.
  await sync.withLock("agent-1", "device-2", async () => order.push("second"));
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});
