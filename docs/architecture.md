# Open-Grokbot 架构文档

本框架是对现代桌面 agent 平台（Grok Bot 类）多 agent 系统的全量架构还原。本文档描述各层职责、进程拓扑、数据流与消息路径。

## 1. 分层

```
┌────────────────────────────────────────────────────────────┐
│ 客户端层 (apps/demo)                                         │
│  sendPrompt / broadcast / group / transcript 视图            │
└──────────────────────────┬─────────────────────────────────┘
                           │ 帧协议 (lifecycle/request/reply/event)
┌──────────────────────────▼─────────────────────────────────┐
│ 传输层 (packages/transport)                                  │
│  PortServer/PortClient —— 会话、方向守卫、协议违约结算         │
│  GatewaySseClient —— 命令 POST + SSE 事件流 + 退避重连        │
│  GatewaySseServer —— 命令路由、心跳、订阅过滤                 │
│  16 事件族映射 (transcript/agents/subagents/workflows/…)     │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ 调度内核 (packages/core)                                     │
│  RunScheduler —— 每 agent 排他队列，user>agent>background     │
│  watchdog(120s)+grace(30s) —— wedged run 逃逸为 zombie       │
│  RunLifecycle —— run 窗口、ack 义务                           │
│  策略族：retry(退避)/deadline/idle-watchdog/polling           │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ 消息层 (packages/messaging)                                  │
│  AgentToAgentMessaging —— A2A 队列+唤醒+priority steer        │
│  GroupChatOrchestrator —— 有界轮转群聊                        │
│  BroadcastMessaging —— 单向扇出                              │
│  SubagentRuntime —— lineage/steer/abort                      │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ 状态层 (packages/state)                                      │
│  TranscriptStore · AcceptanceLedger · MemoryStore            │
│  AutomationStore/Scheduler · AgentStore                      │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ 执行层 (packages/runner + llm)                               │
│  AgentRunner —— 提示词组装、SendMessage 提取、interrupt       │
│  SessionRuntime —— 组合根：持久化目录 + 调度 + 消息 + LLM      │
│  Llm 接口 + MockLlm                                          │
└────────────────────────────────────────────────────────────┘
```

## 2. 进程拓扑（目标形态）

完整部署形态下（路线图），进程边界与原版一致：

```
Electron main ──utilityProcess──▶ node-agent-coordinator ──HTTP/SSE──▶ host
     │                                    │                            │
     └── 3×MessagePort (control/data/mainData)                        spawn
                                                                      ▼
                                                          local-exec-daemon
```

当前仓库以 `SessionRuntime` 在单进程内装配等价组合（`packages/runner/src/session-runtime.ts`），
消息层与调度内核的接口（`MessagingHub`/`ExclusiveRunQueue`/`AgentSessionRegistry`）与进程形态解耦，
迁移到多进程时无需改动消息语义。

## 3. 数据流

### 3.1 用户消息（sendPrompt 路径）

```
用户输入
  → SessionRuntime.sendUserPrompt
  → transcript 追加 user 条目（clientNonce 可选）
  → scheduler.enqueue(lane="user")
  → AgentRunner.run
      → 组装：系统提示 + 记忆块 + transcript 尾部 + 用户消息
      → llm.complete
      → parseSendMessages 提取 SendMessage 信封
      → transcript 追加 send-message 条目
      → onProducedMessage 回调（UI/日志）
```

### 3.2 A2A 消息路径

```
Agent A (SendToAgent)
  → 校验（非空/非自聊/接收者存在/非远程镜像）
  → 群目标？→ postToGroup（房间广播，text-only）
  → A 的 transcript 追加 toAgent 镜像
  → pendingAgentInbound[B] 入队（priority 插队 + steer 中断 B 的非用户工作）
  → reviveForAgentInbound(B) → 隐藏唤醒 turn（lane="agent"）
      → B 的 transcript 追加 fromAgent 条目
      → runAgentInboundWake：逐条处理，priority 抢占时重新排队
      → DM 打断 → at-least-once 重驱（isRedriven 防环）
  → B 回复 → 对称路径唤醒 A
```

### 3.3 群聊路径

```
用户消息进入群房间 / 手动触发
  → GroupChatOrchestrator.run
  → 每轮：resolveResponders（@提及优先，否则全员）
  → orderRoundSpeakers（round 偏移轮转）
  → 每成员 runGroupMemberTurn（独立会话状态 + roster/persona/peers 系统提示）
  → 收集成员 SendMessage 产出（≤2 条/人/轮，[[pass]] 跳过）
  → postMemberMessage → 房间 transcript + 实时广播
  → 终止：总消息 ≤10 / 轮次 ≤3 / 全员 pass / 用户新消息 supersede
```

### 3.4 广播路径

```
用户 broadcastToAgents("all"|ids, message)
  → 逐目标 scheduleBroadcast（顺序调度防 db 并发打开）
  → 每个目标：隐藏唤醒 turn（lane="agent"），并发执行
  → 单向：无任何 agent 路径重入广播 → 无环
```

### 3.5 事件族（SSE → 端口事件）

```
host 内部事件（transcript 追加、roster 变化、subagent 状态…）
  → SSE channel（16 族：transcript/agents/agent-upserted/tray/workflows/
     subagents/async-tasks/automations/mcp-servers/forever-box/
     teach-recording/box-disk-pressure/computer-action/outline/sharing/host-settings）
  → 协调器 eventFamilyForSseChannel 映射
  → MessagePort event 帧 → 客户端订阅分发
```

## 4. 关键设计决策

| 决策 | 理由 |
|---|---|
| 每 agent 排他队列 + 三 lane | 用户消息永远压过 agent 间通信，杜绝饿死；单活跃任务简化并发正确性 |
| watchdog 逃逸为 zombie | 发送方 promise 不悬挂（durable acceptance 契约）；drain 仍等待真实结束（删除安全） |
| clientNonce + digest 账本 | 超时/重启/重连三重场景下零双发；digest 不匹配 = 协议违约 |
| fire-and-forget A2A | 发送方不阻塞；回复经同一路径对称唤醒，无死锁 |
| at-least-once 重驱 | 被抢占的 A2A 批次标记 isRedriven 后重新排队，防消息丢失且防环 |
| 群聊三重终止 + 用户 supersede | 防 agent 互刷死循环 |
| 群目标走房间、1:1 走唤醒 | 一个 SendToAgent 工具同时寻址 agent 与 group |
| transcript 双向标记 | 任一侧 transcript 可重建完整交换图（社交图谱/org chart） |

## 5. 持久化布局

```
<rootDir>/
├── <agentId>/
│   ├── transcript.jsonl      # 追加式会话记录
│   ├── memory.json           # agent 记忆
│   ├── automations.json      # 自动化（共享或每 agent）
│   ├── profile.json          # name/description/title
│   ├── settings.json         # 通知/隐藏/PR 链接风格
│   ├── group.json            # 群成员（仅群 room）
│   └── agent.json            # id/时间戳/origin/isGroup
└── automations.json          # 全局自动化索引
```

## 6. 演进路径（对齐原版未覆盖面）

- 协调器子进程：`transport` 的 PortServer/Client 已就绪，需 carrier（utilityProcess 三端口）与
  bootstrap 校验、退出码契约（0/1/2）。
- 跨用户共享房间：`messaging` 的群聊已支持 remoteMembers 数据模型，需 relay 传输层
  （turn-request/turn-result、预算、nonce 去重）。
- 云 agent：`runner` 已有 CloudAgent 桥接口预留，需 BackgroundComposer gRPC 客户端。
- local-exec：`transport` 的 SSE 网关可扩展 `/local-exec/*` 端点，需 daemon 进程。
