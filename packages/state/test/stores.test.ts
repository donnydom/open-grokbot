/**
 * New state stores tests: AgentKv, ForeverBoxStore, TeachRecordingStore,
 * WorkflowStore.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentKv, SUBAGENT_STATES_NAMESPACE } from "../src/agent-kv.js";
import { ForeverBoxStore, TeachRecordingStore, WorkflowStore } from "../src/workspaces.js";
import { SAND_DEFAULT_AGENT_NAME } from "../src/agent-store.js";

function makeDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test("agent-kv: namespaced set/get/list/delete with persistence round-trip", async () => {
  const dir = makeDir("ogb-kv-");
  const kv = new AgentKv({ dir });
  await kv.set(SUBAGENT_STATES_NAMESPACE, "sub-1", { state: "running" });
  await kv.set("other", "k", "v");
  assert.deepEqual(kv.get(SUBAGENT_STATES_NAMESPACE, "sub-1"), { state: "running" });
  assert.deepEqual(kv.namespaces(), [SUBAGENT_STATES_NAMESPACE, "other"]);
  // Persistence round-trip.
  const reloaded = new AgentKv({ dir });
  await reloaded.load();
  assert.deepEqual(reloaded.get("other", "k"), "v");
  await kv.delete("other", "k");
  assert.equal(kv.get("other", "k"), undefined);
  assert.ok(!kv.namespaces().includes("other"));
  rmSync(dir, { recursive: true, force: true });
});

test("forever-box: add/list/remove persists items", async () => {
  const dir = makeDir("ogb-box-");
  const store = new ForeverBoxStore({ dir });
  await store.add({ id: "b1", title: "t", content: "c", createdAtMs: 1 });
  assert.equal(store.list().length, 1);
  await store.remove("b1");
  assert.equal(store.list().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("teach-recording: start/append/stop captures a session", async () => {
  const dir = makeDir("ogb-teach-");
  const store = new TeachRecordingStore({ dir });
  await store.start("rec-1", "alpha");
  assert.equal(store.isRecording(), true);
  await store.appendStep("rec-1", { kind: "user-action" });
  const session = await store.stop("rec-1");
  assert.equal(session?.recordingId, "rec-1");
  assert.equal((session?.steps as unknown[]).length, 1);
  assert.equal(store.isRecording(), false);
  rmSync(dir, { recursive: true, force: true });
});

test("workflows: workflow + async task state transitions persist", async () => {
  const dir = makeDir("ogb-wf-");
  const store = new WorkflowStore({ dir });
  await store.createWorkflow({
    workflowId: "wf-1",
    agentId: "alpha",
    name: "release",
    createdAtMs: 1,
    asyncTaskIds: ["task-1"],
    state: "running",
  });
  await store.createAsyncTask({ taskId: "task-1", kind: "build", state: "queued" });
  await store.updateAsyncTaskState("task-1", "done");
  await store.updateWorkflowState("wf-1", "done");
  assert.equal(store.listAsyncTasks()[0]?.state, "done");
  assert.equal(store.listWorkflows()[0]?.state, "done");
  const reloaded = new WorkflowStore({ dir });
  await reloaded.load();
  assert.equal(reloaded.listWorkflows()[0]?.workflowId, "wf-1");
  rmSync(dir, { recursive: true, force: true });
});

test("agent-store: SAND_DEFAULT_AGENT_NAME constant matches the original default", async () => {
  assert.equal(SAND_DEFAULT_AGENT_NAME, "New Bot");
});
