/**
 * Agent store sync (BCS equivalent): multi-device state sync primitives.
 *
 * Reconstructed from the original's agent-store-sync: the backend
 * coordination service exposes per-agent resources with etags, an exclusive
 * mutation lock and conflict detection, so two devices editing the same
 * agent converge instead of clobbering each other.
 */

export interface BcsResource {
  readonly etag: string;
  readonly value: unknown;
}

export interface BcsBackend {
  /** Read a resource plus its etag. */
  get(resourceId: string): Promise<BcsResource | null>;
  /** Conditional write: fails when the expected etag does not match. */
  put(resourceId: string, value: unknown, expectedEtag: string | null): Promise<{ etag: string; conflict: boolean }>;
  /** Acquire an exclusive mutation lock (with expiry). */
  lock(resourceId: string, ownerId: string, ttlMs: number): Promise<{ locked: boolean; ownerId?: string }>;
  unlock(resourceId: string, ownerId: string): Promise<void>;
}

export class BcsConflictError extends Error {
  constructor(public readonly resourceId: string) {
    super(`etag conflict on ${resourceId}`);
    this.name = "BcsConflictError";
  }
}

export class BcsLockHeldError extends Error {
  constructor(public readonly resourceId: string, public readonly ownerId?: string) {
    super(`resource ${resourceId} is locked by ${ownerId ?? "another client"}`);
    this.name = "BcsLockHeldError";
  }
}

export interface AgentStoreSyncOptions {
  backend: BcsBackend;
  clock?: () => number;
  lockTtlMs?: number;
  /** Conflict resolution: merge(remote, local) -> merged value. */
  merge?: (remote: unknown, local: unknown) => unknown;
}

const DEFAULT_LOCK_TTL_MS = 60_000;

export class AgentStoreSync {
  private readonly backend: BcsBackend;
  private readonly clock: () => number;
  private readonly lockTtlMs: number;
  private readonly merge: (remote: unknown, local: unknown) => unknown;

  constructor(options: AgentStoreSyncOptions) {
    this.backend = options.backend;
    this.clock = options.clock ?? Date.now;
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.merge = options.merge ?? ((_remote, local) => local);
  }

  /** Optimistic read-modify-write with etag check and merge on conflict. */
  async update(
    resourceId: string,
    mutate: (current: unknown) => unknown,
  ): Promise<{ etag: string; value: unknown; conflictsResolved: number }> {
    let conflictsResolved = 0;
    for (;;) {
      const current = await this.backend.get(resourceId);
      const local = mutate(current?.value ?? null);
      const result = await this.backend.put(resourceId, local, current?.etag ?? null);
      if (!result.conflict) {
        return { etag: result.etag, value: local, conflictsResolved };
      }
      // Conflict: re-read and merge, then retry the conditional write.
      conflictsResolved += 1;
      const remote = await this.backend.get(resourceId);
      const merged = this.merge(remote?.value ?? null, local);
      const retry = await this.backend.put(resourceId, merged, remote?.etag ?? null);
      if (!retry.conflict) {
        return { etag: retry.etag, value: merged, conflictsResolved };
      }
      throw new BcsConflictError(resourceId);
    }
  }

  /** Run `task` while holding the exclusive mutation lock. */
  async withLock<T>(resourceId: string, ownerId: string, task: () => Promise<T>): Promise<T> {
    const { locked, ownerId: holder } = await this.backend.lock(
      resourceId,
      ownerId,
      this.lockTtlMs,
    );
    if (!locked) throw new BcsLockHeldError(resourceId, holder);
    try {
      return await task();
    } finally {
      await this.backend.unlock(resourceId, ownerId);
    }
  }

  /** Read with etag (no locking). */
  get(resourceId: string): Promise<BcsResource | null> {
    return this.backend.get(resourceId);
  }
}

/** Deterministic in-memory backend for tests and offline demos. */
export function createInMemoryBcsBackend(): BcsBackend {
  const resources = new Map<string, BcsResource>();
  const locks = new Map<string, { ownerId: string; expiresAt: number }>();
  let etagCounter = 0;
  return {
    async get(resourceId) {
      const locksEntry = locks.get(resourceId);
      if (locksEntry && locksEntry.expiresAt <= Date.now()) locks.delete(resourceId);
      return resources.get(resourceId) ?? null;
    },
    async put(resourceId, value, expectedEtag) {
      const current = resources.get(resourceId);
      if (current && current.etag !== expectedEtag) {
        return { etag: current.etag, conflict: true };
      }
      if (!current && expectedEtag !== null) {
        return { etag: expectedEtag, conflict: true };
      }
      const etag = `etag-${++etagCounter}`;
      resources.set(resourceId, { etag, value });
      return { etag, conflict: false };
    },
    async lock(resourceId, ownerId, ttlMs) {
      const now = Date.now();
      const current = locks.get(resourceId);
      if (current && current.expiresAt > now) {
        return { locked: false, ownerId: current.ownerId };
      }
      locks.set(resourceId, { ownerId, expiresAt: now + ttlMs });
      return { locked: true };
    },
    async unlock(resourceId, ownerId) {
      const current = locks.get(resourceId);
      if (current && current.ownerId === ownerId) locks.delete(resourceId);
    },
  };
}
