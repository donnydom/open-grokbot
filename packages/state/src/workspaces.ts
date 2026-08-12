/**
 * Host workspace stores: forever-box, teach-recording, workflows.
 *
 * These back the host-side state for the coordinator RPC methods
 * `foreverBox`, `teachRecording` and the workflows/async-tasks event
 * families. Each is a small JSON-file-backed store with a memory mirror;
 * together they cover the host surface the renderer RPC contract exposes.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function saveJsonFile(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

// ---- Forever box ---------------------------------------------------------

export interface ForeverBoxItem {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly createdAtMs: number;
}

/** The user's "forever box": pinned notes/artifacts that survive sessions. */
export class ForeverBoxStore {
  private readonly file: string;
  private items: ForeverBoxItem[] = [];

  constructor(options: { dir: string }) {
    this.file = path.join(options.dir, "forever-box.json");
  }

  async load(): Promise<void> {
    this.items = loadJsonFile<ForeverBoxItem[]>(this.file, []);
  }

  async add(item: ForeverBoxItem): Promise<void> {
    this.items.push(item);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((item) => item.id !== id);
    await this.persist();
  }

  list(): readonly ForeverBoxItem[] {
    return [...this.items];
  }

  private async persist(): Promise<void> {
    saveJsonFile(this.file, this.items);
  }
}

// ---- Teach recording -----------------------------------------------------

export interface TeachRecordingSession {
  readonly recordingId: string;
  readonly agentId: string;
  readonly startedAtMs: number;
  /** Steps captured so far (user actions + agent responses). */
  readonly steps: unknown[];
}

/** Teach-recording capture: records a live session for replay/teaching. */
export class TeachRecordingStore {
  private readonly file: string;
  private sessions: TeachRecordingSession[] = [];

  constructor(options: { dir: string }) {
    this.file = path.join(options.dir, "teach-recordings.json");
  }

  async load(): Promise<void> {
    this.sessions = loadJsonFile<TeachRecordingSession[]>(this.file, []);
  }

  async start(recordingId: string, agentId: string): Promise<void> {
    this.sessions.push({ recordingId, agentId, startedAtMs: Date.now(), steps: [] });
    await this.persist();
  }

  async appendStep(recordingId: string, step: unknown): Promise<void> {
    const session = this.sessions.find((s) => s.recordingId === recordingId);
    if (session == null) throw new Error(`no recording ${recordingId}`);
    (session.steps as unknown[]).push(step);
    await this.persist();
  }

  async stop(recordingId: string): Promise<TeachRecordingSession | undefined> {
    const index = this.sessions.findIndex((s) => s.recordingId === recordingId);
    if (index < 0) return undefined;
    const [session] = this.sessions.splice(index, 1);
    await this.persist();
    return session;
  }

  isRecording(): boolean {
    return this.sessions.length > 0;
  }

  list(): readonly TeachRecordingSession[] {
    return [...this.sessions];
  }

  private async persist(): Promise<void> {
    saveJsonFile(this.file, this.sessions);
  }
}

// ---- Workflows (workflows + async tasks) ---------------------------------

export interface WorkflowRecord {
  readonly workflowId: string;
  readonly agentId: string;
  readonly name: string;
  readonly createdAtMs: number;
  /** Async task handles belonging to this workflow. */
  readonly asyncTaskIds: string[];
  readonly state: "running" | "done" | "failed";
}

export interface AsyncTaskRecord {
  readonly taskId: string;
  readonly kind: string;
  readonly state: "queued" | "running" | "done" | "failed";
  readonly error?: string;
}

/** Workflow + async-task registry backing the workflows/async-tasks families. */
export class WorkflowStore {
  private readonly file: string;
  private workflows: WorkflowRecord[] = [];
  private asyncTasks: AsyncTaskRecord[] = [];

  constructor(options: { dir: string }) {
    this.file = path.join(options.dir, "workflows.json");
  }

  async load(): Promise<void> {
    const raw = loadJsonFile<{ workflows: WorkflowRecord[]; asyncTasks: AsyncTaskRecord[] }>(
      this.file,
      { workflows: [], asyncTasks: [] },
    );
    this.workflows = raw.workflows;
    this.asyncTasks = raw.asyncTasks;
  }

  async createWorkflow(record: WorkflowRecord): Promise<void> {
    this.workflows.push(record);
    await this.persist();
  }

  async updateWorkflowState(workflowId: string, state: WorkflowRecord["state"]): Promise<void> {
    const workflow = this.workflows.find((w) => w.workflowId === workflowId);
    if (workflow == null) throw new Error(`no workflow ${workflowId}`);
    (workflow as { state: WorkflowRecord["state"] }).state = state;
    await this.persist();
  }

  async createAsyncTask(record: AsyncTaskRecord): Promise<void> {
    this.asyncTasks.push(record);
    await this.persist();
  }

  async updateAsyncTaskState(taskId: string, state: AsyncTaskRecord["state"], error?: string): Promise<void> {
    const task = this.asyncTasks.find((t) => t.taskId === taskId);
    if (task == null) throw new Error(`no async task ${taskId}`);
    (task as { state: AsyncTaskRecord["state"] }).state = state;
    if (error != null) (task as { error?: string }).error = error;
    await this.persist();
  }

  listWorkflows(): readonly WorkflowRecord[] {
    return [...this.workflows];
  }

  listAsyncTasks(): readonly AsyncTaskRecord[] {
    return [...this.asyncTasks];
  }

  private async persist(): Promise<void> {
    saveJsonFile(this.file, { workflows: this.workflows, asyncTasks: this.asyncTasks });
  }
}
