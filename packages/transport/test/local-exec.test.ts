/**
 * Local-exec channel tests: daemon request/response cycle, heartbeat,
 * liveness window, response timeout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LocalExecClient,
  LocalExecResponseTimeoutError,
  LOCAL_EXEC_LIVENESS_WINDOW_MS,
  startLocalExecDaemon,
} from "../src/local-exec.js";

test("local-exec: request/response round trip through the daemon", async () => {
  const daemon = await startLocalExecDaemon(async (request) => ({
    id: request.id,
    ok: true,
    stdout: `echo ${request.args.command}`,
  }));
  try {
    const client = new LocalExecClient({ port: daemon.port });
    const response = await client.request({
      id: "r1",
      kind: "run-shell",
      args: { command: "hi" },
    });
    assert.equal(response.ok, true);
    assert.equal(response.stdout, "echo hi");
  } finally {
    await daemon.close();
  }
});

test("local-exec: heartbeat keeps the client's liveness view green", async () => {
  let now = 0;
  const daemon = await startLocalExecDaemon(async (request) => ({
    id: request.id,
    ok: true,
  }));
  try {
    const client = new LocalExecClient({ port: daemon.port, clock: () => now });
    assert.equal(client.isAlive(), false); // never heartbeated
    await client.heartbeat();
    assert.equal(client.isAlive(), true);
    now = LOCAL_EXEC_LIVENESS_WINDOW_MS + 1;
    assert.equal(client.isAlive(), false); // window lapsed -> presumed dead
  } finally {
    await daemon.close();
  }
});

test("local-exec: response timeout fires when the handler never completes", async () => {
  const daemon = await startLocalExecDaemon(async () => {
    // The daemon accepts the request but the handler never resolves; the
    // response poll then times out on the client.
    return new Promise(() => {});
  });
  try {
    const client = new LocalExecClient({ port: daemon.port, responseTimeoutMs: 50 });
    await assert.rejects(
      () => client.request({ id: "r-slow", kind: "run-shell", args: {} }),
      (error: Error) => {
        assert.ok(error instanceof LocalExecResponseTimeoutError);
        return true;
      },
    );
  } finally {
    await daemon.close();
  }
});

test("local-exec: malformed request body is rejected", async () => {
  const daemon = await startLocalExecDaemon(async (request) => ({
    id: request.id,
    ok: true,
  }));
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/local-exec/requests`, {
      method: "POST",
      body: "{not json",
    });
    assert.equal(res.status, 400);
  } finally {
    await daemon.close();
  }
});
