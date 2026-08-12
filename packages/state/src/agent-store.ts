/** Agent store: the on-disk layout of one agent (corresponds to the original
 * `profile.json` / `settings.json` / `store.db` / `group.json` directory
 * model). Each agent owns a directory; a group agent additionally carries
 * `group.json` listing member ids and optional cross-user room state. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentProfile {
  readonly name: string;
  readonly description: string;
  /** The agent's role, rendered as a pill beside its name ("Designer"). */
  readonly title?: string;
  readonly avatarShape?: string;
  readonly avatarColor?: string;
}

export interface AgentSettings {
  readonly notifyOnUpdates?: boolean;
  readonly hiddenFromSidebar?: boolean;
  readonly prLinkStyle?: "review-cursor" | "github";
}

export interface GroupConfig {
  readonly version: number;
  readonly memberIds: readonly string[];
  readonly remoteMembers?: readonly {
    readonly ownerAuthId: string;
    readonly agentId: string;
    readonly name: string;
  }[];
  /** Marks a locally-hosted cross-user room. */
  readonly sharedRoomId?: string;
}

export interface AgentRecord {
  readonly id: string;
  readonly profile: AgentProfile;
  readonly settings: AgentSettings;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly origin: "user" | "dev";
  readonly isGroup: boolean;
  readonly group?: GroupConfig;
}

export interface AgentStoreOptions {
  /** Root directory holding one subdirectory per agent. */
  readonly rootDir: string;
  readonly now?: () => number;
}

export const AGENT_LIMIT_MESSAGE = "50 is the maximum";
export const SAND_DEFAULT_AGENT_NAME = "New Bot";
export const GROUP_MAX_MEMBERS = 6;

export class AgentStore {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(options: AgentStoreOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? (() => Date.now());
  }

  agentDir(agentId: string): string {
    return join(this.rootDir, agentId);
  }

  async create(input: {
    id: string;
    name: string;
    description?: string;
    title?: string;
    origin?: "user" | "dev";
    isGroup?: boolean;
    memberIds?: readonly string[];
    group?: Omit<GroupConfig, "version" | "memberIds">;
  }): Promise<AgentRecord> {
    const count = await this.listCount();
    if (count >= 50) throw new Error(AGENT_LIMIT_MESSAGE);
    if (input.isGroup === true && (input.memberIds?.length ?? 0) > GROUP_MAX_MEMBERS) {
      throw new Error(`group chats are capped at ${GROUP_MAX_MEMBERS} members`);
    }
    const now = this.now();
    const record: AgentRecord = {
      id: input.id,
      profile: {
        name: input.name,
        description: input.description ?? "",
        ...(input.title != null ? { title: input.title } : {}),
      },
      settings: { notifyOnUpdates: true, hiddenFromSidebar: false },
      createdAtMs: now,
      updatedAtMs: now,
      origin: input.origin ?? "user",
      isGroup: input.isGroup ?? false,
      ...(input.isGroup === true
        ? {
            group: {
              version: 1,
              memberIds: input.memberIds ?? [],
              ...(input.group?.remoteMembers != null ? { remoteMembers: input.group.remoteMembers } : {}),
              ...(input.group?.sharedRoomId != null ? { sharedRoomId: input.group.sharedRoomId } : {}),
            },
          }
        : {}),
    };
    const dir = this.agentDir(input.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "profile.json"), JSON.stringify(record.profile, null, 2), "utf8");
    await writeFile(join(dir, "settings.json"), JSON.stringify(record.settings, null, 2), "utf8");
    if (record.group != null) {
      await writeFile(join(dir, "group.json"), JSON.stringify(record.group, null, 2), "utf8");
    }
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify(
        { id: record.id, createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs, origin: record.origin, isGroup: record.isGroup },
        null,
        2,
      ),
      "utf8",
    );
    return record;
  }

  async read(id: string): Promise<AgentRecord | undefined> {
    const dir = this.agentDir(id);
    try {
      const [profile, settings, meta, group] = await Promise.all([
        readJson<AgentProfile>(join(dir, "profile.json")),
        readJson<AgentSettings>(join(dir, "settings.json")),
        readJson<{
          id: string;
          createdAtMs: number;
          updatedAtMs: number;
          origin: "user" | "dev";
          isGroup: boolean;
        }>(join(dir, "agent.json")),
        readJson<GroupConfig>(join(dir, "group.json")).catch(() => undefined),
      ]);
      return {
        id,
        profile,
        settings,
        createdAtMs: meta.createdAtMs,
        updatedAtMs: meta.updatedAtMs,
        origin: meta.origin,
        isGroup: meta.isGroup ?? group != null,
        ...(group != null ? { group } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async updateProfile(id: string, patch: Partial<AgentProfile>): Promise<AgentRecord | undefined> {
    const record = await this.read(id);
    if (record == null) return undefined;
    const profile: AgentProfile = { ...record.profile, ...patch };
    await writeFile(join(this.agentDir(id), "profile.json"), JSON.stringify(profile, null, 2), "utf8");
    const updated: AgentRecord = { ...record, profile, updatedAtMs: this.now() };
    await writeMeta(join(this.agentDir(id), "agent.json"), updated);
    return updated;
  }

  async updateSettings(id: string, patch: Partial<AgentSettings>): Promise<AgentRecord | undefined> {
    const record = await this.read(id);
    if (record == null) return undefined;
    const settings: AgentSettings = { ...record.settings, ...patch };
    await writeFile(join(this.agentDir(id), "settings.json"), JSON.stringify(settings, null, 2), "utf8");
    const updated: AgentRecord = { ...record, settings, updatedAtMs: this.now() };
    await writeMeta(join(this.agentDir(id), "agent.json"), updated);
    return updated;
  }

  async list(): Promise<readonly AgentRecord[]> {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try {
      names = await readdir(this.rootDir, { withFileTypes: true }).then((entries) =>
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      );
    } catch {
      return [];
    }
    const records: AgentRecord[] = [];
    for (const name of names) {
      const record = await this.read(name);
      if (record != null) records.push(record);
    }
    return records.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async listCount(): Promise<number> {
    return (await this.list()).length;
  }

  async delete(id: string): Promise<boolean> {
    const { rm } = await import("node:fs/promises");
    try {
      await rm(this.agentDir(id), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function writeMeta(
  path: string,
  record: Pick<AgentRecord, "id" | "createdAtMs" | "updatedAtMs" | "origin" | "isGroup">,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify(
      {
        id: record.id,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
        origin: record.origin,
        isGroup: record.isGroup,
      },
      null,
      2,
    ),
    "utf8",
  );
}
