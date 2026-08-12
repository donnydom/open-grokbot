/**
 * Agent isolation worker: the host's agent-store / transcript-mirror worker
 * abstraction (agent-isolation equivalent).
 *
 * The original isolates agent store sync and transcript mirroring in workers.
 * This module models the worker contract: an isolation worker accepts job
 * messages (`{jobId, kind, args}`), runs them through a handler table, and
 * replies `{jobId, result | error}`. A fork-based worker runs the same
 * contract in a child process; an in-process worker serves tests and demos.
 */

import { fork, type ChildProcess } from "node:child_process";

export interface IsolationJob {
  readonly jobId: string;
  readonly kind: string;
  readonly args: unknown;
}

export interface IsolationJobResult {
  readonly jobId: string;
  readonly result?: unknown;
  readonly error?: string;
}

export type IsolationHandler = (args: unknown) => Promise<unknown>;

export interface IsolationWorker {
  submit(job: IsolationJob): Promise<IsolationJobResult>;
  close(): void;
}

/** In-process worker: runs handlers in the same event loop (tests, demos). */
export class InProcessIsolationWorker implements IsolationWorker {
  private readonly handlers: Map<string, IsolationHandler>;

  constructor(handlers: Record<string, IsolationHandler>) {
    this.handlers = new Map(Object.entries(handlers));
  }

  async submit(job: IsolationJob): Promise<IsolationJobResult> {
    const handler = this.handlers.get(job.kind);
    if (handler == null) {
      return { jobId: job.jobId, error: `no handler for ${job.kind}` };
    }
    try {
      const result = await handler(job.args);
      return { jobId: job.jobId, result };
    } catch (error) {
      return { jobId: job.jobId, error: String(error) };
    }
  }

  close(): void {
    this.handlers.clear();
  }
}

/** Fork-based worker: the same contract over a child process IPC pipe. */
export class ForkIsolationWorker implements IsolationWorker {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, (result: IsolationJobResult) => void>();

  constructor(entry: string) {
    this.child = fork(entry, { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    this.child.on("message", (message) => {
      const result = message as IsolationJobResult;
      const waiter = this.pending.get(result.jobId);
      if (waiter == null) return;
      this.pending.delete(result.jobId);
      waiter(result);
    });
  }

  submit(job: IsolationJob): Promise<IsolationJobResult> {
    return new Promise((resolve) => {
      this.pending.set(job.jobId, resolve);
      this.child.send(job);
    });
  }

  close(): void {
    this.child.disconnect();
  }
}

/** Child-process entrypoint helper for ForkIsolationWorker targets. */
export function runIsolationWorkerEntry(handlers: Record<string, IsolationHandler>): void {
  process.on("message", (message) => {
    const job = message as IsolationJob;
    const handler = handlers[job.kind];
    const reply = (result: IsolationJobResult): void => {
      if (process.send) process.send(result);
    };
    if (handler == null) {
      reply({ jobId: job.jobId, error: `no handler for ${job.kind}` });
      return;
    }
    void handler(job.args).then(
      (result) => reply({ jobId: job.jobId, result }),
      (error) => reply({ jobId: job.jobId, error: String(error) }),
    );
  });
}
