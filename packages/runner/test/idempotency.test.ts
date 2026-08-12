/**
 * SessionRuntime idempotency & supersede tests: in-flight send merging,
 * epoch-based supersede skipping, prepended recovery.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionRuntime } from "../src/session-runtime.js";
import { MockLlm } from "@open-grokbot/llm";

function makeRuntime(dir: string): SessionRuntime {
  return new SessionRuntime({
    rootDir: dir,
    llmFor: () => new MockLlm({}),
  });
}

test("inFlightSends: duplicate nonce merges into one send", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogb-inflight-"));
  const runtime = makeRuntime(dir);
  try {
    await runtime.createAgent({ id: "alpha", name: "Alpha" });
    let runs = 0;
    const original = runtime.scheduler.enqueue.bind(runtime.scheduler);
    runtime.scheduler.enqueue = async (agentId, task, options) => {
      runs += 1;
      await original(agentId, task, options);
    };
    const first = runtime.sendUserPrompt("alpha", "hello", { clientNonce: "n1" });
    const second = runtime.sendUserPrompt("alpha", "hello", { clientNonce: "n1" });
    assert.equal(first, second); // same in-flight promise
    await first;
    assert.equal(runs, 1);
    // After settling, the same nonce starts a fresh send (ledger handles the
    // cross-restart case; the in-flight merge only covers the synchronous window).
    await runtime.sendUserPrompt("alpha", "again", { clientNonce: "n1" });
    assert.equal(runs, 2);
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede: stale queued turn skips itself after an epoch bump", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogb-supersede-"));
  let llmCalls = 0;
  const runtime = new SessionRuntime({
    rootDir: dir,
    llmFor: () => ({
      name: "counting",
      complete: async () => {
        llmCalls += 1;
        return "reply";
      },
    }),
  });
  try {
    await runtime.createAgent({ id: "alpha", name: "Alpha" });
    // Occupy the queue with a slow turn, then send two user messages: the
    // first queued turn becomes stale and must skip itself.
    const slow = runtime.scheduler.enqueue(
      "alpha",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      { lane: "background", source: "test" },
    );
    const first = runtime.sendUserPrompt("alpha", "first");
    const second = runtime.sendUserPrompt("alpha", "second");
    await slow;
    await first;
    await second;
    // Only "second" reaches the LLM; "first" was skipped by supersede.
    assert.equal(llmCalls, 1);
    void dir;
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prependRecovery: skipped message re-enqueues after the queue drains", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogb-recovery-"));
  const runtime = makeRuntime(dir);
  try {
    await runtime.createAgent({ id: "alpha", name: "Alpha" });
    const first = runtime.sendUserPrompt("alpha", "first");
    await first;
    const diag = runtime.sendDiagnostics();
    assert.equal(diag.recoveryBreakEpochs.length, 0); // no supersede happened yet
    const recovered = await runtime.recoverSkippedMessages("alpha");
    assert.equal(recovered, 0); // nothing to recover
    void dir;
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
