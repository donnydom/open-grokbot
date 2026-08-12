/** Agent memory: durable per-agent notes the agent can read/write across
 * turns (corresponds to the memory extension of the original host). */

export interface MemoryEntry {
  readonly id: string;
  readonly text: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly tags?: readonly string[];
  readonly source?: string;
}

export interface MemoryStoreOptions {
  readonly agentId: string;
  /** Optional persistence directory (`memory.json`). */
  readonly dir?: string;
  readonly now?: () => number;
}

export class MemoryStore {
  private readonly entries: MemoryEntry[] = [];
  private readonly agentId: string;
  private readonly dir?: string;
  private readonly now: () => number;
  private loaded = false;
  private nextId = 1;

  constructor(options: MemoryStoreOptions) {
    this.agentId = options.agentId;
    this.dir = options.dir;
    this.now = options.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (this.dir == null) return;
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const raw = await readFile(join(this.dir, "memory.json"), "utf8");
      const parsed = JSON.parse(raw) as { entries: readonly MemoryEntry[]; nextId?: number };
      this.entries.push(...(parsed.entries ?? []));
      this.nextId = parsed.nextId ?? this.entries.length + 1;
    } catch {
      // no memory yet
    }
  }

  async add(text: string, options?: { tags?: readonly string[]; source?: string }): Promise<MemoryEntry> {
    await this.load();
    const now = this.now();
    const entry: MemoryEntry = {
      id: `m${this.nextId++}`,
      text,
      createdAtMs: now,
      updatedAtMs: now,
      ...(options?.tags != null && options.tags.length > 0 ? { tags: options.tags } : {}),
      ...(options?.source != null ? { source: options.source } : {}),
    };
    this.entries.push(entry);
    await this.persist();
    return entry;
  }

  async update(id: string, text: string): Promise<MemoryEntry | undefined> {
    await this.load();
    const index = this.entries.findIndex((candidate) => candidate.id === id);
    if (index < 0) return undefined;
    const entry = this.entries[index]!;
    const updated: MemoryEntry = { ...entry, text, updatedAtMs: this.now() };
    this.entries[index] = updated;
    await this.persist();
    return { ...updated };
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const index = this.entries.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    await this.persist();
    return true;
  }

  async clear(): Promise<void> {
    await this.load();
    this.entries.length = 0;
    await this.persist();
  }

  async list(): Promise<readonly MemoryEntry[]> {
    await this.load();
    return [...this.entries];
  }

  /** The memory text block injected into a turn's context (newest last). */
  async toContextBlock(): Promise<string> {
    const entries = await this.list();
    if (entries.length === 0) return "";
    return entries.map((entry) => `[${entry.id}] ${entry.text}`).join("\n");
  }

  private async persist(): Promise<void> {
    if (this.dir == null) return;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      join(this.dir, "memory.json"),
      JSON.stringify({ agentId: this.agentId, nextId: this.nextId, entries: this.entries }, null, 2),
      "utf8",
    );
  }
}
