/**
 * Interaction listener + isolation worker tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { connectInteractionListener } from "@open-grokbot/messaging";
import {
  InProcessIsolationWorker,
  runIsolationWorkerEntry,
} from "../src/agent-isolation.js";

test("interaction-listener: sendUpdate streams to handlers, query answers", async () => {
  const { listener, connection } = connectInteractionListener();
  const received: string[] = [];
  const off = listener.onUpdate((update) => received.push(update.kind));
  connection.push({ updateId: "u1", kind: "state-delta", payload: {} });
  assert.deepEqual(received, ["state-delta"]);
  const response = await listener.query({ queryId: "q1", kind: "get-state", payload: {} });
  assert.equal(response.queryId, "q1");
  off();
  connection.push({ updateId: "u2", kind: "after-unsub", payload: {} });
  assert.deepEqual(received, ["state-delta"]);
});

test("isolation-worker: in-process handler table runs jobs and reports errors", async () => {
  const worker = new InProcessIsolationWorker({
    mirror: async (args) => ({ mirrored: args }),
    boom: async () => {
      throw new Error("handler exploded");
    },
  });
  const ok = await worker.submit({ jobId: "j1", kind: "mirror", args: { a: 1 } });
  assert.deepEqual(ok, { jobId: "j1", result: { mirrored: { a: 1 } } });
  const bad = await worker.submit({ jobId: "j2", kind: "boom", args: {} });
  assert.match(bad.error ?? "", /handler exploded/);
  const unknown = await worker.submit({ jobId: "j3", kind: "nope", args: {} });
  assert.match(unknown.error ?? "", /no handler/);
  worker.close();
});

test("isolation-worker: entrypoint wires process messages (contract smoke)", () => {
  // The entrypoint registers a message handler on process. In the test
  // process no message arrives, but registration must not throw and the
  // handler table must be accepted.
  const before = process.listenerCount("message");
  runIsolationWorkerEntry({ echo: async (args) => args });
  assert.equal(process.listenerCount("message"), before + 1);
  // Remove the registered listener so the test process stays clean.
  const listeners = process.rawListeners("message");
  process.removeListener("message", listeners[listeners.length - 1] as never);
  assert.equal(process.listenerCount("message"), before);
});
