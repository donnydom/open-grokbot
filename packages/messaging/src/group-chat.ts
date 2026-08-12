/** Group chat protocol: constants, @-mention parsing, speaker ordering and
 * prompt building (corresponds to groups/group-chat.ts of the original host). */

export const GROUP_CONFIG_VERSION = 1;
export const GROUP_MAX_MEMBER_TURNS = 10;
export const GROUP_MAX_ROUNDS = 3;
export const GROUP_PROMPT_HISTORY_LIMIT = 24;
export const GROUP_MAX_MESSAGES_PER_TURN = 2;
export const SHARED_ROOM_HISTORY_LIMIT = 24;
export const GROUP_MAX_MEMBERS = 6;
export const GROUP_CHAT_TAG_PREFIX = "[Group chat: ";

export interface SandGroupMember {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type SandGroupSpeaker =
  | { readonly kind: "user"; readonly name?: string }
  | { readonly kind: "member"; readonly id: string; readonly name: string };

export interface SandGroupMessage {
  readonly speaker: SandGroupSpeaker;
  readonly content: string;
}

export interface SandGroupIdentity {
  readonly name: string;
  readonly description: string;
}

export interface SandGroupMentionTargets {
  readonly isEveryone: boolean;
  readonly memberIds: readonly string[];
}

export function orderRoundSpeakers(
  memberIds: readonly string[],
  round: number,
): readonly string[] {
  if (memberIds.length === 0) return [];
  const offset = ((round % memberIds.length) + memberIds.length) % memberIds.length;
  return [...memberIds.slice(offset), ...memberIds.slice(0, offset)];
}

function memberMentionHandles(name: string): readonly string[] {
  const lower = name.trim().toLowerCase();
  if (lower.length === 0) return [];
  const handles = new Set<string>([lower, lower.replace(/\s+/g, "")]);
  const first = lower.split(/\s+/)[0];
  if (first != null && first.length > 0) handles.add(first);
  return [...handles];
}

const EVERYONE_MENTION = /(?:^|[^a-z0-9])@(everyone|all)\b/;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

function hasMentionAt(lower: string, handle: string): boolean {
  const needle = `@${handle}`;
  let index = lower.indexOf(needle);
  while (index >= 0) {
    const before = lower[index - 1];
    const after = lower[index + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    index = lower.indexOf(needle, index + 1);
  }
  return false;
}

/** Parse @-mentions from a message: @everyone/@all or member name handles. */
export function parseGroupMentions(
  text: string,
  members: readonly { readonly id: string; readonly name: string }[],
): SandGroupMentionTargets {
  const lower = text.toLowerCase();
  const isEveryone = EVERYONE_MENTION.test(lower);
  const memberIds: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.id)) continue;
    for (const handle of memberMentionHandles(member.name)) {
      if (hasMentionAt(lower, handle)) {
        memberIds.push(member.id);
        seen.add(member.id);
        break;
      }
    }
  }
  return { isEveryone, memberIds };
}

/** Who answers this round: @-mentioned members only, else everyone. */
export function resolveResponders(
  members: readonly SandGroupMember[],
  history: readonly SandGroupMessage[],
): readonly SandGroupMember[] {
  const lastMessage = history[history.length - 1];
  if (lastMessage == null || lastMessage.speaker.kind !== "member") return members;
  const mentions = parseGroupMentions(lastMessage.content, members);
  if (mentions.isEveryone) return members;
  if (mentions.memberIds.length > 0) {
    return members.filter((member) => mentions.memberIds.includes(member.id));
  }
  return members;
}

/** A member's "pass" marker: the single token that means "nothing to add". */
export function isPassContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === "[[pass]]" || trimmed === "[pass]" || trimmed === "PASS";
}

export function isPotentialPassPrefix(text: string): boolean {
  return /^\[?\[?pass/i.test(text.trim());
}

export function formatGroupHistory(
  history: readonly SandGroupMessage[],
  limit = GROUP_PROMPT_HISTORY_LIMIT,
): string {
  const window = history.slice(-limit);
  if (window.length === 0) return "(no messages yet)";
  return window
    .map((message) => {
      const speaker =
        message.speaker.kind === "user"
          ? `User${message.speaker.name != null ? ` (${message.speaker.name})` : ""}`
          : message.speaker.name;
      return `${speaker}: ${message.content}`;
    })
    .join("\n");
}

/** Messages in the room that are new since `memberId` last spoke. */
export function messagesSinceMemberLastSpoke(
  history: readonly SandGroupMessage[],
  memberId: string,
): readonly SandGroupMessage[] {
  let lastSpokeIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.speaker.kind === "member" && message.speaker.id === memberId) {
      lastSpokeIndex = i;
      break;
    }
  }
  return history.slice(lastSpokeIndex + 1);
}

export function formatGroupChatTag(name: string): string {
  return `${GROUP_CHAT_TAG_PREFIX}${name}]`;
}

export function buildGroupMemberSystemPrompt(
  member: SandGroupMember,
  group: SandGroupIdentity,
  peers: readonly SandGroupMember[],
): string {
  const peerList =
    peers.length === 0
      ? "(you are the only member)"
      : peers.map((peer) => `- ${peer.name}: ${peer.description}`).join("\n");
  return [
    `You are ${member.name} in the group chat "${group.name}".`,
    group.description.length > 0 ? `Group purpose: ${group.description}` : "",
    "Other members:",
    peerList,
    "",
    "Rules:",
    "- Speak only when you have something real to add; otherwise reply with exactly [[pass]].",
    "- You may @-mention another member (e.g. @Beta) to pull them into the discussion.",
    "- Max 2 messages per turn. Never repeat what another member already said.",
    "- The user can see this group chat; keep messages user-facing and clean.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function buildGroupTurnPrompt(args: {
  readonly member: SandGroupMember;
  readonly group: SandGroupIdentity;
  readonly peers: readonly SandGroupMember[];
  readonly newMessages: readonly SandGroupMessage[];
}): string {
  const history = formatGroupHistory(args.newMessages);
  return [
    `Group chat: ${args.group.name}`,
    args.newMessages.length === 0
      ? "You are starting the conversation. Say something useful for the group."
      : `New messages since your last turn:\n${history}`,
    "",
    "Respond with the message(s) you want to post, or [[pass]] to stay quiet.",
  ].join("\n");
}
