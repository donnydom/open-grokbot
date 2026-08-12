/** Shared abstractions the messaging layer needs from the runner and session
 * layers, injected to avoid circular dependencies (the runner package wires
 * these with the real implementation). */

import type { RunLane } from "@open-grokbot/core";
import type { SandMessageAuthor, SandSendMessageImage, SandTranscriptEntry } from "@open-grokbot/state";

import type { GroupMemberRunner } from "./group-orchestrator.js";

/** An inbound agent-to-agent message queued for a recipient's wake turn. */
export interface AgentInboundMessage {
  readonly from: SandMessageAuthor;
  readonly text: string;
  readonly images?: readonly SandSendMessageImage[];
  readonly timestampMs: number;
  readonly priority?: boolean;
}

export interface AgentSession {
  readonly id: string;
  readonly name: string;
  /** Read the session's transcript (main thread). */
  getTranscriptEntries(): readonly SandTranscriptEntry[];
  /** Append one entry to the transcript (and persist). */
  appendTranscriptEntry(entry: SandTranscriptEntry): Promise<void>;
  /** Whether this session is a group room. */
  readonly isGroup: boolean;
  /** Whether this session is a remote mirror room (no local runner). */
  readonly isRemoteRoom: boolean;
}

export interface AgentSessionRegistry {
  getSession(agentId: string): Promise<AgentSession>;
  hasSession(agentId: string): Promise<boolean>;
  /** True when the agent no longer exists. */
  isAgentGone(agentId: string): Promise<boolean>;
  /** Enumerate all agent ids (for broadcasts). */
  listAgentIds?(): Promise<readonly string[]>;
}

export interface AgentRunOptions {
  /** Hidden runs produce no user-facing reply and may stay silent. */
  readonly hidden?: boolean;
  readonly isSilenceAllowed?: boolean;
}

export interface AgentRunResult {
  readonly aborted: boolean;
  readonly quiescedForUpgrade?: boolean;
}

export interface TurnRunner {
  /** Run one turn for the session with the given prompt. */
  run(session: AgentSession, prompt: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  /** Interrupt the currently running turn; returns true when one was active. */
  interrupt(reason: string): boolean;
}

export interface ExclusiveRunQueue {
  /** Enqueue one exclusive run for the agent on the given lane. */
  enqueue(
    agentId: string,
    task: () => Promise<void>,
    options: { lane: RunLane; source: string; ackToken?: string },
  ): Promise<void>;
  /** The lane of the currently active run, if any. */
  getActiveLane(agentId: string): RunLane | undefined;
}

export interface MessagingHub {
  readonly sessions: AgentSessionRegistry;
  readonly runners: Map<string, TurnRunner>;
  /** Group-member turn runners (implemented by the runner package); absent
   * members cannot take group turns. */
  readonly groupMemberRunners?: Map<string, GroupMemberRunner>;
  readonly queue: ExclusiveRunQueue;
  /** Post a message into a group room and broadcast it live. */
  postToGroup(
    fromAgentId: string,
    groupAgentId: string,
    content: string,
    priority?: boolean,
  ): Promise<string>;
  /** Emit a roster/activity update for an agent (UI delta). */
  emitAgentUpdate(agentId: string): void;
  readonly productAnalytics?: {
    trackEvent(name: string, properties: Record<string, unknown>): void;
  };
}
