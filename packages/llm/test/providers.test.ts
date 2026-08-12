/**
 * Real LLM provider tests: request wire format and response parsing against
 * local mock servers (no network, no keys), plus retry/timeout behavior.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";

import {
  OpenAiCompatibleLlm,
  AnthropicLlm,
  LlmHttpError,
  LlmTimeoutError,
  createLlm,
  createLlmFromEnv,
} from "../src/providers.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function startMock(handler: (req: CapturedRequest, res: { status: (code: number) => { json: (body: unknown) => void } }) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        url: req.url ?? "",
        headers: req.headers,
        body: raw.length > 0 ? JSON.parse(raw) : null,
      };
      handler(captured, {
        status: (code) => ({
          json: (body) => {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
          },
        }),
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("openai-compatible: request wire format and response parsing", async () => {
  let captured: CapturedRequest | undefined;
  const mock = await startMock((req, res) => {
    captured = req;
    res.status(200).json({ choices: [{ message: { content: "hello from model" } }] });
  });
  try {
    const llm = createLlm({
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      apiKey: "test-key",
      model: "deepseek-chat",
    });
    const text = await llm.complete({ system: "sys", user: "hi", context: "ctx" });
    assert.equal(text, "hello from model");
    assert.equal(captured?.url, "/v1/chat/completions");
    assert.equal(captured?.headers.authorization, "Bearer test-key");
    const body = captured?.body as {
      model: string;
      messages: { role: string; content: string }[];
    };
    assert.equal(body.model, "deepseek-chat");
    assert.deepEqual(body.messages, [
      { role: "system", content: "sys" },
      { role: "system", content: "Context:\nctx" },
      { role: "user", content: "hi" },
    ]);
  } finally {
    await mock.close();
  }
});

test("anthropic: request wire format (x-api-key + version header) and parsing", async () => {
  let captured: CapturedRequest | undefined;
  const mock = await startMock((req, res) => {
    captured = req;
    res.status(200).json({ content: [{ type: "text", text: "claude says hi" }] });
  });
  try {
    const llm = createLlm({
      provider: "anthropic",
      baseUrl: `http://127.0.0.1:${mock.port}`,
      apiKey: "ant-key",
      model: "claude-sonnet-4-5",
    });
    const text = await llm.complete({ system: "sys", user: "hi" });
    assert.equal(text, "claude says hi");
    assert.equal(captured?.url, "/v1/messages");
    assert.equal(captured?.headers["x-api-key"], "ant-key");
    assert.equal(captured?.headers["anthropic-version"], "2023-06-01");
    const body = captured?.body as { model: string; max_tokens: number; system: string; messages: unknown };
    assert.equal(body.model, "claude-sonnet-4-5");
    assert.ok(body.max_tokens > 0);
    assert.equal(body.system, "sys");
  } finally {
    await mock.close();
  }
});

test("providers: 5xx retries once then succeeds; 4xx fails fast", async () => {
  let attempts = 0;
  const mock = await startMock((_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.status(500).json({ error: { message: "upstream hiccup" } });
      return;
    }
    res.status(200).json({ choices: [{ message: { content: "recovered" } }] });
  });
  try {
    const llm = new OpenAiCompatibleLlm({
      baseUrl: `http://127.0.0.1:${mock.port}`,
      apiKey: "k",
      model: "m",
      maxRetries: 1,
      clock: () => Date.now(),
    });
    // speed up retry backoff by injecting a tiny clock? backoff uses
    // setTimeout; with RETRY_BASE_DELAY_MS=1000 the test would take 1s.
    // Instead configure retries on the provider with a small base via
    // direct construction below.
    const text = await llm.complete({ system: "", user: "x" });
    assert.equal(text, "recovered");
    assert.equal(attempts, 2);
  } finally {
    await mock.close();
  }

  const mock2 = await startMock((_req, res) => {
    res.status(400).json({ error: { message: "bad request" } });
  });
  try {
    const llm = new OpenAiCompatibleLlm({ baseUrl: `http://127.0.0.1:${mock2.port}`, apiKey: "k", model: "m" });
    await assert.rejects(() => llm.complete({ system: "", user: "x" }), (error: Error) => {
      assert.ok(error instanceof LlmHttpError);
      assert.equal((error as LlmHttpError).status, 400);
      return true;
    });
  } finally {
    await mock2.close();
  }
});

test("providers: client-side timeout fires on a hung upstream", async () => {
  const mock = await startMock(() => {
    // never respond
  });
  try {
    const llm = new AnthropicLlm({
      baseUrl: `http://127.0.0.1:${mock.port}`,
      apiKey: "k",
      model: "m",
      timeoutMs: 30,
      maxRetries: 0,
    });
    await assert.rejects(() => llm.complete({ system: "", user: "x" }), (error: Error) => {
      assert.ok(error instanceof LlmTimeoutError);
      return true;
    });
  } finally {
    await mock.close();
  }
});

test("env factory: selects anthropic vs openai-compatible", () => {
  assert.throws(() => createLlmFromEnv({}), /OPENAI_API_KEY/);
  const openai = createLlmFromEnv({
    OPENAI_API_KEY: "ok",
    OPENAI_BASE_URL: "http://x/v1",
    OPENAI_MODEL: "grok-4",
  });
  assert.equal(openai.name, "openai:grok-4");
  const anthropic = createLlmFromEnv({
    LLM_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "ak",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
  });
  assert.equal(anthropic.name, "anthropic:claude-sonnet-4-5");
});
