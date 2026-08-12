/**
 * Cross-user shared room tests: budget window, unreachable backoff, nonce
 * idempotency, result text cap, hosted-side answering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CrossUserRelay,
  BudgetExceededError,
  UnreachableBackoffError,
  REMOTE_TURN_MAX_TEXTS,
  type TurnRequest,
} from "../src/cross-user-relay.js";

function makeRequest(nonce: string): TurnRequest {
  return { nonce, roomId: "room-1", fromAgentId: "agent-a", prompt: "status?" };
}

test("relay: executes a turn and caps the result at two texts", async () => {
  const relay = new CrossUserRelay({
    transport: {
      requestTurn: async (req) => ({ nonce: req.nonce, texts: ["one", "two", "three"] }),
    },
    clock: () => 0,
  });
  const result = await relay.executeRemoteTurn(makeRequest("n1"));
  assert.equal(result.texts.length, REMOTE_TURN_MAX_TEXTS);
  assert.deepEqual(result.texts, ["one", "two"]);
});

test("relay: nonce idempotency replays the stored result without a second transport call", async () => {
  let calls = 0;
  const relay = new CrossUserRelay({
    transport: {
      requestTurn: async (req) => {
        calls += 1;
        return { nonce: req.nonce, texts: [`answer-${calls}`] };
      },
    },
    clock: () => 0,
  });
  const first = await relay.executeRemoteTurn(makeRequest("n1"));
  const second = await relay.executeRemoteTurn(makeRequest("n1"));
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
});

test("relay: budget caps at 30 turns per 10-minute window and slides with time", async () => {
  let now = 0;
  const relay = new CrossUserRelay({
    transport: { requestTurn: async (req) => ({ nonce: req.nonce, texts: [] }) },
    clock: () => now,
  });
  for (let i = 0; i < 30; i += 1) {
    await relay.executeRemoteTurn(makeRequest(`n${i}`));
  }
  await assert.rejects(() => relay.executeRemoteTurn(makeRequest("overflow")), (error: Error) => {
    assert.ok(error instanceof BudgetExceededError);
    return true;
  });
  // Slide the window forward: old turns age out, budget is available again.
  now = 10 * 60 * 1000 + 1;
  const ok = await relay.executeRemoteTurn(makeRequest("after-window"));
  assert.equal(ok.nonce, "after-window");
});

test("relay: transport failure arms the unreachable backoff", async () => {
  let now = 0;
  let transportCalls = 0;
  const relay = new CrossUserRelay({
    transport: {
      requestTurn: async (req) => {
        transportCalls += 1;
        if (transportCalls === 1) throw new Error("backend down");
        return { nonce: req.nonce, texts: ["recovered"] };
      },
    },
    clock: () => now,
  });
  await assert.rejects(() => relay.executeRemoteTurn(makeRequest("n1")), (error: Error) => {
    assert.ok(error instanceof UnreachableBackoffError);
    return true;
  });
  // Second attempt within backoff window is rejected without touching transport.
  await assert.rejects(() => relay.executeRemoteTurn(makeRequest("n2")), (error: Error) => {
    assert.ok(error instanceof UnreachableBackoffError);
    return true;
  });
  // After the backoff elapses the relay tries again.
  now = 10 * 60 * 1000 + 1;
  const result = await relay.executeRemoteTurn(makeRequest("n2"));
  assert.equal(result.nonce, "n2");
});

test("relay: hosted side answers inbound turn-requests with the same nonce", async () => {
  const relay = new CrossUserRelay({
    transport: { requestTurn: async () => ({ nonce: "unused", texts: [] }) },
  });
  let seen: TurnRequest | null = null;
  relay.onTurnRequest(async (req) => {
    seen = req;
    return ["reply-one", "reply-two"];
  });
  const result = await relay.answerTurnRequest(makeRequest("inbound-1"));
  assert.deepEqual(result.texts, ["reply-one", "reply-two"]);
  assert.equal(result.nonce, "inbound-1");
  assert.equal(seen == null ? null : (seen as TurnRequest).prompt, "status?");
});
