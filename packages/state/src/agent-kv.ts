/**
 * Agent KV store (agent-kv equivalent).
 *
 * The original ships a generic key/value store used across coordination
 * modules — most visibly `subagent-states` in the subagent registry, but also
 * arbitrary extension state. This is a JSON-file-backed KV with a memory
 * mirror, keyed by (namespace, key).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface AgentKvOptions {
  dir: string;
  /** File name on disk (defaults to agent-kv.json). */
  fileName?: string;
}

export class AgentKv {
  private readonly file: string;
  private readonly data = new Map<string, Map<string, unknown>>();

  constructor(options: AgentKvOptions) {
    this.file = path.join(options.dir, options.fileName ?? "agent-kv.json");
  }

  async load(): Promise<void> {
    this.data.clear();
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Record<string, unknown>>;
    for (const [namespace, entries] of Object.entries(raw)) {
      this.data.set(namespace, new Map(Object.entries(entries)));
    }
  }

  async persist(): Promise<void> {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const raw: Record<string, Record<string, unknown>> = {};
    for (const [namespace, entries] of this.data) {
      raw[namespace] = Object.fromEntries(entries);
    }
    writeFileSync(this.file, JSON.stringify(raw, null, 2));
  }

  get(namespace: string, key: string): unknown {
    return this.data.get(namespace)?.get(key);
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    let entries = this.data.get(namespace);
    if (entries == null) {
      entries = new Map();
      this.data.set(namespace, entries);
    }
    entries.set(key, value);
    await this.persist();
  }

  async delete(namespace: string, key: string): Promise<void> {
    const entries = this.data.get(namespace);
    if (entries == null) return;
    entries.delete(key);
    if (entries.size === 0) this.data.delete(namespace);
    await this.persist();
  }

  list(namespace: string): Map<string, unknown> {
    return new Map(this.data.get(namespace) ?? []);
  }

  namespaces(): readonly string[] {
    return [...this.data.keys()];
  }
}

/** The subagent-registry namespace, mirroring the original's usage. */
export const SUBAGENT_STATES_NAMESPACE = "subagent-states";
