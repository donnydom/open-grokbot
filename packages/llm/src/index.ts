/** LLM abstraction: the minimal surface the runner needs. */

export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  /** Optional context/memory block injected before the user message. */
  readonly context?: string;
}

export interface Llm {
  readonly name: string;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<string>;
}

/** A deterministic mock LLM for tests and demos. Behavior is rule-driven:
 * - when the user message names another agent ("@Name" or "Name,"), reply to
 *   that agent with a canned message (via the SendMessage JSON envelope);
 * - when the prompt is a group turn and the topic keyword is not in the
 *   agent's interest list, reply "[[pass]]";
 * - otherwise echo a templated reply.
 */
export class MockLlm implements Llm {
  readonly name = "mock";

  constructor(
    private readonly options: {
      /** Per-agent interests; group turns pass when the topic does not match. */
      readonly interests?: readonly string[];
      /** When set, replies to other agents are drawn from this map. */
      readonly replies?: ReadonlyMap<string, string>;
      /** When set, turns mentioning one of these agent names get a reply. */
      readonly mentionableNames?: readonly string[];
      /** Delay per completion to simulate latency. */
      readonly latencyMs?: number;
    } = {},
  ) {}

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<string> {
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) {
      await sleep(latency, signal);
    }
    const text = request.user;

    // Group turn: pass unless the topic matches an interest. The kickoff
    // message ("You are starting the conversation") carries no topic and must
    // be answered.
    if (text.includes("Group chat:")) {
      const interests = this.options.interests ?? [];
      const isKickoff = text.includes("You are starting the conversation");
      if (!isKickoff && interests.length > 0 && !interests.some((i) => text.toLowerCase().includes(i))) {
        return "[[pass]]";
      }
      return this.groupReply(request);
    }

    // Agent-to-agent wake: reply to the sender.
    const wakeMatch = /You received a message from another agent \(([^,]+), id ([^)]+)\)/.exec(
      text,
    );
    if (wakeMatch != null) {
      const senderName = wakeMatch[1]!.trim();
      const reply =
        this.options.replies?.get(senderName) ??
        `Thanks for the note, ${senderName}! I'll take a look.`;
      return `SendMessage: {"type":"text","content":"${reply}"}`;
    }

    // Broadcast: acknowledge only when the message targets this agent's name.
    const myName = this.extractMyName(request.system);
    if (text.includes("broadcast a message")) {
      if (myName != null && text.toLowerCase().includes(myName.toLowerCase())) {
        return `SendMessage: {"type":"text","content":"On it — acknowledging the broadcast."}`;
      }
      return "[[pass]]";
    }

    // Plain user chat: reply conversationally.
    return `SendMessage: {"type":"text","content":"(mock ${myName ?? "agent"}) Got it: ${truncate(text, 80)}"}`;
  }

  private groupReply(request: LlmRequest): string {
    const myName = this.extractMyName(request.system);
    const mentionable = this.options.mentionableNames ?? [];
    const mentioned = mentionable.filter((name) => request.user.toLowerCase().includes(`@${name.toLowerCase()}`));
    const content =
      mentioned.length > 0
        ? `${myName ?? "member"}: good point${mentioned.length > 0 ? ` — @${mentioned[0]} what do you think?` : ""}`
        : `${myName ?? "member"} agrees with the direction.`;
    return `SendMessage: {"type":"text","content":"${content}"}`;
  }

  private extractMyName(system: string): string | undefined {
    const match = /You are ([^ ]+)/.exec(system);
    return match?.[1];
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
