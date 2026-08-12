/**
 * Real LLM providers.
 *
 * Two transports cover the whole model market:
 *
 * - `OpenAiCompatibleLlm` speaks the OpenAI chat/completions wire protocol
 *   against ANY compatible endpoint — OpenAI, DeepSeek, Doubao, Moonshot,
 *   GLM, Grok, Ollama, vLLM and every self-hosted gateway that mirrors the
 *   OpenAI API. Configure baseUrl + model and it works.
 * - `AnthropicLlm` speaks the Anthropic messages API.
 *
 * Both implement the `Llm` interface used by AgentRunner, so a runner built
 * for MockLlm switches to a real model by configuration alone. Timeouts are
 * client-side (a hung upstream never blocks a turn); 5xx/429 responses retry
 * once with backoff.
 */

import type { Llm, LlmRequest } from "./index.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 1;
export const RETRY_BASE_DELAY_MS = 1_000;

export class LlmHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

export class LlmTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LlmTimeoutError";
  }
}

interface ProviderCommon {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
}

export interface OpenAiCompatibleOptions extends ProviderCommon {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature?: number;
  readonly extraHeaders?: Record<string, string>;
}

export interface AnthropicOptions extends ProviderCommon {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
}

/** OpenAI-compatible provider: one implementation, every compatible model. */
export class OpenAiCompatibleLlm implements Llm {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number | undefined;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature;
    this.extraHeaders = options.extraHeaders;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.name = `openai:${this.model}`;
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<string> {
    const messages: unknown[] = [];
    if (request.system.length > 0) {
      messages.push({ role: "system", content: request.system });
    }
    if (request.context != null && request.context.length > 0) {
      messages.push({ role: "system", content: `Context:\n${request.context}` });
    }
    messages.push({ role: "user", content: request.user });

    const body = JSON.stringify({
      model: this.model,
      messages,
      ...(this.temperature != null ? { temperature: this.temperature } : {}),
    });

    const response = await this.requestWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body,
      },
      signal,
    );
    const data = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      error?: { message?: string };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      // Some compatible endpoints return content parts.
      const text = content
        .map((part) => (typeof part === "object" && part != null && "text" in part ? String((part as { text: unknown }).text) : ""))
        .join("");
      return text;
    }
    if (data.error?.message) throw new LlmHttpError(response.status, data.error.message);
    throw new LlmHttpError(response.status, `unexpected chat/completions response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  private async requestWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const response = await this.requestOnce(url, init, signal);
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const detail = await response.text().catch(() => response.statusText);
        throw new LlmHttpError(response.status, `LLM request failed (${response.status}): ${detail.slice(0, 200)}`);
      }
      attempt += 1;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay, signal, this.clock);
    }
  }

  private async requestOnce(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new LlmTimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** Anthropic provider: speaks the /v1/messages protocol. */
export class AnthropicLlm implements Llm {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  constructor(options: AnthropicOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.name = `anthropic:${this.model}`;
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<string> {
    const system = [request.system, request.context ?? ""].filter((part) => part.length > 0).join("\n\n");
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      ...(system.length > 0 ? { system } : {}),
      messages: [{ role: "user", content: request.user }],
    });
    const response = await this.requestWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      },
      signal,
    );
    const data = (await response.json()) as {
      content?: { type: string; text?: string }[];
      error?: { message?: string };
    };
    const text = data.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    if (text != null && text.length > 0) return text;
    if (data.error?.message) throw new LlmHttpError(response.status, data.error.message);
    throw new LlmHttpError(response.status, `unexpected anthropic response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  private async requestWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const response = await this.requestOnce(url, init, signal);
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const detail = await response.text().catch(() => response.statusText);
        throw new LlmHttpError(response.status, `LLM request failed (${response.status}): ${detail.slice(0, 200)}`);
      }
      attempt += 1;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay, signal, this.clock);
    }
  }

  private async requestOnce(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new LlmTimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export type LlmConfig =
  | ({ readonly provider: "openai-compatible" } & OpenAiCompatibleOptions)
  | ({ readonly provider: "anthropic" } & AnthropicOptions);

/** One-line construction for any model: createLlm({ provider, baseUrl, apiKey, model }). */
export function createLlm(config: LlmConfig): Llm {
  if (config.provider === "anthropic") {
    const { provider: _provider, ...options } = config;
    void _provider;
    return new AnthropicLlm(options);
  }
  const { provider: _provider, ...options } = config;
  void _provider;
  return new OpenAiCompatibleLlm(options);
}

/** Environment-driven construction:
 * - LLM_PROVIDER=anthropic → Anthropic (ANTHROPIC_API_KEY, ANTHROPIC_MODEL)
 * - otherwise OpenAI-compatible (OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL)
 */
export function createLlmFromEnv(env: NodeJS.ProcessEnv = process.env): Llm {
  const provider = env.LLM_PROVIDER?.trim().toLowerCase();
  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY ?? "";
    if (apiKey.length === 0) throw new Error("ANTHROPIC_API_KEY is required for the anthropic provider");
    return new AnthropicLlm({
      apiKey,
      model: env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      ...(env.ANTHROPIC_BASE_URL != null ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
    });
  }
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (apiKey.length === 0) throw new Error("OPENAI_API_KEY is required for the openai-compatible provider");
  return new OpenAiCompatibleLlm({
    apiKey,
    baseUrl: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    model: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
  });
}

function sleep(ms: number, signal: AbortSignal | undefined, clock: () => number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
    void clock;
  });
}
