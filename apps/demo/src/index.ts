#!/usr/bin/env node
/** Open-Grokbot CLI demo: exercises the full multi-agent stack with the mock
 * LLM — user chat, agent-to-agent messaging (with priority steering), group
 * chat round-robin and broadcast fan-out.
 *
 * Usage:
 *   open-grokbot-demo                # run the full scenario
 *   open-grokbot-demo chat <agent> "<message>"
 *   open-grokbot-demo a2a <from> <to> "<message>" [--priority]
 *   open-grokbot-demo group <room> <member1,member2,...>
 *   open-grokbot-demo broadcast "<message>" [--to id1,id2]
 *   open-grokbot-demo transcript <agent>
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLlm } from "@open-grokbot/llm";
import { AgentToAgentMessaging } from "@open-grokbot/messaging";
import { SessionRuntime } from "@open-grokbot/runner";

const DATA_DIR = process.env.OPEN_GROKBOT_DATA_DIR ?? join(mkdtempSync(join(tmpdir(), "open-grokbot-")), "data");

interface DemoAgentSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly interests: readonly string[];
}

const DEMO_AGENTS: readonly DemoAgentSpec[] = [
  { id: "alpha", name: "Alpha", description: "roadmap planner", interests: ["roadmap", "plan", "sprint"] },
  { id: "beta", name: "Beta", description: "design lead", interests: ["design", "ui", "ux"] },
  { id: "gamma", name: "Gamma", description: "research analyst", interests: ["research", "data", "survey"] },
];

function createRuntime(): SessionRuntime {
  const runtime = new SessionRuntime({
    rootDir: DATA_DIR,
    llmFor: (agentId) => {
      const spec = DEMO_AGENTS.find((candidate) => candidate.id === agentId);
      return new MockLlm({
        latencyMs: 5,
        interests: spec?.interests ?? [],
        mentionableNames: DEMO_AGENTS.map((agent) => agent.name),
      });
    },
    onMessage: (agentId, content, kind) => {
      console.log(`  [${agentId}/${kind}] ${content}`);
    },
  });
  return runtime;
}

async function ensureScenario(runtime: SessionRuntime): Promise<void> {
  for (const spec of DEMO_AGENTS) {
    if (!(await runtime.hasSession(spec.id))) {
      await runtime.createAgent({
        id: spec.id,
        name: spec.name,
        description: spec.description,
      });
      console.log(`created agent ${spec.id} (${spec.name})`);
    }
  }
  if (!(await runtime.hasSession("squad"))) {
    await runtime.createAgent({
      id: "squad",
      name: "Squad",
      description: "the group room",
      isGroup: true,
      memberIds: DEMO_AGENTS.map((agent) => agent.id),
    });
    console.log(`created group room squad (${DEMO_AGENTS.map((a) => a.id).join(", ")})`);
  }
}

async function printTranscript(runtime: SessionRuntime, agentId: string): Promise<void> {
  const session = await runtime.getSession(agentId).catch(() => undefined);
  if (session == null) {
    console.log(`no agent ${agentId}`);
    return;
  }
  console.log(`\n=== transcript of ${agentId} ===`);
  for (const entry of session.getTranscriptEntries()) {
    if (entry.kind === "message") {
      const who =
        entry.fromAgent != null ? `from ${entry.fromAgent.name}` : entry.toAgent != null ? `to ${entry.toAgent.name}` : entry.role;
      console.log(`  [${entry.id}] ${who}: ${entry.content}`);
    } else if (entry.kind === "send-message") {
      const message = entry.message;
      const content = message.type === "text" ? message.content : `(${message.type})`;
      console.log(`  [${entry.id}] sent: ${content}`);
    } else if (entry.kind === "notice") {
      console.log(`  [${entry.id}] notice: ${entry.text}`);
    } else if (entry.kind === "event") {
      console.log(`  [${entry.id}] event: ${entry.event}`);
    } else {
      console.log(`  [${entry.id}] ${entry.kind}`);
    }
  }
}

async function runFullScenario(): Promise<void> {
  console.log(`Open-Grokbot demo (data dir: ${DATA_DIR})\n`);
  const runtime = createRuntime();
  await ensureScenario(runtime);
  const a2a = new AgentToAgentMessaging(runtime.hub());

  console.log("\n--- 1. user message to Alpha ---");
  await runtime.sendUserPrompt("alpha", "plan the Q3 sprint roadmap");

  console.log("\n--- 2. agent-to-agent: Alpha -> Beta ---");
  const result = await a2a.sendToAgent("alpha", "beta", "please review the design doc for the roadmap feature");
  console.log(`  ack: ${result.message}`);
  await sleep(80);
  await runtime.scheduler.drain("beta");

  console.log("\n--- 3. agent-to-agent: priority Alpha -> Gamma ---");
  const priority = await a2a.sendToAgent("alpha", "gamma", "URGENT: pull the survey data for the roadmap", { priority: true });
  console.log(`  ack: ${priority.message}`);
  await sleep(80);
  await runtime.scheduler.drain("gamma");

  console.log("\n--- 4. group chat: Squad discusses the roadmap ---");
  await runtime.sendUserPrompt("squad", "let's discuss the Q3 roadmap in the room");
  await runtime.runGroupConversation({
    groupId: "squad",
    memberIds: DEMO_AGENTS.map((agent) => agent.id),
  });

  console.log("\n--- 5. broadcast to everyone ---");
  const broadcast = await runtime.broadcastMessaging.broadcastToAgents("all", "status check: report your progress");
  console.log(`  broadcast scheduled ${broadcast.scheduled}/${broadcast.total}`);
  await sleep(80);
  for (const agent of DEMO_AGENTS) {
    await runtime.scheduler.drain(agent.id);
  }

  for (const agent of DEMO_AGENTS) {
    await printTranscript(runtime, agent.id);
  }
  await printTranscript(runtime, "squad");

  runtime.dispose();
  console.log("\ndone.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command == null || command === "full") {
    await runFullScenario();
    return;
  }
  const runtime = createRuntime();
  await ensureScenario(runtime);
  const a2a = new AgentToAgentMessaging(runtime.hub());
  switch (command) {
    case "chat": {
      const [, agentId, message] = args;
      if (agentId == null || message == null) throw new Error("usage: chat <agent> <message>");
      await runtime.sendUserPrompt(agentId, message);
      await runtime.scheduler.drain(agentId);
      break;
    }
    case "a2a": {
      const [, from, to, message, flag] = args;
      if (from == null || to == null || message == null) throw new Error("usage: a2a <from> <to> <message> [--priority]");
      const result = await a2a.sendToAgent(from, to, message, { priority: flag === "--priority" });
      console.log(result.message);
      await sleep(80);
      await runtime.scheduler.drain(to);
      break;
    }
    case "group": {
      const [, roomId, membersCsv] = args;
      if (roomId == null || membersCsv == null) throw new Error("usage: group <room> <id1,id2,...>");
      const memberIds = membersCsv.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
      await runtime.runGroupConversation({ groupId: roomId, memberIds });
      break;
    }
    case "broadcast": {
      const [, message, flag, targets] = args;
      if (message == null) throw new Error("usage: broadcast <message> [--to id1,id2]");
      const result =
        flag === "--to" && targets != null
          ? await runtime.broadcastMessaging.broadcastToAgents(targets.split(",").map((id) => id.trim()), message)
          : await runtime.broadcastMessaging.broadcastToAgents("all", message);
      console.log(`broadcast scheduled ${result.scheduled}/${result.total}`);
      for (const agent of DEMO_AGENTS) {
        await runtime.scheduler.drain(agent.id);
      }
      break;
    }
    case "transcript": {
      const agentId = args[1];
      if (agentId == null) throw new Error("usage: transcript <agent>");
      await printTranscript(runtime, agentId);
      break;
    }
    default:
      console.error(`unknown command: ${command}`);
      console.error("commands: full | chat | a2a | group | broadcast | transcript");
      process.exitCode = 1;
  }
  runtime.dispose();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
