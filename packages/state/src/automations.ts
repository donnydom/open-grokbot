/** Automations: scheduled or trigger-driven agent runs (corresponds to the
 * automations extension: schedule trigger, channel trigger, manual "run now"). */

export type AutomationTrigger =
  | { readonly type: "schedule"; readonly cron: string; readonly timezone?: string }
  | { readonly type: "interval"; readonly intervalMinutes: number }
  | { readonly type: "channel"; readonly platform: string }
  | { readonly type: "manual" };

export interface Automation {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly prompt: string;
  readonly trigger: AutomationTrigger;
  readonly isEnabled: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastRunAtMs?: number;
  readonly runCount: number;
}

export interface AutomationStoreOptions {
  /** Optional persistence directory (`automations.json`). */
  readonly dir?: string;
  readonly now?: () => number;
}

export class AutomationStore {
  private readonly automations = new Map<string, Automation>();
  private readonly dir?: string;
  private readonly now: () => number;
  private loaded = false;
  private nextId = 1;

  constructor(options: AutomationStoreOptions = {}) {
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
      const raw = await readFile(join(this.dir, "automations.json"), "utf8");
      const parsed = JSON.parse(raw) as { automations: readonly Automation[]; nextId?: number };
      for (const automation of parsed.automations ?? []) {
        this.automations.set(automation.id, automation);
      }
      this.nextId = parsed.nextId ?? this.automations.size + 1;
    } catch {
      // none yet
    }
  }

  async create(input: {
    agentId: string;
    name: string;
    prompt: string;
    trigger: AutomationTrigger;
    isEnabled?: boolean;
  }): Promise<Automation> {
    await this.load();
    const now = this.now();
    const automation: Automation = {
      id: `a${this.nextId++}`,
      agentId: input.agentId,
      name: input.name,
      prompt: input.prompt,
      trigger: input.trigger,
      isEnabled: input.isEnabled ?? true,
      createdAtMs: now,
      updatedAtMs: now,
      runCount: 0,
    };
    this.automations.set(automation.id, automation);
    await this.persist();
    return { ...automation };
  }

  async update(
    id: string,
    patch: Partial<Pick<Automation, "name" | "prompt" | "trigger" | "isEnabled">>,
  ): Promise<Automation | undefined> {
    await this.load();
    const automation = this.automations.get(id);
    if (automation == null) return undefined;
    const updated: Automation = { ...automation, ...patch, updatedAtMs: this.now() };
    this.automations.set(id, updated);
    await this.persist();
    return { ...updated };
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const removed = this.automations.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  async setEnabled(id: string, isEnabled: boolean): Promise<Automation | undefined> {
    return await this.update(id, { isEnabled });
  }

  /** Record a fired run (called by the scheduler after dispatching). */
  async recordRun(id: string): Promise<void> {
    await this.load();
    const automation = this.automations.get(id);
    if (automation == null) return;
    const updated: Automation = {
      ...automation,
      lastRunAtMs: this.now(),
      runCount: automation.runCount + 1,
      updatedAtMs: this.now(),
    };
    this.automations.set(id, updated);
    await this.persist();
  }

  async list(agentId?: string): Promise<readonly Automation[]> {
    await this.load();
    const all = [...this.automations.values()];
    return agentId == null ? all : all.filter((a) => a.agentId === agentId);
  }

  async get(id: string): Promise<Automation | undefined> {
    await this.load();
    const automation = this.automations.get(id);
    return automation == null ? undefined : { ...automation };
  }

  private async persist(): Promise<void> {
    if (this.dir == null) return;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      join(this.dir, "automations.json"),
      JSON.stringify({ nextId: this.nextId, automations: [...this.automations.values()] }, null, 2),
      "utf8",
    );
  }
}

/** Simple interval scheduler over the store: fires enabled interval/schedule
 * automations whose due time has passed, serialized per agent through the
 * caller-provided dispatch (which enqueues on the run scheduler). */
export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private firing = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly dispatch: (automation: Automation) => void | Promise<void>,
    private readonly options: { intervalMs?: number; now?: () => number } = {},
  ) {}

  start(): void {
    if (this.timer != null) return;
    const intervalMs = this.options.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    try {
      const now = this.options.now?.() ?? Date.now();
      const automations = await this.store.list();
      for (const automation of automations) {
        if (!automation.isEnabled) continue;
        const due = this.isDue(automation, now);
        if (!due) continue;
        try {
          await this.dispatch(automation);
          await this.store.recordRun(automation.id);
        } catch {
          // a failing automation must not block the sweep; next tick retries
        }
      }
    } finally {
      this.firing = false;
    }
  }

  private isDue(automation: Automation, now: number): boolean {
    switch (automation.trigger.type) {
      case "interval": {
        const intervalMs = automation.trigger.intervalMinutes * 60_000;
        const lastRun = automation.lastRunAtMs ?? automation.createdAtMs;
        return now - lastRun >= intervalMs;
      }
      case "schedule": {
        // Minimal cron support: `m h` or `m h * * *` (UTC). Every other shape
        // is evaluated daily at the given minute/hour boundary.
        const cron = automation.trigger.cron.trim();
        const parts = cron.split(/\s+/);
        const minute = Number(parts[0]);
        const hour = Number(parts[1]);
        if (!Number.isInteger(minute) || !Number.isInteger(hour)) return false;
        const lastRun = automation.lastRunAtMs ?? 0;
        const date = new Date(now);
        const dueToday =
          date.getUTCHours() === hour && date.getUTCMinutes() === minute;
        return dueToday && now - lastRun >= 60_000;
      }
      case "channel":
      case "manual":
        return false; // fired by external events / explicit calls
    }
  }
}
