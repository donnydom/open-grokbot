/** SendMessage parsing: the agent's only voice to the user is the
 * SendMessage envelope in its raw output; plain assistant text is a private
 * scratchpad. Group members likewise "speak" by emitting SendMessage
 * envelopes. */

import type { SandSendMessage } from "@open-grokbot/state";

export interface ParsedSendMessage {
  readonly message: SandSendMessage;
  readonly raw: string;
}

const SEND_MESSAGE_PREFIX = "SendMessage:";

/** Parse every SendMessage envelope from raw model output. Lines are either
 * `SendMessage: {"type":"text",...}` or bare JSON envelopes. */
export function parseSendMessages(output: string): readonly ParsedSendMessage[] {
  const parsed: ParsedSendMessage[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const payload = trimmed.startsWith(SEND_MESSAGE_PREFIX)
      ? trimmed.slice(SEND_MESSAGE_PREFIX.length).trim()
      : trimmed;
    if (!payload.startsWith("{")) continue;
    try {
      const message = JSON.parse(payload) as SandSendMessage;
      if (isValidSendMessage(message)) {
        parsed.push({ message, raw: trimmed });
      }
    } catch {
      // not a JSON envelope; ignore
    }
  }
  return parsed;
}

function isValidSendMessage(value: unknown): value is SandSendMessage {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as { type?: unknown; content?: unknown };
  switch (candidate.type) {
    case "text":
      return typeof candidate.content === "string";
    case "widget":
    case "attachment":
    case "secret-request":
      return true;
    default:
      return false;
  }
}
