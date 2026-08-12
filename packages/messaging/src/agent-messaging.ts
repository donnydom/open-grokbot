/** Agent-to-agent messaging: the 1:1 private message path between agents
 * (corresponds to agent-to-agent-messaging.ts of the original host).
 *
 * Semantics:
 * - fire-and-forget: the sender never awaits the recipient's reply; a reply
 *   arrives later as a new inbound message that wakes the sender symmetrically.
 * - priority messages interrupt the recipient's non-user work (steer).
 * - inbound messages queue per recipient and are coalesced into one wake turn;
 *   a DM preemption re-drives the batch at-least-once (isRedriven guards loops).
 * - every delivery is mirrored on the sender's transcript (toAgent) and the
 *   recipient's (fromAgent), so either side can rebuild the full exchange. */

import { nextEntryId, type SandMessageAuthor, type SandSendMessageImage, type SandTranscriptEntry } from "@open-grokbot/state";

import type { AgentInboundMessage } from "./types.js";
import type { AgentSession, MessagingHub } from "./types.js";

export const SEND_TO_AGENT_TOOL_NAME = "SendToAgent";

export interface SendToAgentResult {
  readonly status: "sent" | "bounced";
  readonly message: string;
}

function clampAgentMessage(text: string, maxLength = 8_000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…[truncated]`;
}

/** The wake prompt the recipient sees for an inbound agent message. */
export function buildAgentInboundWakePrompt(message: AgentInboundMessage): string {
  const priority = message.priority === true ? "\n(priority)" : "";
  const images = message.images != null && message.images.length > 0
    ? `\n(attached ${message.images.length} image${message.images.length === 1 ? "" : "s"})`
    : "";
  return [
    `You received a message from another agent (${message.from.name}, id ${message.from.id}):${priority}`,
    "",
    message.text,
    "",
    "Reply to them with SendToAgent if a reply is warranted. You may also stay silent;",
    "the message is already visible in this chat. Do not echo the message back to the user.",
    images,
  ].join("\n");
}

/** Inbound queue bookkeeping shared with the hub. */
export interface AgentInboundEnvelope extends AgentInboundMessage {
  readonly isDisplayed?: boolean;
  readonly isRedriven?: boolean;
}

export class AgentToAgentMessaging {
  /** Inbound A2A messages queued per recipient until a wake turn drains them. */
  readonly pendingAgentInbound = new Map<string, AgentInboundEnvelope[]>();
  private readonly revivingAgentInboundIds = new Set<string>();

  constructor(private readonly hub: MessagingHub) {}

  async sendToAgent(
    fromAgentId: string,
    toAgentId: string,
    text: string,
    options: { images?: readonly SandSendMessageImage[]; priority?: boolean } = {},
  ): Promise<SendToAgentResult> {
    const message = clampAgentMessage(text);
    if (message.length === 0) {
      return { status: "bounced", message: "Message was empty; nothing was sent." };
    }
    if (toAgentId === fromAgentId) {
      return { status: "bounced", message: "An agent can't message itself." };
    }
    if (await this.hub.sessions.isAgentGone(toAgentId)) {
      return { status: "bounced", message: "That agent no longer exists." };
    }
    if (!(await this.hub.sessions.hasSession(toAgentId))) {
      return { status: "bounced", message: `No agent found with id ${toAgentId}.` };
    }
    const target = await this.hub.sessions.getSession(toAgentId);
    if (target.isRemoteRoom) {
      return {
        status: "bounced",
        message: "That is a shared chat hosted by another user; agents can't message it directly.",
      };
    }
    // A group target posts into the shared room instead of a 1:1 wake.
    if (target.isGroup) {
      const ack = await this.hub.postToGroup(fromAgentId, toAgentId, message, options.priority);
      return { status: "sent", message: ack };
    }
    const priority = options.priority === true;

    this.hub.productAnalytics?.trackEvent("sand.agent_message.sent", {
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      is_group_target: false,
      is_priority: priority,
    });

    let from: SandMessageAuthor = { id: fromAgentId, name: fromAgentId };
    try {
      const sender = await this.hub.sessions.getSession(fromAgentId);
      from = { ...from, name: sender.name };
    } catch {
      // sender name fallback to id
    }

    // Mirror on the sender's transcript.
    const senderSession = await this.hub.sessions.getSession(fromAgentId).catch(() => undefined);
    if (senderSession != null) {
      await this.appendOutboundMirror(
        senderSession,
        { id: toAgentId, name: target.name, kind: "agent" },
        message,
        Date.now(),
        options.images ?? [],
      );
    }

    const queued = this.pendingAgentInbound.get(toAgentId) ?? [];
    const inbound: AgentInboundEnvelope = {
      from,
      text: message,
      ...(options.images != null && options.images.length > 0 ? { images: options.images } : {}),
      timestampMs: Date.now(),
      ...(priority ? { priority: true } : {}),
    };
    if (priority) {
      this.pendingAgentInbound.set(toAgentId, [inbound, ...queued]);
      this.steerRecipientForPriorityPeer(toAgentId);
    } else {
      queued.push(inbound);
      this.pendingAgentInbound.set(toAgentId, queued);
    }
    void this.reviveForAgentInbound(toAgentId);
    return {
      status: "sent",
      message: priority
        ? `Sent to ${target.name} as a priority message — it will interrupt their current non-user work and wake them now. This is asynchronous; if they reply, it'll arrive later as a new message that wakes you.`
        : `Sent to ${target.name}. This is asynchronous; if they reply, it'll arrive later as a new message that wakes you.`,
    };
  }

  /** Interrupt the recipient's current non-user work for a priority message. */
  private steerRecipientForPriorityPeer(agentId: string): void {
    const runner = this.hub.runners.get(agentId);
    if (runner == null) return;
    const activeLane = this.hub.queue.getActiveLane(agentId);
    if (activeLane === "user") return; // never interrupt user work
    runner.interrupt("superseded by a priority agent message");
    this.hub.productAnalytics?.trackEvent("sand.turn.interrupt", {
      conversationId: agentId,
      reason: "agent_steer",
    });
  }

  private async reviveForAgentInbound(agentId: string): Promise<void> {
    if (this.revivingAgentInboundIds.has(agentId)) return;
    this.revivingAgentInboundIds.add(agentId);
    try {
      while ((this.pendingAgentInbound.get(agentId)?.length ?? 0) > 0) {
        const messages = this.prioritize(this.pendingAgentInbound.get(agentId) ?? []);
        this.pendingAgentInbound.delete(agentId);
        await this.runAgentInboundWake(agentId, messages);
      }
    } finally {
      this.revivingAgentInboundIds.delete(agentId);
    }
  }

  private prioritize(messages: readonly AgentInboundEnvelope[]): AgentInboundEnvelope[] {
    const priority = messages.filter((m) => m.priority === true);
    const rest = messages.filter((m) => m.priority !== true);
    return [...priority, ...rest];
  }

  private async runAgentInboundWake(
    agentId: string,
    messages: readonly AgentInboundEnvelope[],
  ): Promise<void> {
    if (messages.length === 0) return;
    let session: AgentSession;
    try {
      session = await this.hub.sessions.getSession(agentId);
    } catch {
      return;
    }
    if (session.isGroup || session.isRemoteRoom) return;
    const runner = this.hub.runners.get(agentId);
    if (runner == null) return;

    // Append only fresh entries (a re-driven message's entry already exists).
    for (const message of messages.filter((m) => m.isDisplayed !== true)) {
      const entries = session.getTranscriptEntries();
      const entry: SandTranscriptEntry = {
        kind: "message",
        id: nextEntryId(entries, "user-message"),
        role: "user",
        content: message.text,
        isStreaming: false,
        timestampMs: message.timestampMs,
        fromAgent: message.from,
        ...(message.images != null && message.images.length > 0 ? { images: message.images } : {}),
      };
      await session.appendTranscriptEntry(entry);
    }

    await this.hub.queue.enqueue(
      agentId,
      async () => {
        try {
          for (const [index, message] of messages.entries()) {
            // A newer priority message preempted this batch: re-queue the rest.
            if (index > 0 && (this.pendingAgentInbound.get(agentId) ?? []).some((p) => p.priority === true)) {
              const queued = this.pendingAgentInbound.get(agentId) ?? [];
              this.pendingAgentInbound.set(
                agentId,
                this.mergeQueues(
                  queued,
                  messages.slice(index).map((remaining) => ({ ...remaining, isDisplayed: true as const })),
                ),
              );
              return;
            }
            const result = await runner.run(
              session,
              buildAgentInboundWakePrompt(message),
              { hidden: true, isSilenceAllowed: true },
            );
            // A DM interrupted this wake: re-drive the remainder at-least-once.
            if (result.aborted && result.quiescedForUpgrade !== true) {
              if (await this.hub.sessions.isAgentGone(agentId)) return;
              const redrivable = messages
                .slice(index)
                .filter((remaining) => remaining.isRedriven !== true)
                .map((remaining) => ({ ...remaining, isDisplayed: true as const, isRedriven: true as const }));
              if (redrivable.length === 0) return;
              const queued = this.pendingAgentInbound.get(agentId) ?? [];
              this.pendingAgentInbound.set(agentId, this.mergeQueues(queued, redrivable));
              return;
            }
          }
          this.hub.emitAgentUpdate(agentId);
        } catch (error) {
          console.error(`[messaging] agent inbound wake failed for ${agentId}`, error);
          this.hub.emitAgentUpdate(agentId);
        }
      },
      { lane: "agent", source: "agent" },
    );
  }

  private mergeQueues(
    queued: readonly AgentInboundEnvelope[],
    deferred: readonly AgentInboundEnvelope[],
  ): AgentInboundEnvelope[] {
    const newerPriority = queued.filter((m) => m.priority === true);
    const olderPriority = deferred.filter((m) => m.priority === true);
    const olderRest = deferred.filter((m) => m.priority !== true);
    const newerRest = queued.filter((m) => m.priority !== true);
    return [...newerPriority, ...olderPriority, ...olderRest, ...newerRest];
  }

  private async appendOutboundMirror(
    session: AgentSession,
    to: SandMessageAuthor,
    text: string,
    timestampMs: number,
    images: readonly SandSendMessageImage[],
  ): Promise<void> {
    const entries = session.getTranscriptEntries();
    const entry: SandTranscriptEntry = {
      kind: "message",
      id: nextEntryId(entries, "assistant-message"),
      role: "assistant",
      content: text,
      isStreaming: false,
      timestampMs,
      toAgent: to,
      ...(images.length > 0 ? { images } : {}),
    };
    await session.appendTranscriptEntry(entry);
  }
}
