/** Session runtime: the composition root wiring state, scheduling, messaging
 * and runners into one host (corresponds to the host composition of the
 * original platform, in-process form). The demo and integration tests build
 * one of these and drive it through the same messaging surfaces the real
 * product exposes. */

import { RunLifecycle, RunScheduler } from "@open-grokbot/core";
import type { AgentSession, AgentSessionRegistry, GroupMemberRunner, MessagingHub, TurnRunner } from "@open-grokbot/messaging";
import { AgentToAgentMessaging, BroadcastMessaging, GroupChatOrchestrator } from "@open-grokbot/messaging";
import { AgentStore, AutomationScheduler, AutomationStore, MemoryStore, nextEntryId, TranscriptStore, type SandTranscriptEntry } from "@open-grokbot/state";

import { AgentRunner } from "./agent-runner.js";
import type { Llm } from "@open-grokbot/llm";

export interface SessionRuntimeOptions {
  readonly rootDir: string;
  readonly llmFor: (agentId: string) => Llm;
  readonly onMessage?: (agentId: string, content: string, kind: string) => void;
  readonly now?: () => number;
}

export class SessionRuntime implements AgentSessionRegistry {
  readonly agentStore: AgentStore;
  readonly scheduler = new RunScheduler();
  readonly lifecycle = new RunLifecycle();
  readonly runners = new Map<string, TurnRunner>();
  readonly groupMemberRunners = new Map<string, GroupMemberRunner>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly transcripts = new Map<string, TranscriptStore>();
  private readonly memories = new Map<string, MemoryStore>();
  private readonly automationStore: AutomationStore;
  private readonly automationScheduler: AutomationScheduler;
  private readonly a2a: AgentToAgentMessaging;
  private readonly broadcast: BroadcastMessaging;
  readonly groupChat = new GroupChatOrchestrator(this.hub());
  private readonly llmFor: (agentId: string) => Llm;
  private readonly onMessage?: (agentId: string, content: string, kind: string) => void;

  constructor(options: SessionRuntimeOptions) {
    this.agentStore = new AgentStore({ rootDir: options.rootDir, now: options.now });
    this.llmFor = options.llmFor;
    this.onMessage = options.onMessage;
    this.lifecycle.attach(this.scheduler);
    this.a2a = new AgentToAgentMessaging(this.hub());
    this.broadcast = new BroadcastMessaging(this.hub());
    this.automationStore = new AutomationStore({ dir: options.rootDir, now: options.now });
    this.automationScheduler = new AutomationScheduler(
      this.automationStore,
      async (automation) => {
        const session = await this.getSession(automation.agentId).catch(() => undefined);
        if (session == null) return;
        const runner = this.runners.get(automation.agentId);
        if (runner == null) return;
        await this.scheduler.enqueue(
          automation.agentId,
          async () => {
            await runner.run(session, automation.prompt, { hidden: true, isSilenceAllowed: true });
          },
          { lane: "background", source: "automation" },
        );
      },
      { intervalMs: 30_000, now: options.now },
    );
  }

  /** The messaging hub view of this runtime. */
  hub(): MessagingHub {
    return {
      sessions: this,
      runners: this.runners,
      groupMemberRunners: this.groupMemberRunners,
      queue: {
        enqueue: (agentId, task, options) => this.scheduler.enqueue(agentId, task, options),
        getActiveLane: (agentId) => this.scheduler.getActiveLane(agentId),
      },
      postToGroup: async (fromAgentId, groupAgentId, content) => {
        const group = await this.getSession(groupAgentId).catch(() => undefined);
        if (group == null) return "Group not found.";
        await group.appendTranscriptEntry({
          kind: "message",
          id: nextEntryId(group.getTranscriptEntries(), "user-message"),
          role: "user",
          content,
          timestampMs: Date.now(),
          fromAgent: { id: fromAgentId, name: fromAgentId },
        });
        this.onMessage?.(groupAgentId, content, "group");
        return "Posted to the group.";
      },
      emitAgentUpdate: () => {},
    };
  }

  get a2aMessaging(): AgentToAgentMessaging {
    return this.a2a;
  }

  get broadcastMessaging(): BroadcastMessaging {
    return this.broadcast;
  }

  /** Create an agent and its session/runner; optionally a group. */
  async createAgent(input: {
    id: string;
    name: string;
    description?: string;
    isGroup?: boolean;
    memberIds?: readonly string[];
    llm?: Llm;
  }): Promise<RuntimeSession> {
    await this.agentStore.create({
      id: input.id,
      name: input.name,
      description: input.description,
      ...(input.isGroup === true ? { isGroup: true, memberIds: input.memberIds ?? [] } : {}),
    });
    const dir = this.agentStore.agentDir(input.id);
    const transcript = new TranscriptStore({ agentId: input.id, dir });
    await transcript.load();
    this.transcripts.set(input.id, transcript);
    const memory = new MemoryStore({ agentId: input.id, dir });
    await memory.load();
    this.memories.set(input.id, memory);
    const session = new RuntimeSession(
      input.id,
      input.name,
      input.isGroup === true,
      transcript,
    );
    this.sessions.set(input.id, session);
    if (input.isGroup !== true) {
      const llm = input.llm ?? this.llmFor(input.id);
      const runner = new AgentRunner({
        llm,
        readMemory: async (agentId) => (await this.memories.get(agentId)?.list())?.map((m) => m.text).join("\n") ?? "",
        onProducedMessage: (agentId, message, entry) => {
          if (message.type === "text") {
            this.onMessage?.(agentId, message.content, "send-message");
          }
          void entry;
        },
      });
      this.runners.set(input.id, runner);
      this.groupMemberRunners.set(input.id, {
        runGroupMemberTurn: async (request) => {
          const produced: string[] = [];
          const inner = new AgentRunner({
            llm,
            readMemory: async (agentId) => (await this.memories.get(agentId)?.list())?.map((m) => m.text).join("\n") ?? "",
            onProducedMessage: (_agentId, message) => {
              if (message.type === "text") produced.push(message.content);
            },
          });
          await inner.run(request.session, `${request.systemPrompt}\n\n${request.prompt}`, {
            hidden: true,
            isSilenceAllowed: true,
          });
          return produced;
        },
      });
    }
    return session;
  }

  async sendUserPrompt(agentId: string, prompt: string, options?: { clientNonce?: string }): Promise<void> {
    const session = await this.getSession(agentId);
    const nonce = options?.clientNonce;
    const entry: SandTranscriptEntry = {
      kind: "message",
      id: nextEntryId(session.getTranscriptEntries(), "user-message"),
      role: "user",
      content: prompt,
      timestampMs: Date.now(),
      ...(nonce != null ? { clientNonce: nonce } : {}),
    };
    await session.appendTranscriptEntry(entry);
    const runner = this.runners.get(agentId);
    if (runner == null) return;
    await this.scheduler.enqueue(
      agentId,
      async () => {
        await runner.run(session, prompt, {});
      },
      { lane: "user", source: "user" },
    );
  }

  async runGroupConversation(args: {
    groupId: string;
    memberIds: readonly string[];
    onMemberMessage?: (member: string, content: string) => void;
  }): Promise<void> {
    const group = await this.getSession(args.groupId);
    await this.groupChat.run({
      group: { name: group.name, description: "" },
      memberIds: args.memberIds,
      onMemberMessage: async (member, content) => {
        // Every posted member message lands on the room transcript, tagged
        // with the speaking member (fromAgent) so the room reads as a chat.
        await group.appendTranscriptEntry({
          kind: "message",
          id: nextEntryId(group.getTranscriptEntries(), "user-message"),
          role: "user",
          content,
          timestampMs: Date.now(),
          fromAgent: { id: member.id, name: member.name },
        });
        this.onMessage?.(args.groupId, `${member.name}: ${content}`, "group");
        args.onMemberMessage?.(member.id, content);
      },
    });
  }

  // --- AgentSessionRegistry ---

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

  startAutomations(): void {
    this.automationScheduler.start();
  }

  stopAutomations(): void {
    this.automationScheduler.stop();
  }

  dispose(): void {
    this.stopAutomations();
    this.scheduler.dispose();
  }
}

/** In-process agent session backed by a TranscriptStore. */
export class RuntimeSession implements AgentSession {
  readonly id: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly isRemoteRoom = false;

  constructor(
    id: string,
    name: string,
    isGroup: boolean,
    private readonly transcript: TranscriptStore,
  ) {
    this.id = id;
    this.name = name;
    this.isGroup = isGroup;
  }

  getTranscriptEntries(): readonly SandTranscriptEntry[] {
    return this.transcript.getAll();
  }

  async appendTranscriptEntry(entry: SandTranscriptEntry): Promise<void> {
    await this.transcript.append(entry);
  }

  async clearTranscript(): Promise<void> {
    await this.transcript.clear();
  }
}
