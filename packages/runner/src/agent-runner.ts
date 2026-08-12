/** Agent runner: executes one turn for a session against an LLM
 * (corresponds to sand-agent-runner.ts of the original host). The runner
 * assembles the model prompt (system prompt + memory + recent transcript +
 * the new message), calls the LLM, extracts SendMessage envelopes (the only
 * user-facing voice), and appends transcript entries. */

import type { Llm } from "@open-grokbot/llm";
import type { AgentRunOptions, AgentRunResult, AgentSession, TurnRunner } from "@open-grokbot/messaging";
import { nextEntryId, type SandSendMessage, type SandTranscriptEntry } from "@open-grokbot/state";

import { parseSendMessages } from "./send-message-parser.js";

export interface AgentRunnerOptions {
  readonly llm: Llm;
  /** Read the agent's durable memory (context block). */
  readonly readMemory?: (agentId: string) => Promise<string>;
  /** Called for every user-facing message the agent produces. */
  readonly onProducedMessage?: (agentId: string, message: SandSendMessage, entry: SandTranscriptEntry) => void;
  /** Recent-message window fed to the model (main-thread tail). */
  readonly historyLimit?: number;
  readonly maxOutputLength?: number;
}

export interface AgentTurnInput {
  /** A plain user/composer message (the normal case). */
  readonly type: "user" | "wake" | "group" | "broadcast";
  readonly text: string;
}

/** The parsed result of one turn. */
export interface AgentTurnOutput {
  /** Messages the agent produced via SendMessage envelopes. */
  readonly messages: readonly { message: SandSendMessage; raw: string }[];
  /** The assistant's raw output (scratchpad; not user-visible). */
  readonly rawOutput: string;
}

export class AgentRunner implements TurnRunner {
  private readonly llm: Llm;
  private readonly readMemory?: (agentId: string) => Promise<string>;
  private readonly onProducedMessage?: AgentRunnerOptions["onProducedMessage"];
  private readonly historyLimit: number;
  private readonly maxOutputLength: number;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(options: AgentRunnerOptions) {
    this.llm = options.llm;
    this.readMemory = options.readMemory;
    this.onProducedMessage = options.onProducedMessage;
    this.historyLimit = options.historyLimit ?? 24;
    this.maxOutputLength = options.maxOutputLength ?? 32_000;
  }

  async run(
    session: AgentSession,
    prompt: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const controller = new AbortController();
    this.activeControllers.set(session.id, controller);
    try {
      const system = this.buildSystemPrompt(session);
      const context = await this.readMemory?.(session.id) ?? "";
      const transcriptBlock = this.buildTranscriptBlock(session);
      const user = [transcriptBlock, prompt].filter((part) => part.length > 0).join("\n\n");
      const output = await this.llm.complete(
        { system, user, ...(context.length > 0 ? { context } : {}) },
        controller.signal,
      );
      const result = this.processOutput(session, output);
      await this.appendAssistantEntries(session, output, result.messages);
      return { aborted: controller.signal.aborted };
    } catch (error) {
      if (controller.signal.aborted) {
        return { aborted: true };
      }
      throw error;
    } finally {
      this.activeControllers.delete(session.id);
    }
  }

  interrupt(reason: string): boolean {
    let interrupted = false;
    for (const controller of this.activeControllers.values()) {
      controller.abort(new Error(reason));
      interrupted = true;
    }
    return interrupted;
  }

  /** Parse SendMessage envelopes out of raw output. */
  processOutput(session: AgentSession, output: string): AgentTurnOutput {
    const messages = parseSendMessages(output.slice(0, this.maxOutputLength));
    return { messages, rawOutput: output };
  }

  private buildSystemPrompt(session: AgentSession): string {
    return [
      `You are ${session.name} (id ${session.id}), an autonomous agent.`,
      "You act on the user's messages and messages from other agents.",
      "Your only voice to the user is a SendMessage envelope; plain text is your private scratchpad.",
      'Emit exactly one line: SendMessage: {"type":"text","content":"..."} when you want to say something.',
      "To reply to another agent's message, say it to the user via SendMessage.",
    ].join("\n");
  }

  private buildTranscriptBlock(session: AgentSession): string {
    const entries = session.getTranscriptEntries().slice(-this.historyLimit);
    if (entries.length === 0) return "(conversation so far: empty)";
    return [
      "Conversation so far (newest last):",
      ...entries.map((entry) => {
        if (entry.kind === "message") {
          const direction =
            entry.fromAgent != null
              ? `from ${entry.fromAgent.name}`
              : entry.toAgent != null
                ? `to ${entry.toAgent.name}`
                : entry.role;
          return `[${entry.id}] ${direction}: ${entry.content}`;
        }
        if (entry.kind === "send-message") {
          return `[${entry.id}] you sent: ${JSON.stringify(entry.message)}`;
        }
        if (entry.kind === "user-attachment") {
          return `[${entry.id}] user attachment: ${entry.fileName ?? entry.url}`;
        }
        if (entry.kind === "notice") return `[${entry.id}] notice: ${entry.text}`;
        if (entry.kind === "event") return `[${entry.id}] event: ${entry.event}`;
        return `[${entry.id}] ${entry.kind}`;
      }),
    ].join("\n");
  }

  private async appendAssistantEntries(
    session: AgentSession,
    output: string,
    messages: readonly { message: SandSendMessage; raw: string }[],
  ): Promise<void> {
    const entries = session.getTranscriptEntries();
    // The assistant's raw output is a scratchpad: record it as a tool-call-ish
    // entry only when it is not pure scratch (kept small).
    if (output.trim().length > 0 && messages.length === 0) {
      const notice: SandTranscriptEntry = {
        kind: "event",
        id: nextEntryId(entries, "notice"),
        event: "assistant-scratch",
        timestampMs: Date.now(),
        payload: { text: output.slice(0, 2_000) },
      };
      await session.appendTranscriptEntry(notice);
    }
    for (const { message, raw } of messages) {
      const entry: SandTranscriptEntry = {
        kind: "send-message",
        id: nextEntryId(session.getTranscriptEntries(), "assistant-message"),
        role: "assistant",
        message,
        timestampMs: Date.now(),
      };
      await session.appendTranscriptEntry(entry);
      this.onProducedMessage?.(session.id, message, entry);
      void raw;
    }
  }
}
