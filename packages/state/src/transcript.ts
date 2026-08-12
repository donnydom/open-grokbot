/** Transcript model and store: the durable conversation record per agent.
 *
 * Entry kinds mirror the original platform: message (user/assistant), tool-call,
 * send-message (the only voice an agent has to the user), user-attachment,
 * notice and event. Agent-to-agent traffic is tagged with `fromAgent` /
 * `toAgent` so either side's transcript can reconstruct the full exchange
 * graph. Persistence is append-only JSONL per agent directory. */

export type TranscriptRole = "user" | "assistant";
export type ToolCallStatus = "pending" | "done" | "failed";

export interface SandMessageAuthor {
  readonly id: string;
  readonly name: string;
  readonly kind?: "agent" | "group";
}

export interface SandSendMessageImage {
  readonly url: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
}

export type SandSendMessage =
  | { readonly type: "text"; readonly content: string; readonly images?: readonly SandSendMessageImage[] }
  | { readonly type: "widget"; readonly widget: SandWidget }
  | { readonly type: "attachment"; readonly url: string; readonly file_name?: string }
  | { readonly type: "secret-request"; readonly secretRequest: unknown };

export interface SandWidget {
  readonly prompt: string;
  readonly options: readonly { label: string; value?: string; style?: "default" | "primary" | "danger" }[];
  readonly allowCustom?: boolean;
  readonly helpText?: string;
}

export interface SandEntryBase {
  readonly id: string;
  readonly kind: string;
  readonly timestampMs: number;
  readonly isStreaming?: boolean;
}

export interface SandMessageEntry extends SandEntryBase {
  readonly kind: "message";
  readonly role: TranscriptRole;
  readonly content: string;
  readonly replyTo?: string;
  readonly fromAgent?: SandMessageAuthor;
  readonly toAgent?: SandMessageAuthor;
  readonly channel?: string;
  readonly images?: readonly SandSendMessageImage[];
  readonly clientNonce?: string;
  readonly isFork?: boolean;
}

export interface SandToolCallEntry extends SandEntryBase {
  readonly kind: "tool-call";
  readonly role: "assistant";
  readonly tool: string;
  readonly callId: string;
  readonly status: ToolCallStatus;
  readonly input?: unknown;
  readonly output?: unknown;
}

export interface SandSendMessageEntry extends SandEntryBase {
  readonly kind: "send-message";
  readonly role: "assistant";
  readonly message: SandSendMessage;
  readonly messageId?: string;
}

export interface SandUserAttachmentEntry extends SandEntryBase {
  readonly kind: "user-attachment";
  readonly role: "user";
  readonly url: string;
  readonly fileName?: string;
  readonly byteSize?: number;
}

export interface SandNoticeEntry extends SandEntryBase {
  readonly kind: "notice";
  readonly text: string;
}

export interface SandEventEntry extends SandEntryBase {
  readonly kind: "event";
  readonly event: string;
  readonly payload?: unknown;
}

export type SandTranscriptEntry =
  | SandMessageEntry
  | SandToolCallEntry
  | SandSendMessageEntry
  | SandUserAttachmentEntry
  | SandNoticeEntry
  | SandEventEntry;

export function isMessageEntry(entry: SandTranscriptEntry): entry is SandMessageEntry {
  return entry.kind === "message";
}

export function isSendMessageEntry(entry: SandTranscriptEntry): entry is SandSendMessageEntry {
  return entry.kind === "send-message";
}

/** An entry that carries a peer (agent-to-agent) direction: inbound from a
 * peer (`fromAgent`) or the sender's mirror to a peer (`toAgent`). */
export function isPeerEntry(entry: SandTranscriptEntry): boolean {
  return (
    entry.kind === "message" &&
    (entry.fromAgent != null || entry.toAgent != null)
  );
}

/** Mint the next entry id in the original scheme: `t<turn>u` for user
 * messages, `t<turn>s<seq>` for assistant messages, `t<turn>a<seq>` for
 * attachments, `t<turn>n<seq>` for notices/events. */
export function nextEntryId(
  entries: readonly SandTranscriptEntry[],
  kind: "user-message" | "assistant-message" | "attachment" | "notice",
): string {
  const turn = entries.length > 0 ? parseTurn(entries[entries.length - 1]!.id) : 0;
  let seq = 0;
  for (const entry of entries) {
    if (parseTurn(entry.id) !== turn) continue;
    const match = /^t\d+([usna])(\d+)$/.exec(entry.id);
    if (match != null) seq = Math.max(seq, Number(match[2]!));
  }
  const prefix = kind === "user-message" ? "u" : kind === "attachment" ? "a" : "s";
  return `t${turn}${prefix}${seq + 1}`;
}

function parseTurn(id: string): number {
  const match = /^t(\d+)/.exec(id);
  return match != null ? Number(match[1]) : 0;
}

export interface TranscriptMutation {
  readonly kind: "entries-upserted" | "entry-deleted" | "conversation-cleared";
  readonly agentId: string;
  readonly entryId?: string;
  readonly entries?: readonly SandTranscriptEntry[];
}

export interface TranscriptStoreOptions {
  /** Agent id owning this transcript. */
  readonly agentId: string;
  /** Optional persistence: directory where `transcript.jsonl` lives. */
  readonly dir?: string;
  readonly onMutation?: (mutation: TranscriptMutation) => void;
}

/** Append-only transcript store with an in-memory mirror. */
export class TranscriptStore {
  private readonly entries: SandTranscriptEntry[] = [];
  private readonly onMutation?: (mutation: TranscriptMutation) => void;
  private readonly dir?: string;
  private readonly agentId: string;
  private loaded = false;

  constructor(options: TranscriptStoreOptions) {
    this.agentId = options.agentId;
    this.dir = options.dir;
    this.onMutation = options.onMutation;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (this.dir == null) return;
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const raw = await readFile(join(this.dir, "transcript.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          this.entries.push(JSON.parse(trimmed) as SandTranscriptEntry);
        } catch {
          // skip a corrupt line rather than failing the whole load
        }
      }
    } catch {
      // no transcript yet
    }
  }

  getAll(): readonly SandTranscriptEntry[] {
    return [...this.entries];
  }

  /** Entries of the main thread (no branch / fork) unless `includeForks`. */
  getMainThread(includeForks = false): readonly SandTranscriptEntry[] {
    return this.entries.filter(
      (entry) => includeForks || !(isMessageEntry(entry) && entry.isFork === true),
    );
  }

  getById(id: string): SandTranscriptEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  async append(entry: SandTranscriptEntry): Promise<void> {
    this.entries.push(entry);
    await this.persistAppend(entry);
    this.onMutation?.({
      kind: "entries-upserted",
      agentId: this.agentId,
      entries: [entry],
    });
  }

  async appendMany(entries: readonly SandTranscriptEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.push(entry);
    }
    await this.persistAppendMany(entries);
    this.onMutation?.({
      kind: "entries-upserted",
      agentId: this.agentId,
      entries: [...entries],
    });
  }

  async deleteEntry(id: string): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    this.entries.splice(index, 1);
    await this.persistRewrite();
    this.onMutation?.({ kind: "entry-deleted", agentId: this.agentId, entryId: id });
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
    await this.persistRewrite();
    this.onMutation?.({ kind: "conversation-cleared", agentId: this.agentId });
  }

  /** User-visible user messages for recovery/prepend purposes (peer/channel
   * rows are display-only mirrors and never enter the recovery stream). */
  recentUserMessages(): readonly { id: string; text: string }[] {
    return this.entries
      .filter(
        (entry): entry is SandMessageEntry =>
          isMessageEntry(entry) &&
          entry.role === "user" &&
          entry.fromAgent == null &&
          entry.channel == null,
      )
      .map((entry) => ({ id: entry.id, text: entry.content }));
  }

  private async persistAppend(entry: SandTranscriptEntry): Promise<void> {
    if (this.dir == null) return;
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, "transcript.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  private async persistAppendMany(entries: readonly SandTranscriptEntry[]): Promise<void> {
    if (this.dir == null) return;
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.dir, { recursive: true });
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await appendFile(join(this.dir, "transcript.jsonl"), `${lines}\n`, "utf8");
  }

  private async persistRewrite(): Promise<void> {
    if (this.dir == null) return;
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.dir, { recursive: true });
    const lines = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(join(this.dir, "transcript.jsonl"), `${lines}\n`, "utf8");
  }
}
