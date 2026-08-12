# Architecture

English documentation for Open-Grokbot — a clean-room re-implementation of a
modern desktop agent platform's multi-agent communication and coordination
architecture.

## 1. Process Topology

The original platform splits responsibilities across OS processes: an
Electron shell (renderer + main), a **node-agent-coordinator** utility
process (the IPC hub), a **host** agent runtime, and a **local-exec-daemon**
for isolated shell execution. Open-Grokbot mirrors this topology; in plain
Node the shell is a CLI demo and the coordinator runs as a forked child.

```mermaid
flowchart LR
    subgraph Shell["Desktop shell (Electron main + renderer) / demo CLI"]
        UI["Renderer / CLI"]
        MAIN["Main process"]
    end

    subgraph Coord["node-agent-coordinator (child process)"]
        C["CoordinatorCore"]
        S1["control session"]
        S2["data session (renderer)"]
        S3["mainData session (main)"]
        GW["Gateway SSE client"]
        HV["host supervisor"]
    end

    subgraph Host["Host (agent runtime)"]
        H["orchestration: transcript · scheduler · messaging"]
    end

    subgraph Exec["local-exec-daemon"]
        E["shell / file ops"]
    end

    UI -->|MessagePort | S2
    MAIN -->|MessagePort | S3
    MAIN -->|MessagePort | S1
    S1 --- C
    S2 --- C
    S3 --- C
    C -->|POST /api/&lt;method&gt;| GW
    GW <-->|GET /events (SSE)| H
    HV -.->|spawn / restart| Host
    H <-->|HTTP /local-exec/*| E
```

Carriers (mirroring the original's two boot paths):

| Carrier | Process | Transport | Planes |
|---|---|---|---|
| parent-port (production) | `utilityProcess.fork` | 3 × `MessageChannel` handed off in one `handoff` message | control / data / mainData |
| fork-ipc (tests, plain Node) | `child_process.fork` | one IPC pipe, `{channel}` envelope | control / mainData (no renderer) |

## 2. Layering

```mermaid
flowchart TB
    subgraph apps["apps/demo — CLI, composition root"]
        D1["demo commands"]
    end
    subgraph coord["packages/coordinator — process hub"]
        C1["CoordinatorCore · carriers · RPC contract · WebAuthn"]
    end
    subgraph transp["packages/transport — wire"]
        T1["frames · port · sse · channels · local-exec"]
    end
    subgraph run["packages/runner — execution"]
        R1["AgentRunner · SessionRuntime · GroupMemberRunner"]
    end
    subgraph msg["packages/messaging — coordination"]
        M1["A2A · group · broadcast · subagent · cross-user · cloud"]
    end
    subgraph state["packages/state — persistence"]
        S1["transcript · ledger · memory · automations · agent-store · BCS"]
    end
    subgraph core["packages/core — scheduling"]
        K1["RunScheduler · RunLifecycle · policies · clock · event-bus"]
    end
    subgraph llm["packages/llm — inference"]
        L1["Llm interface · MockLlm"]
    end

    D1 --> C1 --> T1 --> R1
    R1 --> M1 --> S1 --> K1
    R1 --> L1
```

Dependency direction is strictly downward; no layer reaches up.

## 3. Command & Event Data Flow

```mermaid
sequenceDiagram
    participant UI as Renderer / CLI
    participant PORT as PortServer (data plane)
    participant CORE as CoordinatorCore
    participant GW as Gateway client
    participant HOST as Host gateway server
    participant SCHED as RunScheduler

    UI->>PORT: request{sendPrompt, clientNonce}
    PORT->>CORE: dispatch(method, args)
    CORE->>GW: POST /api/sendPrompt (Bearer)
    GW->>HOST: accept + persist (durable acceptance)
    HOST-->>GW: 200 {accepted}
    GW-->>CORE: result
    CORE-->>PORT: reply{ok}
    PORT-->>UI: accepted
    HOST->>SCHED: enqueue turn (lane=user)
    SCHED-->>HOST: turn runs separately
    HOST--)GW: SSE {channel: transcript, payload: appended}
    GW--)CORE: event
    CORE--)PORT: event{family: transcript}
    PORT--)UI: bubble updates
```

The acceptance reply only promises durability; the turn executes
independently (durable-acceptance decoupling).

### Event-family pipeline

```
host SSE channel ──► coordinator family map ──► port event frame ──► renderer
        │                      │                        │
  16 channels           16 typed families           family-tagged
  ?channels= filter     unknown → passthrough       per-family handlers
```

The 16 families: `transcript`, `agents`, `agent-upserted`, `tray`,
`workflows`, `subagents`, `async-tasks`, `automations`, `mcp-servers`,
`forever-box`, `teach-recording`, `box-disk-pressure`, `computer-action`,
`outline`, `sharing`, `host-settings`. Unknown channels pass through
untouched so protocol evolution never breaks the pipeline.

## 4. A2A Messaging Path

```mermaid
sequenceDiagram
    participant A as Agent A (busy, lane=background)
    participant MSG as AgentToAgentMessaging
    participant Q as pendingAgentInbound[B]
    participant SCHED as Scheduler (agent B)
    participant B as Agent B

    MSG->>A: sendToAgent(B, text, priority)
    Note over MSG: validate: non-empty, not self,<br/>recipient exists, not remote mirror
    MSG->>A: append toAgent mirror entry (both transcripts rebuild the exchange)
    MSG->>A: addConversationPartner (social graph edge)
    MSG->>Q: enqueue (priority → front)
    MSG->>SCHED: reviveForAgentInbound → hidden turn (lane=agent)
    alt B idle
        SCHED->>B: wake, process inbound queue
        B-->>MSG: reply via sendToAgent(A, ...) (symmetric wake)
    else B busy with non-user work
        MSG->>B: interrupt() (steer)
        Note over B: preempted DM re-driven with isRedriven flag<br/>(at-least-once, no loops)
    end
```

Fire-and-forget: the sender never blocks on a reply; replies wake the
original sender symmetrically, so no deadlock is possible.

## 5. Group Chat Orchestration

```mermaid
sequenceDiagram
    participant U as User
    participant G as GroupChatOrchestrator
    participant M1 as Member A
    participant M2 as Member B
    participant M3 as Member C

    U->>G: group message "review the plan @B"
    loop round ≤ 3, messages ≤ 10
        G->>G: parse mentions → responders ([B] + round-robin rest)
        G->>M2: run member turn (own session + roster/persona prompt)
        M2-->>G: response
        G->>M1: next speaker (round-robin offset)
        M1-->>G: "pass" (convergence signal)
        Note over G: whole round passed → converge
    end
    Note over G: caps: 3 rounds · 10 msgs · 2 msgs/member/round · 6 members
    Note over G: user message at any time supersedes the in-flight round
```

## 6. Cross-User Shared Rooms

```mermaid
sequenceDiagram
    participant M as Mirror box (user 2)
    participant R as Backend relay
    participant H as Hosted box (user 1)

    M->>R: turn-request{nonce, roomId, fromAgentId, prompt}
    Note over M: guards: 30 turns / 10 min window,<br/>10 min backoff if unreachable,<br/>nonce dedupe (replay cached result)
    R->>H: forward turn-request
    H->>H: run remote member turn
    H-->>R: turn-result{nonce, texts ≤ 2}
    R-->>M: turn-result
    M->>M: append mirror transcript entries
```

## 7. Cloud Agent Bridge

```mermaid
sequenceDiagram
    participant L as Local agent
    participant B as CloudAgentBridge
    participant C as Cloud backend (BackgroundComposer)

    L->>B: launch(prompt) [60s ± 25% rate-limit jitter]
    B->>C: launch (30s RPC timeout)
    C-->>B: handle
    loop every 10s until settled or 5h cap
        B->>C: status
        C-->>B: pending/running/done (+filesChanged, prUrl)
    end
    B-->>L: final status
    L->>B: reply / cancel / rename / exportTranscript
```

## 8. State & Consistency

- **Transcript**: JSONL per agent (mirroring the SQLite + in-memory dual
  track); user/assistant/a2a/tool entries with `fromAgent`/`toAgent` markers
  so both sides of an exchange can rebuild the full conversation graph.
- **Acceptance ledger**: persistent nonce + input digest store; retries after
  crash/timeout replay the stored acceptance instead of double-sending.
- **BCS sync**: etag conditional writes, exclusive mutation lock with expiry,
  merge-on-conflict retry — two devices editing one agent converge.
- **Agent store**: per-agent directory (profile.json / settings.json /
  group.json / store.db-equivalent JSON files), 50-agent cap, 6-member group
  cap.

## 9. Supervision & Recovery

```mermaid
stateDiagram-v2
    [*] --> Running: spawn host
    Running --> Running: healthy
    Running --> Restarting: exit code 2 (crash)
    Running --> [*]: exit code 0 (clean)
    Running --> [*]: exit code 1 (protocol breach)
    Restarting --> Running: backoff 1s→30s exponential
```

- SSE client: connect deadline 15s, stall watchdog 35s, send timeout 15s,
  1s→10s capped backoff, infinite reconnect, re-seeded roster.
- Scheduler watchdog: wedged runs escape after 120s + 30s grace into a
  zombie — callers settle immediately, drain/delete wait for true stop.
- Port protocol: any frame contract breach settles the session and the
  coordinator kills by exit-code contract.
