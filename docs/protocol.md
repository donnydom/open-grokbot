# Open-Grokbot 协议规范

本文档定义框架各层的线格式与契约，作为实现与未来互操作的权威参考。

## 1. MessagePort 帧协议（客户端 ↔ 协调器）

### 1.1 帧类型

```ts
// 客户端 → 服务端
{ kind: "lifecycle", phase: "ready" | "shutdown", reason?: string }
{ kind: "request", requestId: string, method: string, args?: unknown }

// 服务端 → 客户端
{ kind: "lifecycle", phase: "ready" | "shutdown", reason?, detail? }
{ kind: "reply", requestId: string, outcome: ReplyOutcome }
{ kind: "event", family: string, payload: unknown }

// ReplyOutcome
{ kind: "ok", value: unknown }
{ kind: "error", errorName, errorMessage, errorStack? }
{ kind: "unknown-method", method }
```

### 1.2 会话规则

1. 客户端必须先发 `lifecycle ready`（hello），之前任何 request 帧 = **协议违约**。
2. `request` 帧必须携带非空 `requestId`（客户端自增 `r1, r2, …`）与方法名。
3. 未知方法回复 `unknown-method`，不视为违约。
4. 任一方向发出 `shutdown` 或通道关闭 → 会话以 `clean` 结算；违约 → `protocol-breach`。
5. 进程契约（协调器形态）：退出码 0 = 干净结算，1 = 协议违约，2 = bootstrap 失败。

## 2. 网关 wire（协调器 ↔ host）

### 2.1 端点

| 端点 | 方法 | 语义 |
|---|---|---|
| `POST /api/<method>` | POST | 命令：JSON body = 单一参数（无参命令为空对象），JSON 响应 = 返回值；错误 `{ "error": msg }` + 4xx/5xx |
| `GET /events` | GET | SSE 事件流；`retry: 1000`；`?channels=a,b,c` 订阅过滤（缺省 = 全量） |
| `GET /health` | GET | 存活探测：`{ ok, pid, isBusy, activeAgentId, startedAt }`（免认证） |
| `GET /avatars/<agentId>?v=<version>` | GET | 头像资源（HTTP 缓存，immutable） |

### 2.2 SSE 事件格式

```
retry: 1000
:ping                      <- 15s 心跳（客户端 stall watchdog 依赖）

data: {"channel":"transcript","payload":{...}}
```

- payload 保持原样透传（边界不校验，按族信任）。
- 16 个通道 ↔ 事件族映射见 `packages/transport/src/channels.ts`。

### 2.3 认证

- `authorization: Bearer <token>`：host 启动时铸造，随 discovery 记录下发；`/health` 豁免。

### 2.4 可靠性参数

| 参数 | 值 | 说明 |
|---|---|---|
| SSE 重连退避 | 1s → 10s，×2，无限 | 每次建立流重置回底 |
| connect deadline | 15s | 半开 socket 不悬挂 |
| stall watchdog | 35s | >2 个心跳周期无字节即视为死流 |
| send POST deadline | 15s | durable acceptance 应亚毫秒返回 |
| roster 读 deadline | 15s | 启动门禁 |

### 2.5 sendPrompt 幂等重试

- 首次失败分两类：**传输失败**（connect refused/reset/超时，fetch 拒绝）与 **网关决策错误**（HTTP 错误，`GatewayCommandError`）。
- 仅传输失败可重试，且必须满足：携带 `clientNonce` 且（POST 未发出 **或** 目标端点已证明支持 nonce 去重）。
- 端点去重能力探测：成功响应的 `accepted: true` 即标记该 baseUrl 为 proven。
- 重试恰好一次。

## 3. 幂等发送账本（AcceptanceLedger）

```
admitSend({ accountSlot, clientNonce, inputDigest })
  ├─ 已存在 + 同 digest  → duplicate（no-op 成功）
  ├─ 已存在 + 异 digest  → digest-mismatch（协议违约，拒绝分发）
  └─ 不存在             → accepted（记录 pending）
markAccepted(nonce)  → 持久化接受点（durable acceptance）
markRejected(nonce, msg) → 记录拒绝并回放
clear(nonce)         → 中途失败清理，允许重试
```

- `inputDigest = sha256(JSON.stringify({agentId, prompt, richText, replyToId, isFork, attachmentPaths, attachmentNames}))`，在边界处、任何防御性改写之前计算。
- 账本 JSON 文件持久化，跨进程重启存活。

## 4. A2A 消息契约（SendToAgent）

```
sendToAgent(from, to, text, {images?, priority?})
```

| 校验 | 结果 |
|---|---|
| 文本空（trim 后） | bounce："Message was empty" |
| `to === from` | bounce："An agent can't message itself." |
| 接收者不存在 | bounce："That agent no longer exists." |
| 目标是远程镜像房间 | bounce（流量走 relay，本地不唤醒） |
| 目标是群 room | 走 `postToGroup`（text-only，不携带图片/优先级语义） |
| 其他 | 投递 |

投递语义：

1. 发送方 transcript 追加 `toAgent` 镜像（`kind:"agent"` → 渲染 "To <agent>" chip）。
2. `pendingAgentInbound[recipient]` 入队；priority 插队到队首。
3. `reviveForAgentInbound` 合并批量 → 一次隐藏唤醒 turn（`lane:"agent"`）。
4. 唤醒 prompt：`buildAgentInboundWakePrompt`（from/text/images/priority），允许静默。
5. priority：`steerRecipientForPriorityPeer` 中断接收方当前非用户工作（lane 非 user 才可中断）。
6. 被用户 DM 抢占 → 未处理批次标 `isRedriven` 重新排队（at-least-once，防环）。
7. 接收方 transcript 追加 `fromAgent` 条目；社交图谱双向 `addConversationPartner`。

## 5. 群聊契约

### 5.1 常量

| 常量 | 值 |
|---|---|
| GROUP_MAX_MEMBER_TURNS | 10（总消息上限） |
| GROUP_MAX_ROUNDS | 3 |
| GROUP_MAX_MESSAGES_PER_TURN | 2（每人每轮） |
| GROUP_PROMPT_HISTORY_LIMIT | 24 |
| GROUP_MAX_MEMBERS | 6 |

### 5.2 轮转规则

- 每轮先解析上一条消息的 @提及（`@everyone|@all` 或成员名 handle：全名/去空格/首词）决定应答者；无提及 = 全员。
- 发言顺序按 `orderRoundSpeakers(ids, round)` 偏移轮转。
- 成员输出中 `[[pass]]`/`[pass]`/`PASS` 表示放弃本轮。
- 终止：消息上限 / 轮数上限 / 整轮无发言 / 用户新消息 supersede（每轮成员边界检查）。

### 5.3 成员上下文

- 每个成员用**自己的**会话状态：`messagesSinceMemberLastSpoke` 只喂新消息，历史由持久化 transcript 承载。
- 系统提示注入：自身身份、群目的、peers roster（name+description）、发言规则。
- 共享房间（跨用户）：无私有状态，房间最近窗口（SHARED_ROOM_HISTORY_LIMIT=24）即全部上下文。

## 6. 广播契约

```
broadcastToAgents("all" | ids[], message)
  → { total, scheduled }
```

- 单向（用户→agent）；无 agent 路径重入 → 无环。
- 顺序调度（防同时打开所有会话 db），唤醒 turn 并发执行（各自 lane 队列）。
- 群/镜像房间目标跳过；目标不存在跳过（scheduled 计数反映实际）。
- 消息经 `clampBroadcastMessage`（8000 字符截断）。

## 7. Subagent 契约

```
dispatchBackgroundSubagent({ subagentAgentId, subagentType, toolCallId, prompt, lineage? })
  → boolean（false = 已存在同 id 运行）
steerSubagent(id, prompt) → boolean（运行中 → 中断重定向；未启动 → 排队）
abortSubagent(id) → boolean
awaitSubagent(id) → Promise<void>
```

- 运行前 steer 排队，run 启动后立即应用。
- `settled` 语义：run 真正结束时 resolve；abort 使运行提前结算；结算幂等（终态不被覆盖）。
- lineage 记录父 agent id + 工具调用 id（subagent 请求 id 派生）。

## 8. transcript 条目

| kind | 字段 | 用途 |
|---|---|---|
| `message` | role user/assistant, content, replyTo, fromAgent, toAgent, channel, clientNonce, isFork | 对话/peer 消息 |
| `tool-call` | tool, callId, status, input, output | 工具调用记录 |
| `send-message` | message（text/widget/attachment/secret-request）, messageId | agent 对用户的唯一发声 |
| `user-attachment` | url, fileName, byteSize | 附件 |
| `notice` | text | 系统通知 |
| `event` | event, payload | 事件记录（scratchpad 等） |

ID 方案：`t<turn>u`（用户）、`t<turn>s<seq>`（assistant/send-message）、`t<turn>a<seq>`（附件）、`t<turn>n<seq>`（notice/event）。

## 9. 自动化契约

```
create/update/delete/setEnabled/list
trigger: { type: "schedule", cron: "m h [* * *]" }
       | { type: "interval", intervalMinutes }
       | { type: "channel", platform }
       | { type: "manual" }
```

- 调度器每 60s 扫描（可配）；interval 到期即触发；schedule 为 UTC 分钟/小时边界（每日）。
- 触发 → 目标 agent 后台 lane 唤醒 turn；`recordRun` 更新 runCount/lastRunAtMs。

## 10. 协调器载体契约（carrier）

### parent-port（Electron utilityProcess）

父进程创建 3 个 `MessageChannel`，`port2` 通过单条 handoff 消息移交：

```json
{
  "type": "handoff",
  "controlPort": "<MessagePort>",
  "dataPort": "<MessagePort>",
  "mainDataPort": "<MessagePort>"
}
```

子进程收到 handoff 后以三个 PortServer 会话应答；任何帧违约 → 会话结算 → 进程按退出码契约终止。

### fork-ipc（Node fork，测试/纯 Node 部署）

单一 IPC 管道，control / mainData 用 envelope 多路复用：

```json
{ "channel": "control" | "mainData", "data": "<ServerFrame>" }
```

无 envelope 的裸帧归 control（对应原版宽松解析）。fork-ipc 无渲染进程，故无 data 平面。

### 退出码契约

| 码 | 语义 | 监督动作 |
|---|---|---|
| 0 | 干净退出 | 不重启 |
| 1 | 协议违约（kill-by-contract） | 不重启 |
| 2 | 崩溃 | 指数退避重启（1s 基数，30s 上限） |

### RPC 方法清单（rpc-contract）

data 平面：`sendPrompt`、`broadcastToAgents`、`createGroup`、`setGroupMembers`、`getSubagents`、`getAsyncTasks`、`listChannels`、`sharedRooms`、`foreverBox`、`teachRecording`。
mainData 平面：`hostStatus`、`restartHost`。
control 平面：`hello`、`ping`、`webauthnMakeCredential`、`webauthnGetAssertion`。

## 11. 跨用户共享房间（xuser relay）

```
mirror box ── turn-request ──► backend relay ──► hosted box
           ◄── turn-result ──                 (远程成员 turn，≤2 条文本)
```

```jsonc
// turn-request
{ "nonce": "uuid", "roomId": "room-1", "fromAgentId": "a1", "prompt": "..." }
// turn-result
{ "nonce": "uuid", "texts": ["最多两条文本消息"] }
```

防滥用常数：

| 常数 | 值 |
|---|---|
| `REMOTE_TURN_MAX_TEXTS` | 2 |
| `TURN_BUDGET_WINDOW_MS` | 10 min |
| `TURN_BUDGET_MAX_PER_WINDOW` | 30 |
| `UNREACHABLE_BACKOFF_MS` | 10 min |

nonce 幂等：重复请求直接重放缓存结果（不二次执行、不消耗预算计数器的结果语义）。

## 12. 云 agent 桥（BackgroundComposer 契约）

方法：`launch` / `reply` / `cancel` / `rename` / `status` / `exportTranscript`。

```jsonc
// launch
{ "localAgentId": "a1", "prompt": "fix tests", "cwd": "/repo" }
// status
{ "state": "pending|running|done|failed|cancelled",
  "filesChanged": ["src/index.ts"], "prUrl": "https://..." }
```

时序常数：

| 常数 | 值 |
|---|---|
| `CLOUD_POLL_INTERVAL_MS` | 10 s |
| `CLOUD_RPC_TIMEOUT_MS` | 30 s（客户端 Promise.race，backend 挂死也不阻塞） |
| `CLOUD_RUNTIME_CAP_MS` | 5 h |
| `CLOUD_RATE_LIMIT_BASE_MS` ± `CLOUD_RATE_LIMIT_JITTER` | 60 s ± 25% |

## 13. local-exec 通道

| 端点 | 方法 | 语义 |
|---|---|---|
| `/local-exec/heartbeat` | POST | 续命心跳 |
| `/local-exec/requests` | POST | 提交请求（202 accepted） |
| `/local-exec/responses` | POST | 轮询 `["id", ...]` → `{responses: [...]}` |

| 常数 | 值 |
|---|---|
| `LOCAL_EXEC_HEARTBEAT_MS` | 10 s |
| `LOCAL_EXEC_LIVENESS_WINDOW_MS` | 30 s（心跳缺席即判死） |
| `LOCAL_EXEC_RESPONSE_TIMEOUT_MS` | 10 s |

## 14. BCS 多端同步

| 原语 | 语义 |
|---|---|
| `get` / `put(id, value, expectedEtag)` | etag 条件写；不匹配返回 `{conflict: true}` |
| `lock(id, owner, ttl)` / `unlock` | 排他变更锁（60s 默认 TTL，到期自动失效） |
| merge-on-conflict | 冲突后重读远端、merge、重试条件写；再冲突抛 `BcsConflictError` |
