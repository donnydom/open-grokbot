/** Broadcast: one-way fan-out from the user to all (or a subset of) agents
 * (corresponds to background-wakes.ts broadcastToAgents). Strictly one-way —
 * no agent path re-enters here, so a broadcast can never loop. Scheduling is
 * sequential (so fan-out never opens every session db at once); the woken
 * turns themselves run concurrently, each on its own session queue. */

import type { AgentSession, MessagingHub } from "./types.js";

export interface BroadcastResult {
  readonly total: number;
  readonly scheduled: number;
}

function clampBroadcastMessage(text: string, maxLength = 8_000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…[truncated]`;
}

export function buildBroadcastPrompt(message: string): string {
  return [
    "The user broadcast a message to you and possibly other agents:",
    "",
    message,
    "",
    "If this message is for you, act on it and reply to the user.",
    "If it is not for you, stay silent.",
  ].join("\n");
}

export class BroadcastMessaging {
  constructor(private readonly hub: MessagingHub) {}

  async broadcastToAgents(
    targets: "all" | readonly string[],
    message: string,
  ): Promise<BroadcastResult> {
    const text = clampBroadcastMessage(message);
    if (text.length === 0) return { total: 0, scheduled: 0 };
    let ids: readonly string[];
    if (targets === "all") {
      const sessions: string[] = [];
      for (const agentId of await this.listAgentIds()) {
        sessions.push(agentId);
      }
      ids = sessions;
    } else {
      ids = [...new Set(targets)];
    }
    let scheduled = 0;
    for (const id of ids) {
      if (await this.scheduleBroadcast(id, text)) scheduled += 1;
    }
    return { total: ids.length, scheduled };
  }

  private async listAgentIds(): Promise<readonly string[]> {
    // The registry knows all sessions; the hub exposes the enumeration seam.
    const ids: string[] = [];
    for (const agentId of await this.hub.sessions.listAgentIds?.() ?? []) {
      ids.push(agentId);
    }
    return ids;
  }

  private async scheduleBroadcast(agentId: string, message: string): Promise<boolean> {
    if (await this.hub.sessions.isAgentGone(agentId)) return false;
    let session: AgentSession;
    try {
      session = await this.hub.sessions.getSession(agentId);
    } catch {
      return false;
    }
    if (session.isGroup || session.isRemoteRoom) return false;
    const runner = this.hub.runners.get(agentId);
    if (runner == null) return false;
    // Hidden wake turn on the agent lane; fan-out does not await the turns.
    void this.hub.queue
      .enqueue(
        agentId,
        async () => {
          await runner.run(session, buildBroadcastPrompt(message), {
            hidden: true,
            isSilenceAllowed: true,
          });
        },
        { lane: "agent", source: "broadcast" },
      )
      .catch((error) => {
        console.error(`[messaging] broadcast wake failed for ${agentId}`, error);
      });
    return true;
  }
}
