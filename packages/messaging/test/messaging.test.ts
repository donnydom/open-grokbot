import assert from "node:assert/strict";
import { test } from "node:test";

import { RunScheduler } from "@open-grokbot/core";
import type { SandTranscriptEntry } from "@open-grokbot/state";
import { nextEntryId } from "@open-grokbot/state";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

import {
  AgentToAgentMessaging,
  BroadcastMessaging,
  GroupChatOrchestrator,
  SubagentRuntime,
  parseGroupMentions,
  resolveResponders,
  orderRoundSpeakers,
  isPassContent,
  type AgentSession,
  type AgentSessionRegistry,
  type MessagingHub,
  type TurnRunner,
  type GroupMemberRunner,
  type SandGroupMember,
  type SandGroupMessage,
} from "../src/index.js";

class FakeSession implements AgentSession {
  readonly entries: SandTranscriptEntry[] = [];
  readonly id: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly isRemoteRoom: boolean;

  constructor(id: string, name: string, isGroup = false, isRemoteRoom = false) {
    this.id = id;
    this.name = name;
    this.isGroup = isGroup;
    this.isRemoteRoom = isRemoteRoom;
  }

  getTranscriptEntries(): readonly SandTranscriptEntry[] {
    return [...this.entries];
  }

  async appendTranscriptEntry(entry: SandTranscriptEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class FakeRegistry implements AgentSessionRegistry {
  readonly sessions = new Map<string, FakeSession>();

  add(session: FakeSession): void {
    this.sessions.set(session.id, session);
  }

  async getSession(agentId: string): Promise<AgentSession> {
    const session = this.sessions.get(agentId);
    if (session == null) throw new Error(`no session ${agentId}`);
    return session;
  }

  async hasSession(agentId: string): Promise<boolean> {
    return this.sessions.has(agentId);
  }

  async isAgentGone(agentId: string): Promise<boolean> {
    return !this.sessions.has(agentId);
  }

  async listAgentIds(): Promise<readonly string[]> {
    return [...this.sessions.keys()];
  }
}

class FakeRunner implements TurnRunner {
  readonly runs: { session: string; prompt: string; hidden?: boolean }[] = [];
  interrupted = 0;
  private abortCurrent: (() => void) | undefined;

  async run(session: AgentSession, prompt: string, options?: { hidden?: boolean }): Promise<{ aborted: boolean }> {
    this.runs.push({ session: session.id, prompt, hidden: options?.hidden });
    if (prompt.includes("[[block]]")) {
      await new Promise<void>((resolve) => {
        this.abortCurrent = resolve;
      });
    }
    return { aborted: this.abortCurrent != null };
  }

  interrupt(): boolean {
    this.interrupted += 1;
    this.abortCurrent?.();
    this.abortCurrent = undefined;
    return true;
  }
}

class FakeMemberRunner implements GroupMemberRunner {
  readonly calls: { member: string; prompt: string }[] = [];

  constructor(
    private readonly reply: (member: string, prompt: string) => readonly string[],
  ) {}

  async runGroupMemberTurn(request: { session: AgentSession; systemPrompt: string; prompt: string }): Promise<readonly string[]> {
    this.calls.push({ member: request.session.id, prompt: request.prompt });
    return this.reply(request.session.id, request.prompt);
  }
}

function makeHub(overrides: Partial<MessagingHub> = {}): {
  hub: MessagingHub;
  registry: FakeRegistry;
  runners: Map<string, FakeRunner>;
  scheduler: RunScheduler;
  posted: { group: string; content: string }[];
} {
  const registry = new FakeRegistry();
  const runners = new Map<string, FakeRunner>();
  const scheduler = new RunScheduler();
  const posted: { group: string; content: string }[] = [];
  const hub: MessagingHub = {
    sessions: registry,
    runners,
    groupMemberRunners: overrides.groupMemberRunners ?? new Map(),
    queue: {
      enqueue: (agentId, task, options) => scheduler.enqueue(agentId, task, options),
      getActiveLane: (agentId) => scheduler.getActiveLane(agentId),
    },
    postToGroup: async (fromAgentId, groupAgentId, content) => {
      posted.push({ group: groupAgentId, content });
      return `Posted to the group.`;
    },
    emitAgentUpdate: () => {},
    ...overrides,
  };
  return { hub, registry, runners, scheduler, posted };
}

test("A2A: sendToAgent queues, wakes, mirrors on both sides", async () => {
  const { hub, registry, runners, scheduler } = makeHub();
  const alpha = new FakeSession("a1", "Alpha");
  const beta = new FakeSession("a2", "Beta");
  registry.add(alpha);
  registry.add(beta);
  const betaRunner = new FakeRunner();
  runners.set("a2", betaRunner);

  const messaging = new AgentToAgentMessaging(hub);
  const result = await messaging.sendToAgent("a1", "a2", "hello Beta");
  assert.equal(result.status, "sent");
  // The wake is fire-and-forget: give the revive loop a tick, then drain.
  await sleep(30);
  await scheduler.drain("a2");

  // Recipient was woken with a hidden turn carrying the message.
  assert.equal(betaRunner.runs.length, 1);
  assert.equal(betaRunner.runs[0]!.hidden, true);
  assert.ok(betaRunner.runs[0]!.prompt.includes("hello Beta"));

  // Inbound entry on Beta's transcript tagged fromAgent.
  const inbound = beta.entries.find(
    (e): e is Extract<typeof e, { kind: "message"; fromAgent?: unknown }> =>
      e.kind === "message" && e.fromAgent != null,
  );
  assert.ok(inbound != null);
  assert.equal(inbound.fromAgent!.id, "a1");

  // Outbound mirror on Alpha's transcript tagged toAgent.
  const outbound = alpha.entries.find(
    (e): e is Extract<typeof e, { kind: "message"; toAgent?: unknown }> =>
      e.kind === "message" && e.toAgent != null,
  );
  assert.ok(outbound != null);
  assert.equal(outbound.toAgent!.id, "a2");
});

test("A2A: guards bounce self-messages and missing agents", async () => {
  const { hub, registry } = makeHub();
  registry.add(new FakeSession("a1", "Alpha"));
  const messaging = new AgentToAgentMessaging(hub);
  assert.equal((await messaging.sendToAgent("a1", "a1", "hi")).status, "bounced");
  assert.equal((await messaging.sendToAgent("a1", "ghost", "hi")).status, "bounced");
  assert.equal((await messaging.sendToAgent("a1", "a2", "   ")).status, "bounced");
});

test("A2A: group target routes to postToGroup", async () => {
  const { hub, registry, posted } = makeHub();
  registry.add(new FakeSession("a1", "Alpha"));
  registry.add(new FakeSession("g1", "Squad", true));
  const messaging = new AgentToAgentMessaging(hub);
  const result = await messaging.sendToAgent("a1", "g1", "hello squad");
  assert.equal(result.status, "sent");
  assert.deepEqual(posted, [{ group: "g1", content: "hello squad" }]);
});

test("A2A: priority message steers a busy recipient", async () => {
  const { hub, registry, runners, scheduler } = makeHub();
  registry.add(new FakeSession("a1", "Alpha"));
  registry.add(new FakeSession("a2", "Beta"));
  const betaRunner = new FakeRunner();
  runners.set("a2", betaRunner);
  const messaging = new AgentToAgentMessaging(hub);

  // Beta is mid-background-run; the priority send interrupts it.
  const blocking = scheduler.enqueue(
    "a2",
    async () => {
      await betaRunner.run(new FakeSession("a2", "Beta"), "[[block]]", { hidden: true });
    },
    { lane: "agent", source: "agent" },
  );
  await new Promise((r) => setTimeout(r, 10));
  const result = await messaging.sendToAgent("a1", "a2", "URGENT", { priority: true });
  assert.equal(result.status, "sent");
  assert.ok(betaRunner.interrupted >= 1, "recipient interrupted");
  await blocking.catch(() => {});
  await scheduler.drain("a2");
});

test("group chat: mention parsing and responder resolution", () => {
  const members = [
    { id: "a1", name: "Alpha One" },
    { id: "a2", name: "Beta" },
    { id: "a3", name: "Gamma" },
  ] as const;
  const mentions = parseGroupMentions("hey @beta, what do you think?", members as unknown as readonly SandGroupMember[]);
  assert.deepEqual(mentions.memberIds, ["a2"]);
  assert.equal(mentions.isEveryone, false);
  const everyone = parseGroupMentions("ping @everyone", members as unknown as readonly SandGroupMember[]);
  assert.equal(everyone.isEveryone, true);

  const history: SandGroupMessage[] = [
    { speaker: { kind: "member", id: "a1", name: "Alpha One" }, content: "@beta thoughts?" },
  ];
  const responders = resolveResponders(
    members as unknown as readonly SandGroupMember[],
    history,
  );
  assert.deepEqual(responders.map((m) => m.id), ["a2"]);
});

test("group chat: round-robin speaker order rotates", () => {
  assert.deepEqual(orderRoundSpeakers(["a", "b", "c"], 0), ["a", "b", "c"]);
  assert.deepEqual(orderRoundSpeakers(["a", "b", "c"], 1), ["b", "c", "a"]);
  assert.deepEqual(orderRoundSpeakers(["a", "b", "c"], 2), ["c", "a", "b"]);
  assert.equal(isPassContent("[[pass]]"), true);
  assert.equal(isPassContent("PASS"), true);
  assert.equal(isPassContent("I have something to say"), false);
});

test("group chat orchestrator: bounded rounds, pass convergence", async () => {
  const memberRunners = new Map<string, FakeMemberRunner>();
  let a1Spoke = false;
  memberRunners.set(
    "a1",
    new FakeMemberRunner(() => {
      if (!a1Spoke) {
        a1Spoke = true;
        return ["hello all"];
      }
      return ["[[pass]]"];
    }),
  );
  memberRunners.set("a2", new FakeMemberRunner(() => ["[[pass]]"]));
  const { hub, registry } = makeHub({ groupMemberRunners: memberRunners });
  registry.add(new FakeSession("a1", "Alpha"));
  registry.add(new FakeSession("a2", "Beta"));

  const orchestrator = new GroupChatOrchestrator(hub);
  await orchestrator.run({ group: { name: "Squad", description: "test" }, memberIds: ["a1", "a2"] });
  // Round 0: a1 speaks once, a2 passes. Round 1: everyone passes -> the
  // empty round terminates the loop.
  assert.equal(memberRunners.get("a1")!.calls.length, 2);
  assert.equal(memberRunners.get("a2")!.calls.length, 2);
});

test("group chat orchestrator: message cap bounds the loop", async () => {
  const { hub, registry } = makeHub();
  registry.add(new FakeSession("a1", "Alpha"));
  registry.add(new FakeSession("a2", "Beta"));
  const memberRunners = new Map<string, FakeMemberRunner>();
  // Everyone always speaks: the loop must stop at GROUP_MAX_MEMBER_TURNS.
  memberRunners.set("a1", new FakeMemberRunner(() => ["one", "two"]));
  memberRunners.set("a2", new FakeMemberRunner(() => ["three"]));
  const hub2 = makeHub({ groupMemberRunners: memberRunners });
  const orchestrator2 = new GroupChatOrchestrator(hub2.hub);
  await orchestrator2.run({ group: { name: "Squad", description: "test" }, memberIds: ["a1", "a2"] });
  const totalMessages =
    memberRunners.get("a1")!.calls.length * 2 + memberRunners.get("a2")!.calls.length;
  // a1 posts 2/round capped at 2 per turn; totals capped at 10 messages.
  assert.ok(totalMessages <= 10, `total ${totalMessages}`);
});

test("broadcast: fans out to all agents, skips groups, one-way", async () => {
  const { hub, registry, runners, scheduler } = makeHub();
  registry.add(new FakeSession("a1", "Alpha"));
  registry.add(new FakeSession("a2", "Beta"));
  registry.add(new FakeSession("g1", "Squad", true));
  const alphaRunner = new FakeRunner();
  const betaRunner = new FakeRunner();
  runners.set("a1", alphaRunner);
  runners.set("a2", betaRunner);

  const broadcast = new BroadcastMessaging(hub);
  const result = await broadcast.broadcastToAgents("all", "status update");
  assert.equal(result.total, 3);
  assert.equal(result.scheduled, 2); // group excluded
  await scheduler.drain("a1");
  await scheduler.drain("a2");
  assert.equal(alphaRunner.runs.length, 1);
  assert.equal(betaRunner.runs.length, 1);
  assert.ok(alphaRunner.runs[0]!.prompt.includes("status update"));

  // targeted broadcast
  await broadcast.broadcastToAgents(["a1"], "only alpha");
  await scheduler.drain("a1");
  assert.equal(alphaRunner.runs.length, 2);
  assert.equal(betaRunner.runs.length, 1);
});

test("subagent runtime: dispatch, registry, steer queue, abort", async () => {
  const { hub, registry } = makeHub();
  registry.add(new FakeSession("parent-1", "Parent"));

  let steered = "";
  let steers = 0;
  let aborted = false;
  let runStarted = false;
  const runtime = new SubagentRuntime({
    hub,
    getConversationId: () => "parent-1",
    emitAsyncTasksChanged: () => {},
    runSubagent: async (params) => {
      runStarted = true;
      let resolveSettled!: () => void;
      const settled = new Promise<void>((r) => (resolveSettled = r));
      const handle = {
        steer: (p: string) => {
          steers += 1;
          steered = p;
          return true;
        },
        abort: () => {
          aborted = true;
          resolveSettled();
          return true;
        },
      };
      if (params.subagentAgentId === "sub-1") {
        // sub-1 runs to completion on its own.
        setTimeout(resolveSettled, 30);
      }
      await new Promise<void>((r) => setImmediate(r));
      return { handle, settled };
    },
  });

  assert.equal(
    runtime.dispatchBackgroundSubagent({
      subagentAgentId: "sub-1",
      subagentType: "research",
      toolCallId: "tc-1",
      prompt: "research topic X",
    }),
    true,
  );
  // duplicate dispatch is a no-op
  assert.equal(
    runtime.dispatchBackgroundSubagent({
      subagentAgentId: "sub-1",
      subagentType: "research",
      toolCallId: "tc-1",
      prompt: "again",
    }),
    false,
  );
  assert.equal(runtime.isRunning("sub-1"), true);
  assert.equal(runtime.getMeta("sub-1")?.parentAgentId, "parent-1");

  // steer before the run handle is live -> queued, then applied on start
  assert.equal(runtime.steerSubagent("sub-1", "new direction"), true);
  await runtime.awaitSubagent("sub-1");
  assert.equal(runStarted, true);
  assert.equal(steers, 1);
  assert.equal(steered, "new direction");
  assert.equal(runtime.isRunning("sub-1"), false);
  assert.equal(runtime.list().length, 1);
  assert.equal(runtime.list()[0]!.status, "completed");

  // abort path: dispatch a second subagent and abort it mid-run
  assert.equal(
    runtime.dispatchBackgroundSubagent({
      subagentAgentId: "sub-2",
      subagentType: "research",
      toolCallId: "tc-2",
      prompt: "long job",
    }),
    true,
  );
  await sleep(20); // let runSubagent resolve and register the live handle
  assert.equal(runtime.abortSubagent("sub-2"), true);
  await runtime.awaitSubagent("sub-2").catch(() => {});
  assert.equal(aborted, true);
  assert.equal(runtime.isRunning("sub-2"), false);
});
