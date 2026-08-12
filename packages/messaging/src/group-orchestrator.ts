/** Group chat orchestrator: bounded round-robin so a set of agents reply to
 * each other in a shared room (corresponds to group-chat-orchestrator.ts).
 *
 * Termination is guaranteed three ways: a hard cap on total member messages,
 * a cap on full rotations, and an early exit the moment a whole round produces
 * nothing (everyone passed). A superseding user message also stops it. */

import type { AgentSession, MessagingHub, TurnRunner } from "./types.js";
import {
  buildGroupMemberSystemPrompt,
  buildGroupTurnPrompt,
  GROUP_MAX_MEMBER_TURNS,
  GROUP_MAX_MESSAGES_PER_TURN,
  GROUP_MAX_ROUNDS,
  isPassContent,
  messagesSinceMemberLastSpoke,
  orderRoundSpeakers,
  resolveResponders,
  SHARED_ROOM_HISTORY_LIMIT,
  type SandGroupIdentity,
  type SandGroupMember,
  type SandGroupMessage,
} from "./group-chat.js";

export interface RunGroupConversationArgs {
  readonly group: SandGroupIdentity;
  readonly memberIds: readonly string[];
  /** When true the room is shared across users and carries no private state. */
  readonly isSharedRoom?: boolean;
  /** Called before each member turn; false bails the loop (superseded). */
  readonly isCurrent?: () => boolean;
  /** Called for every posted member message (room broadcast). */
  readonly onMemberMessage?: (member: SandGroupMember, content: string) => void;
}

/** Runs one member's isolated group turn and returns the messages it chose to
 * send (empty when the member passed). Implemented by the runner package. */
export interface GroupMemberRunner {
  runGroupMemberTurn(request: {
    readonly session: AgentSession;
    readonly systemPrompt: string;
    readonly prompt: string;
  }): Promise<readonly string[]>;
}

/** Drives a bounded round-robin group conversation over the hub's runners. */
export class GroupChatOrchestrator {
  constructor(private readonly hub: MessagingHub) {}

  async run(args: RunGroupConversationArgs): Promise<void> {
    const members: SandGroupMember[] = [];
    for (const memberId of args.memberIds) {
      try {
        const session = await this.hub.sessions.getSession(memberId);
        members.push({ id: session.id, name: session.name, description: "" });
      } catch {
        // drop members that no longer exist
      }
    }
    if (members.length === 0) return;
    const memberById = new Map(members.map((member) => [member.id, member]));
    const history: SandGroupMessage[] = [];
    const isSharedRoom = args.isSharedRoom === true;

    let totalMessages = 0;
    for (let round = 0; round < GROUP_MAX_ROUNDS; round++) {
      if (args.isCurrent != null && !args.isCurrent()) return;
      const responderIds = resolveResponders(members, history).map((member) => member.id);
      let messagesThisRound = 0;
      for (const memberId of orderRoundSpeakers(responderIds, round)) {
        if (totalMessages >= GROUP_MAX_MEMBER_TURNS) return;
        if (args.isCurrent != null && !args.isCurrent()) return;
        const member = memberById.get(memberId);
        if (member == null) continue;
        const sent = await this.runOneTurn(args.group, member, members, history, isSharedRoom);
        let hitCap = false;
        for (const content of sent) {
          const message: SandGroupMessage = { speaker: { kind: "member", id: member.id, name: member.name }, content };
          history.push(message);
          args.onMemberMessage?.(member, content);
          totalMessages += 1;
          messagesThisRound += 1;
          if (totalMessages >= GROUP_MAX_MEMBER_TURNS) {
            hitCap = true;
            break;
          }
        }
        if (hitCap) return;
      }
      // A full rotation with nothing new means the conversation settled.
      if (messagesThisRound === 0) return;
    }
  }

  private async runOneTurn(
    group: SandGroupIdentity,
    member: SandGroupMember,
    members: readonly SandGroupMember[],
    history: readonly SandGroupMessage[],
    isSharedRoom: boolean,
  ): Promise<readonly string[]> {
    const peers = members.filter((other) => other.id !== member.id);
    const newMessages = isSharedRoom
      ? history.slice(-SHARED_ROOM_HISTORY_LIMIT)
      : messagesSinceMemberLastSpoke(history, member.id);
    const memberRunner = this.hub.groupMemberRunners?.get(member.id);
    if (memberRunner == null) return [];
    let session: AgentSession;
    try {
      session = await this.hub.sessions.getSession(member.id);
    } catch {
      return [];
    }
    const systemPrompt = buildGroupMemberSystemPrompt(member, group, peers);
    const prompt = buildGroupTurnPrompt({ member, group, peers, newMessages });
    const result = await memberRunner.runGroupMemberTurn({ session, systemPrompt, prompt });
    const spoken: string[] = [];
    for (const content of result) {
      if (isPassContent(content)) continue;
      const trimmed = content.trim();
      if (trimmed.length === 0) continue;
      spoken.push(trimmed);
      if (spoken.length >= GROUP_MAX_MESSAGES_PER_TURN) break;
    }
    return spoken;
  }
}
