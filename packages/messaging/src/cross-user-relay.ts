/**
 * Cross-user shared rooms (xuser relay).
 *
 * Reconstructed from the original's cross-user-sharing extension: a room is
 * hosted by one user's box; other users hold a mirror room whose remote
 * members execute turns through a backend relay using `turn-request` /
 * `turn-result` messages. Each remote turn may return at most 2 text
 * messages.
 *
 * Abuse controls (mirroring the original constants):
 * - budget: at most 30 remote turns per 10-minute window
 * - unreachable backend: 10-minute backoff before the next attempt
 * - turnNonce idempotency: a repeated request with a seen nonce replays the
 *   stored result instead of executing twice
 */

export interface TurnRequest {
  /** Client-generated idempotency nonce (mirrors turnNonce). */
  readonly nonce: string;
  readonly roomId: string;
  readonly fromAgentId: string;
  readonly prompt: string;
}

export interface TurnResult {
  readonly nonce: string;
  /** At most 2 text messages back (mirrors the original's cap). */
  readonly texts: string[];
}

export const REMOTE_TURN_MAX_TEXTS = 2;
export const TURN_BUDGET_WINDOW_MS = 10 * 60 * 1000;
export const TURN_BUDGET_MAX_PER_WINDOW = 30;
export const UNREACHABLE_BACKOFF_MS = 10 * 60 * 1000;

export interface CrossUserTransport {
  /** Send a turn-request to the backend relay and await the turn-result. */
  requestTurn(request: TurnRequest): Promise<TurnResult>;
}

export interface CrossUserRelayOptions {
  transport: CrossUserTransport;
  clock?: () => number;
  budgetWindowMs?: number;
  budgetMaxPerWindow?: number;
  unreachableBackoffMs?: number;
}

export class BudgetExceededError extends Error {
  constructor() {
    super("remote turn budget exceeded for this window");
    this.name = "BudgetExceededError";
  }
}

export class UnreachableBackoffError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`relay unreachable, backed off for ${retryAfterMs}ms`);
    this.name = "UnreachableBackoffError";
  }
}

export class CrossUserRelay {
  private readonly clock: () => number;
  private readonly budgetWindowMs: number;
  private readonly budgetMaxPerWindow: number;
  private readonly unreachableBackoffMs: number;
  private readonly transport: CrossUserTransport;
  private readonly results = new Map<string, TurnResult>(); // nonce -> result
  private turnTimestamps: number[] = [];
  private unreachableUntil = 0;

  constructor(options: CrossUserRelayOptions) {
    this.transport = options.transport;
    this.clock = options.clock ?? Date.now;
    this.budgetWindowMs = options.budgetWindowMs ?? TURN_BUDGET_WINDOW_MS;
    this.budgetMaxPerWindow = options.budgetMaxPerWindow ?? TURN_BUDGET_MAX_PER_WINDOW;
    this.unreachableBackoffMs = options.unreachableBackoffMs ?? UNREACHABLE_BACKOFF_MS;
  }

  /** Execute a remote turn with budget, backoff and idempotency guards. */
  async executeRemoteTurn(request: TurnRequest): Promise<TurnResult> {
    const cached = this.results.get(request.nonce);
    if (cached) return cached;

    const now = this.clock();
    if (now < this.unreachableUntil) {
      throw new UnreachableBackoffError(this.unreachableUntil - now);
    }
    this.pruneWindow(now);
    if (this.turnTimestamps.length >= this.budgetMaxPerWindow) {
      throw new BudgetExceededError();
    }
    this.turnTimestamps.push(now);

    try {
      const result = await this.transport.requestTurn(request);
      const capped: TurnResult = {
        nonce: result.nonce,
        texts: result.texts.slice(0, REMOTE_TURN_MAX_TEXTS),
      };
      this.results.set(request.nonce, capped);
      return capped;
    } catch {
      this.unreachableUntil = this.clock() + this.unreachableBackoffMs;
      throw new UnreachableBackoffError(this.unreachableBackoffMs);
    }
  }

  private pruneWindow(now: number): void {
    this.turnTimestamps = this.turnTimestamps.filter((t) => now - t < this.budgetWindowMs);
  }

  /** Hosted-room side: register a handler that answers remote turn-requests. */
  onTurnRequest(handler: (request: TurnRequest) => Promise<string[]>): void {
    this.turnHandler = handler;
  }

  private turnHandler: ((request: TurnRequest) => Promise<string[]>) | null = null;

  /** Answer an inbound turn-request (called by the hosted box). */
  async answerTurnRequest(request: TurnRequest): Promise<TurnResult> {
    if (!this.turnHandler) {
      throw Object.assign(new Error("no turn handler registered"), {
        name: "NoTurnHandlerError",
      });
    }
    const texts = (await this.turnHandler(request)).slice(0, REMOTE_TURN_MAX_TEXTS);
    const result: TurnResult = { nonce: request.nonce, texts };
    this.results.set(request.nonce, result);
    return result;
  }

  /** Diagnostic view of budget state (mirrors the original's telemetry). */
  diagnostics(): { turnsInWindow: number; unreachableUntil: number; cachedResults: number } {
    const now = this.clock();
    this.pruneWindow(now);
    return {
      turnsInWindow: this.turnTimestamps.length,
      unreachableUntil: this.unreachableUntil,
      cachedResults: this.results.size,
    };
  }
}
