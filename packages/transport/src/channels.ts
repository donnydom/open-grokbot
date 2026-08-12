/** SSE channel <-> event family mapping, mirroring the gateway-event-families
 * contract of the original platform: the host emits events on named SSE
 * channels; the coordinator maps them to typed event families before fanning
 * out on the MessagePorts. */

export const SSE_CHANNEL_BY_FAMILY = {
  transcript: "transcript",
  agents: "agents",
  "agent-upserted": "agent-upserted",
  tray: "tray",
  "agents-workflow": "workflows",
  subagents: "subagents",
  "async-tasks": "async-tasks",
  "agents-automation": "automations",
  "mcp-servers-updated": "mcp-servers",
  "forever-box": "forever-box",
  "teach-recording": "teach-recording",
  "box-disk-pressure": "box-disk-pressure",
  "computer-action": "computer-action",
  outline: "outline",
  sharing: "sharing",
  "host-settings": "host-settings",
} as const;

export type EventFamily = keyof typeof SSE_CHANNEL_BY_FAMILY & string;

const FAMILY_BY_SSE_CHANNEL = new Map<string, EventFamily>(
  (Object.entries(SSE_CHANNEL_BY_FAMILY) as [EventFamily, string][]).map(([family, channel]) => [
    channel,
    family,
  ]),
);

export function eventFamilyForSseChannel(channel: string): EventFamily | null {
  return FAMILY_BY_SSE_CHANNEL.get(channel) ?? null;
}

export function sseChannelForEventFamily(family: string): string | null {
  return (SSE_CHANNEL_BY_FAMILY as Record<string, string>)[family] ?? null;
}
