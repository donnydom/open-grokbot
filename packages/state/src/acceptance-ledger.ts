/** Durable send-acceptance ledger: the idempotency spine of user sends.
 *
 * Every send carries a client-generated nonce (UUID). The ledger records, per
 * nonce, the digest of the immutable wire input and the acceptance state, so
 * a desktop retry after timeout — or a host restart mid-send — is a no-op
 * success instead of a double append. A replay with a DIFFERENT digest is the
 * NONCE_DIGEST_MISMATCH protocol failure and never dispatches. */

import { createHash } from "node:crypto";

export type AcceptanceState = "pending" | "accepted" | "rejected";

export interface AcceptanceRecord {
  readonly accountSlot: string;
  readonly clientNonce: string;
  readonly inputDigest: string;
  readonly state: AcceptanceState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly errorMessage?: string;
}

export interface AcceptanceLookup {
  readonly state: "accepted" | "pending" | "rejected" | "unknown";
  readonly inputDigest?: string;
  readonly record?: AcceptanceRecord;
}

export type AdmissionResult =
  | { readonly kind: "accepted"; readonly record: AcceptanceRecord }
  | { readonly kind: "duplicate"; readonly record: AcceptanceRecord }
  | { readonly kind: "digest-mismatch"; readonly record: AcceptanceRecord };

/** Canonical digest over the raw wire input, computed at the boundary before
 * any defensive coercion can touch the values. */
export function sendInputDigest(input: {
  agentId?: string;
  prompt?: string;
  richText?: string;
  replyToId?: string;
  isFork?: boolean;
  attachmentPaths?: readonly string[];
  attachmentNames?: readonly string[];
}): string {
  const canonical = JSON.stringify({
    agentId: input.agentId ?? null,
    prompt: input.prompt ?? null,
    richText: input.richText ?? null,
    replyToId: input.replyToId ?? null,
    isFork: input.isFork ?? false,
    attachmentPaths: input.attachmentPaths ?? [],
    attachmentNames: input.attachmentNames ?? [],
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface AcceptanceLedgerOptions {
  /** Optional persistence: file path for the ledger (JSON). */
  readonly file?: string;
  readonly now?: () => number;
  readonly onRecord?: (record: AcceptanceRecord) => void;
}

export class AcceptanceLedger {
  private readonly records = new Map<string, AcceptanceRecord>();
  private readonly file?: string;
  private readonly now: () => number;
  private readonly onRecord?: (record: AcceptanceRecord) => void;
  private loaded = false;

  constructor(options: AcceptanceLedgerOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => Date.now());
    this.onRecord = options.onRecord;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (this.file == null) return;
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { records: readonly AcceptanceRecord[] };
      for (const record of parsed.records ?? []) {
        this.records.set(record.clientNonce, record);
      }
    } catch {
      // no ledger yet
    }
  }

  /** Admit a send: returns accepted (first sight), duplicate (same digest),
   * or digest-mismatch (protocol failure). */
  async admitSend(input: {
    accountSlot: string;
    clientNonce: string;
    inputDigest: string;
  }): Promise<AdmissionResult> {
    await this.load();
    const existing = this.records.get(input.clientNonce);
    if (existing != null) {
      if (existing.inputDigest !== input.inputDigest) {
        return { kind: "digest-mismatch", record: existing };
      }
      return { kind: "duplicate", record: existing };
    }
    const now = this.now();
    const record: AcceptanceRecord = {
      accountSlot: input.accountSlot,
      clientNonce: input.clientNonce,
      inputDigest: input.inputDigest,
      state: "pending",
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.records.set(input.clientNonce, record);
    await this.persist();
    this.onRecord?.(record);
    return { kind: "accepted", record };
  }

  /** Flip a pending record to accepted (durable acceptance point). */
  async markAccepted(clientNonce: string): Promise<AcceptanceRecord | undefined> {
    const record = this.records.get(clientNonce);
    if (record == null) return undefined;
    const updated: AcceptanceRecord = { ...record, state: "accepted", updatedAtMs: this.now() };
    this.records.set(clientNonce, updated);
    await this.persist();
    this.onRecord?.(updated);
    return updated;
  }

  /** Record a rejection (with the surfaced message). */
  async markRejected(clientNonce: string, errorMessage: string): Promise<void> {
    const record = this.records.get(clientNonce);
    if (record == null) return;
    const updated: AcceptanceRecord = {
      ...record,
      state: "rejected",
      errorMessage,
      updatedAtMs: this.now(),
    };
    this.records.set(clientNonce, updated);
    await this.persist();
    this.onRecord?.(updated);
  }

  /** Clear a failed mid-flow record so the client may retry afresh. */
  async clear(clientNonce: string): Promise<void> {
    this.records.delete(clientNonce);
    await this.persist();
  }

  lookup(input: { accountSlot: string; clientNonce: string }): AcceptanceLookup {
    const record = this.records.get(input.clientNonce);
    if (record == null || record.accountSlot !== input.accountSlot) {
      return { state: "unknown" };
    }
    if (record.state === "rejected") {
      return { state: "rejected", inputDigest: record.inputDigest, record };
    }
    return {
      state: record.state === "accepted" ? "accepted" : "pending",
      inputDigest: record.inputDigest,
      record,
    };
  }

  size(): number {
    return this.records.size;
  }

  private async persist(): Promise<void> {
    if (this.file == null) return;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(
      this.file,
      JSON.stringify({ records: [...this.records.values()] }, null, 2),
      "utf8",
    );
  }
}
