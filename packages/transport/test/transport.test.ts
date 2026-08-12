import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPortServer,
  createPortClient,
  isClientFrame,
  isServerFrame,
  GatewaySseClient,
  startGatewayServer,
  SseBlockDecoder,
  GatewayCommandError,
} from "../src/index.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("frame guards validate direction ownership", () => {
  assert.ok(isClientFrame({ kind: "request", requestId: "r1", method: "listAgents" }));
  assert.ok(isClientFrame({ kind: "lifecycle", phase: "ready" }));
  assert.ok(!isClientFrame({ kind: "reply", requestId: "r1", outcome: { kind: "ok", value: 1 } }));
  assert.ok(isServerFrame({ kind: "reply", requestId: "r1", outcome: { kind: "ok", value: 1 } }));
  assert.ok(isServerFrame({ kind: "event", family: "transcript", payload: {} }));
  assert.ok(!isServerFrame({ kind: "request", requestId: "r1", method: "x" }));
});

test("port session: hello, request/reply round trip, events", async () => {
  const calls: string[] = [];
  let client!: ReturnType<typeof createPortClient>;
  const server = createPortServer(
    { post: (f) => client.handleMessage(f), close: () => {} },
    {
      dispatch: async (method, args) => {
        calls.push(method);
        if (method === "echo") return args;
        if (method === "boom") throw new Error("kaboom");
        throw new Error(`unknown: ${method}`);
      },
    },
  );
  client = createPortClient({ post: (f) => server.handleMessage(f), close: () => {} });

  server.handleMessage({ kind: "lifecycle", phase: "ready" });
  await sleep(5);

  const events: unknown[] = [];
  client.onEvent("transcript", (p) => events.push(p));
  server.postEvent("transcript", { id: 1 });

  const echo = await client.request("echo", { a: 1 });
  assert.deepEqual(echo, { a: 1 });
  await assert.rejects(client.request("boom"), /kaboom/);
  await assert.rejects(client.request("nope"), /unknown: nope/);
  assert.deepEqual(calls, ["echo", "boom", "nope"]);
  await sleep(5);
  assert.deepEqual(events, [{ id: 1 }]);
});

test("port server: request before hello is a protocol breach", async () => {
  let client!: ReturnType<typeof createPortClient>;
  const server = createPortServer(
    { post: (f) => client?.handleMessage(f), close: () => {} },
    { dispatch: async () => 1 },
  );
  client = createPortClient({ post: (f) => server.handleMessage(f), close: () => {} });
  server.handleMessage({ kind: "request", requestId: "r1", method: "x" });
  const settlement = await server.settled;
  assert.equal(settlement.outcome, "protocol-breach");
});

test("port server: client shutdown settles clean", async () => {
  let client!: ReturnType<typeof createPortClient>;
  const server = createPortServer(
    { post: (f) => client?.handleMessage(f), close: () => {} },
    { dispatch: async () => 1 },
  );
  client = createPortClient({ post: (f) => server.handleMessage(f), close: () => {} });
  server.handleMessage({ kind: "lifecycle", phase: "ready" });
  server.handleMessage({ kind: "lifecycle", phase: "shutdown" });
  const settlement = await server.settled;
  assert.equal(settlement.outcome, "clean");
});

test("sse block decoder parses data blocks and skips comments", () => {
  const blocks: string[] = [];
  const decoder = new SseBlockDecoder((b) => blocks.push(b));
  decoder.push(":ping\n\n");
  decoder.push('data: {"channel":"agents","payload":{"a":1}}\n\n');
  decoder.push('data: {"channel":"transcript"');
  decoder.push(',"payload":{"b":2}}\n\n');
  assert.deepEqual(blocks, [
    'data: {"channel":"agents","payload":{"a":1}}',
    'data: {"channel":"transcript","payload":{"b":2}}',
  ]);
});

test("gateway sse server + client: commands, events, channel filter", async () => {
  const subscribers = new Set<(event: { channel: string; payload: unknown }) => void>();
  const server = await startGatewayServer({
    api: {
      listAgents: async () => [{ id: "a1", name: "Alpha" }],
      sendPrompt: async (args) => ({ accepted: true, ...(args as object) }),
      fail: async () => {
        throw new Error("domain refused");
      },
    },
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  });
  try {
    const events: { channel: string; payload: unknown }[] = [];
    const client = new GatewaySseClient({
      resolveConnection: async () => ({ baseUrl: server.baseUrl }),
      onEvent: (e) => events.push(e),
    });
    client.start();
    await waitFor(() => client.isLive());

    const agents = await client.command("listAgents", {});
    assert.deepEqual(agents, [{ id: "a1", name: "Alpha" }]);

    const result = await client.sendPrompt({ clientNonce: "n1", prompt: "hi" });
    assert.equal((result as { accepted: boolean }).accepted, true);

    await assert.rejects(client.command("fail", {}), GatewayCommandError);
    await assert.rejects(client.command("nope", {}), /unknown command/);

    for (const subscriber of subscribers) {
      subscriber({ channel: "agents", payload: { x: 1 } });
    }
    await waitFor(() => events.length >= 1);
    assert.deepEqual(events[0], { channel: "agents", payload: { x: 1 } });
    client.close();
  } finally {
    await server.close();
  }
});

test("sendPrompt: no retry before dedupe proven, one retry after proven", async () => {
  // A raw HTTP server that kills the socket on the 1st and 3rd sendPrompt POST
  // (a transport-level failure, NOT an HTTP error) and answers the rest.
  const { createServer } = await import("node:http");
  let sends = 0;
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/sendPrompt" && req.method === "POST") {
      sends += 1;
      if (sends === 1 || sends === 3) {
        req.socket.destroy();
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true, ...JSON.parse(body) }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address != null ? address.port : 0}`;
  try {
    const client = new GatewaySseClient({
      resolveConnection: async () => ({ baseUrl }),
      onEvent: () => {},
    });
    // n1: transport failure, no dedupe proven yet -> surfaced, no retry.
    await assert.rejects(
      client.sendPrompt({ clientNonce: "n1", prompt: "a" }),
      /socket hang up|terminated|fetch failed/,
    );
    assert.equal(sends, 1);

    // n2: success -> the endpoint is now dedupe-proven.
    const ok = await client.sendPrompt({ clientNonce: "n2", prompt: "b" });
    assert.equal((ok as { accepted: boolean }).accepted, true);
    assert.equal(sends, 2);

    // n3: transport failure on a proven endpoint -> exactly one retry
    // (sends 3 and 4), and the retried send succeeds.
    const retried = await client.sendPrompt({ clientNonce: "n3", prompt: "c" });
    assert.equal((retried as { accepted: boolean }).accepted, true);
    assert.equal(sends, 4);
    client.close();
  } finally {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test("sse reconnect: server restart is observed and reconnected", async () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  const start = async () =>
    await startGatewayServer({
      api: { ping: async () => "pong" },
      subscribe: () => () => {},
    });
  server = await start();
  const transports: string[] = [];
  const client = new GatewaySseClient({
    resolveConnection: async () => ({ baseUrl: server!.baseUrl }),
    onEvent: () => {},
    onTransportEvent: (e) => transports.push(e.family),
    timing: {
      reconnectBackoff: {
        name: "t",
        maxAttempts: Number.MAX_SAFE_INTEGER,
        initialDelayMs: 20,
        maxDelayMs: 50,
        schedule: () => ({ elapsed: sleep(20), dispose() {} }),
      },
    },
  });
  client.start();
  await waitFor(() => client.isLive());
  // Kill the server; the SSE socket dies, the client observes transport-down.
  await server.close();
  server = await start();
  // The client should reconnect to the new server on the same base URL.
  await waitFor(
    () => transports.includes("transport-down") && client.getConnectionCount() >= 2,
    5000,
  );
  assert.ok(transports.includes("transport-connected"));
  client.close();
  await server.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(20);
  }
}
