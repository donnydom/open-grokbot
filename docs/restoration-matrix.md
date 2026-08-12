# Restoration Matrix

还原度矩阵：原版（Grok Bot / Cursor-class 平台）模块 ↔ Open-Grokbot 实现文件 ↔ 测试覆盖。

## Legend

- ✅ full — semantics reconstructed and test-covered
- 🟡 partial — contract/type level only (needs a live counterpart to run)
- ⬜ not yet — on the roadmap

## Core scheduling

| Original module | Implementation | Tests | Status |
|---|---|---|---|
| dune scheduling / RunScheduler | `packages/core/src/run-scheduler.ts` | lane priority, exclusivity, concurrency, watchdog escape + drain, rejection, diagnostics | ✅ |
| RunLifecycle (begin/endSessionRun windows, ack obligations) | `packages/core/src/run-lifecycle.ts` | window collapse, ack retirement, scheduler attach | ✅ |
| Retry/deadline/idle-watchdog/polling policies | `packages/core/src/policies.ts` | backoff growth/cap, deadline rejection | ✅ |
| Clock abstraction (real/manual) | `packages/core/src/clock.ts` | — | ✅ |
| Event bus | `packages/core/src/event-bus.ts` | — | ✅ |

## Coordinator (node-agent-coordinator)

| Original module | Implementation | Tests | Status |
|---|---|---|---|
| carrier (parent-port handoff / fork-ipc envelope) | `packages/coordinator/src/carrier.ts` | handoff accept, envelope demux | ✅ |
| renderer-port-server (3-plane sessions) | `packages/coordinator/src/coordinator.ts` | fork-ipc real child round-trip, parent-port handoff, command forwarding, event fan-out | ✅ |
| RPC contract (sendPrompt, broadcastToAgents, groups, subagents, workflows, automations, channels, sharedRooms, foreverBox, teachRecording, hostStatus, restartHost, hello, ping, WebAuthn) | `packages/coordinator/src/rpc-contract.ts` | unknown-method rejection | ✅ |
| Host supervision (exit codes 0/1/2, restart backoff) | `packages/coordinator/src/coordinator.ts` | crash-restart, clean/protocol no-restart, backoff | ✅ |
| WebAuthn provider | `packages/coordinator/src/webauthn.ts` | simulated provider ceremonies | ✅ |
| Process entrypoint (--bootstrap) | `packages/coordinator/src/entry.ts` | smoke | ✅ |

## Transport

| Original module | Implementation | Tests | Status |
|---|---|---|---|
| gateway-wire (POST /api/<method>, Bearer) | `packages/transport/src/sse.ts` | gateway server+client commands | ✅ |
| gateway-client (connect/stall/send deadlines, 1s→10s backoff, infinite reconnect) | `packages/transport/src/sse.ts` | sendPrompt no-retry-before-proven + one retry after, SSE reconnect | ✅ |
| gateway-server (SSE stream, :ping 15s, ?channels= filter) | `packages/transport/src/sse.ts` | channel filter, heartbeat | ✅ |
| gateway-event-families (16 channels) | `packages/transport/src/channels.ts` | family↔channel map | ✅ |
| MessagePort frame protocol (lifecycle/request/reply/event, breach → settle) | `packages/transport/src/frames.ts`, `port.ts` | direction guards, hello-before-request breach, clean shutdown | ✅ |
| local-exec gateway (10s heartbeat, 30s liveness, 10s response timeout) | `packages/transport/src/local-exec.ts` | round-trip, heartbeat liveness, response timeout, malformed 400 | ✅ |

## State

| Original module | Implementation | Tests | Status |
|---|---|---|---|
| transcript (SQLite + memory mirror) | `packages/state/src/transcript.ts` (JSONL + memory) | persistence round-trip, a2a markers, t<turn>u/s numbering | ✅ |
| send acceptance ledger (nonce + input digest, survives restart) | `packages/state/src/acceptance-ledger.ts` | dedupe, digest mismatch, restart survival | ✅ |
| memory | `packages/state/src/memory.ts` | upsert/read | ✅ |
| automations (schedule) | `packages/state/src/automations.ts` | crud + next-run computation | ✅ |
| agent store (profile/settings/group, 50 cap, 6-member group) | `packages/state/src/agent-store.ts` | limits, group membership | ✅ |
| agent-store-sync BCS (etag, exclusive lock, conflict detection) | `packages/state/src/agent-store-sync.ts` | conditional write, merge-on-conflict, hard conflict, lock serialization | ✅ |
| transcript-mirror worker (journal codec) | — | — | ⬜ roadmap |

## Messaging

| Original module | Implementation | Tests | Status |
|---|---|---|---|
| agent-to-agent-messaging (queue, revive, priority steer, redrive) | `packages/messaging/src/agent-messaging.ts` | queue+wake+mirror, guards, group routing, priority steer | ✅ |
| group-chat-orchestrator (bounded rounds, mentions, pass convergence) | `packages/messaging/src/group-chat.ts`, `group-orchestrator.ts` | mention parse, round-robin, bounded rounds, message cap | ✅ |
| background-wakes (hidden turns) | via `reviveForAgentInbound` in agent-messaging | wake turn lane=agent | ✅ |
| broadcastToAgents (one-way fan-out, no loops) | `packages/messaging/src/broadcast.ts` | fan-out, group skip, one-way | ✅ |
| subagent-runtime (lineage, steer, abort, registry) | `packages/messaging/src/subagent-runtime.ts` | dispatch, registry, steer queue, abort | ✅ |
| cross-user-sharing (turn-request/result, budget, backoff, nonce) | `packages/messaging/src/cross-user-relay.ts` | text cap, nonce idempotency, budget window slide, backoff arm/recover, hosted answering | ✅ |
| cloud-agents (BackgroundComposer bridge) | `packages/messaging/src/cloud-agent-bridge.ts` | launch poll lifecycle, rpc timeout, runtime cap, reply/cancel/rename, rate-limit | ✅ |
| xuser backend relay (real transport) | — | — | 🟡 protocol contract only |

## Runner / LLM

| Original module | Implementation | Tests | Status |
|---|---|---|---|
| sand-agent-runner (turn execution, interrupt) | `packages/runner/src/agent-runner.ts` | interrupt aborts in-flight completion | ✅ |
| SendMessage-only speech extraction | `packages/runner/src/send-message-parser.ts` | envelope extraction, scratch ignored | ✅ |
| host composition root | `packages/runner/src/session-runtime.ts` | e2e user→agent, a2a wake→reply, group convergence | ✅ |
| chat-inference adapter (real providers) | `packages/llm/src/index.ts` | — | 🟡 mock only; real OpenAI/Anthropic on roadmap |
| cloud gRPC client (proto) | — | — | 🟡 contract only; proto not captured |

## Totals

| Package | Tests |
|---|---|
| core | 10 |
| coordinator | 8 |
| transport | 12 |
| state | 10 |
| messaging | 20 |
| runner | 5 |
| **Total** | **65** |
