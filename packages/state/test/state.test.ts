import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TranscriptStore,
  nextEntryId,
  isPeerEntry,
  AcceptanceLedger,
  sendInputDigest,
  MemoryStore,
  AutomationStore,
  AutomationScheduler,
  AgentStore,
  AGENT_LIMIT_MESSAGE,
} from "../src/index.js";

test("nextEntryId follows the turn/seq scheme", () => {
  assert.equal(nextEntryId([], "user-message"), "t0u1");
  const entries = [
    { id: "t0u1", kind: "message", role: "user", timestampMs: 1 },
    { id: "t0s1", kind: "message", role: "assistant", timestampMs: 2 },
  ] as never as Parameters<typeof nextEntryId>[0];
  assert.equal(nextEntryId(entries, "user-message"), "t0u2");
  assert.equal(nextEntryId(entries, "assistant-message"), "t0s2");
});

test("transcript store: append, thread tags, persistence round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-transcript-"));
  try {
    const mutations: string[] = [];
    const store = new TranscriptStore({
      agentId: "a1",
      dir,
      onMutation: (m) => mutations.push(m.kind),
    });
    const user = {
      id: "t0u1",
      kind: "message" as const,
      role: "user" as const,
      content: "hello",
      timestampMs: 1,
      clientNonce: "nonce-1",
    };
    const peer = {
      id: "t0u2",
      kind: "message" as const,
      role: "user" as const,
      content: "ping from beta",
      timestampMs: 2,
      fromAgent: { id: "a2", name: "Beta" },
    };
    await store.append(user);
    await store.append(peer);
    assert.equal(isPeerEntry(peer), true);
    assert.equal(isPeerEntry(user), false);
    assert.equal(store.recentUserMessages().length, 1); // peer rows excluded
    assert.deepEqual(mutations, ["entries-upserted", "entries-upserted"]);

    // persistence: a fresh store over the same dir reloads everything
    const reloaded = new TranscriptStore({ agentId: "a1", dir });
    await reloaded.load();
    assert.equal(reloaded.getAll().length, 2);
    assert.deepEqual(reloaded.getById("t0u2"), peer);

    await store.deleteEntry("t0u1");
    assert.equal(store.getAll().length, 1);
    const reloaded2 = new TranscriptStore({ agentId: "a1", dir });
    await reloaded2.load();
    assert.equal(reloaded2.getAll().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acceptance ledger: dedupe, digest mismatch, restart survival", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-ledger-"));
  try {
    const file = join(dir, "ledger.json");
    const ledger = new AcceptanceLedger({ file });
    const digest = sendInputDigest({ prompt: "hi", agentId: "a1" });

    const first = await ledger.admitSend({ accountSlot: "host", clientNonce: "n1", inputDigest: digest });
    assert.equal(first.kind, "accepted");
    const dup = await ledger.admitSend({ accountSlot: "host", clientNonce: "n1", inputDigest: digest });
    assert.equal(dup.kind, "duplicate");
    const mismatch = await ledger.admitSend({
      accountSlot: "host",
      clientNonce: "n1",
      inputDigest: sendInputDigest({ prompt: "CHANGED", agentId: "a1" }),
    });
    assert.equal(mismatch.kind, "digest-mismatch");

    await ledger.markAccepted("n1");
    assert.equal(ledger.lookup({ accountSlot: "host", clientNonce: "n1" }).state, "accepted");

    // restart survival
    const reloaded = new AcceptanceLedger({ file });
    await reloaded.load();
    assert.equal(reloaded.lookup({ accountSlot: "host", clientNonce: "n1" }).state, "accepted");
    assert.equal(reloaded.size(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory store: add/update/delete and context block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-memory-"));
  try {
    const memory = new MemoryStore({ agentId: "a1", dir });
    const first = await memory.add("prefer concise replies", { tags: ["style"] });
    await memory.add("user works at Acme");
    await memory.update(first.id, "prefer VERY concise replies");
    const block = await memory.toContextBlock();
    assert.ok(block.includes("VERY concise"));
    assert.ok(block.includes("Acme"));
    await memory.delete(first.id);
    assert.equal((await memory.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automations: interval firing respects enable flag, persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-auto-"));
  try {
    // Store clock in the past -> freshly created interval automations are due.
    const past = () => Date.now() - 2 * 60_000;
    const store = new AutomationStore({ dir, now: past });
    const enabled = await store.create({
      agentId: "a1",
      name: "daily digest",
      prompt: "summarize",
      trigger: { type: "interval", intervalMinutes: 1 },
    });
    await store.create({
      agentId: "a2",
      name: "disabled",
      prompt: "never",
      trigger: { type: "interval", intervalMinutes: 1 },
      isEnabled: false,
    });

    const fired: string[] = [];
    const scheduler = new AutomationScheduler(store, async (a) => {
      fired.push(a.id);
    }, {
      intervalMs: 30,
      now: () => Date.now(),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));
    scheduler.stop();

    assert.ok(fired.length >= 1, `fired ${fired.length} times`);
    assert.ok(fired.every((id) => id === enabled.id), "only the enabled automation fires");
    assert.ok((await store.get(enabled.id))!.runCount >= 1);
    assert.equal((await store.get("a2")!)!.runCount, 0);

    // persistence
    const reloaded = new AutomationStore({ dir });
    assert.equal((await reloaded.list()).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent store: create/read/update, group config, limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-agentstore-"));
  try {
    const store = new AgentStore({ rootDir: dir });
    const agent = await store.create({ id: "a1", name: "Alpha", description: "planner" });
    assert.equal(agent.isGroup, false);
    const group = await store.create({
      id: "g1",
      name: "Squad",
      isGroup: true,
      memberIds: ["a1"],
    });
    assert.equal(group.isGroup, true);
    assert.deepEqual(group.group?.memberIds, ["a1"]);

    const read = await store.read("a1");
    assert.equal(read?.profile.name, "Alpha");
    await store.updateProfile("a1", { title: "Designer" });
    assert.equal((await store.read("a1"))?.profile.title, "Designer");
    await store.updateSettings("a1", { hiddenFromSidebar: true });
    assert.equal((await store.read("a1"))?.settings.hiddenFromSidebar, true);

    // cap: create 50 agents -> the 51st is refused
    const store2 = new AgentStore({ rootDir: dir });
    for (let i = 0; i < 48; i++) {
      await store2.create({ id: `bulk-${i}`, name: `B${i}` });
    }
    await assert.rejects(
      store2.create({ id: "over", name: "Over" }),
      new RegExp(AGENT_LIMIT_MESSAGE),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
