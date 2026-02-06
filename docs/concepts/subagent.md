# Subagent 系统架构

## 概述

OpenClaw 的 Subagent 系统允许主 agent 在后台 spawn 独立的子 agent 来执行特定任务。Subagent 运行在隔离的 session 中，完成后将结果精简报告给主 agent。

**术语区分**：

- **Teammate** — Claude Code CLI Agent Teams 中的并行 Claude 实例（CC 原生概念）
- **Subagent** — OpenClaw 应用层的后台任务，由 `SubagentManager` 管理

## 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                       主 Agent 对话                         │
│                                                             │
│  sessions_spawn(task, planMode?)                            │
│       │                                                     │
│       ▼                                                     │
│  ┌──────────────────┐     ┌──────────────────────────┐      │
│  │ SubagentManager  │◄────│ SubagentRegistry         │      │
│  │ (内存状态)        │     │ (磁盘持久化)              │      │
│  │                  │     │                          │      │
│  │ - running Map    │     │ - subagentRuns Map       │      │
│  │ - completed Map  │     │ - persistence (.json)    │      │
│  │ - reserved Map   │     │ - lifecycle listener     │      │
│  └──────┬───────────┘     └──────────┬───────────────┘      │
│         │                            │                      │
│         │  markCompleted()           │  runSubagentAnnounce │
│         │                            │  Flow()              │
│         ▼                            ▼                      │
│  ┌──────────────────────────────────────────────────┐       │
│  │              Announce Flow                        │       │
│  │  精简消息注入主 agent 对话（~5 行）                 │       │
│  │  完整输出留在 subagent session transcript          │       │
│  └──────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 文件对照

| 文件                                                | 职责                                                      |
| --------------------------------------------------- | --------------------------------------------------------- |
| `src/agents/subagent-manager.ts`                    | 内存状态管理：并发限制、总数上限、状态查询、心跳唤醒      |
| `src/agents/subagent-registry.ts`                   | 持久化管理：磁盘读写、lifecycle 事件监听、announce 触发   |
| `src/agents/subagent-announce.ts`                   | 输出处理：系统提示词构建、结果摘要提取、announce 消息发送 |
| `src/agents/tools/sessions-spawn-tool.ts`           | 工具入口：参数解析、权限检查、subagent 创建               |
| `src/agents/tools/sessions-subagent-remove-tool.ts` | 删除工具：手动释放已完成 subagent 槽位                    |

## 生命周期

```
1. spawn
   sessions_spawn(task, label?, planMode?)
     → reserveSubagentSlot()        # 原子预留槽位
     → callGateway("agent")         # 创建子 session + 启动 run
     → registerSubagentRun()        # 持久化 + 内存注册
     → waitForSubagentCompletion()  # 异步等待完成

2. running
   subagent 独立运行，有自己的 session 和 transcript
   主 agent 通过 getStatusForPrompt() 在系统提示词中看到运行状态

3. completed
   lifecycle event → subagentManager.markCompleted()
                   → requestHeartbeatNow()  # 唤醒主 agent
                   → runSubagentAnnounceFlow()
                     → extractSummary()     # 提取摘要（≤200字符）
                     → 精简消息注入主 agent  # 不注入完整 findings

4. cleanup
   cleanup="delete" → 删除子 session + transcript
   cleanup="keep"   → 保留（planMode 强制 keep）
```

## 并发与容量控制

- **并发限制**：`MAX_CONCURRENT_SUBAGENTS = 5`（同时运行中的 subagent）
- **总数上限**：`MAX_RETAINED_SUBAGENTS = 15`（运行中 + 已完成，含预留槽位）
- **预留槽位**：`reserveSlot()` 原子操作，防止并发 spawn 超限，30 秒超时自动释放
- 满 15 个时 spawn 失败，需用 `sessions_subagent_remove` 手动删除已完成的

## 上下文管理（精简注入）

**设计原则**：避免上下文膨胀。

旧方案的问题：每个完成的 subagent 往主 agent 对话注入 2 条消息（`enqueueSystemEvent` 回调 + announce 的完整 findings），永久累积占用上下文。

当前方案：

1. 完整输出留在 subagent 的 session transcript 中
2. 主 agent 对话只收到精简消息（~5 行）：

   ```
   [Subagent] "任务名" completed successfully
   session: agent:xxx:subagent:yyy

   Summary: 1-2 句摘要

   Stats: runtime 30s • tokens 5k (in 3k / out 2k)
   ```

3. 主 agent 需要详情时用 `sessions_history` 读取

**摘要提取**（`extractSummary`）：

- 优先查找 `SUMMARY:` 标记（subagent 系统提示词引导输出此标记）
- 回退：取回复最后 200 个字符

## Plan Mode

允许 subagent 先做计划、主 agent 审批后再执行。

```
1. sessions_spawn(task, planMode: true)
   → cleanup 强制 "keep"
   → 系统提示词注入 PLAN MODE 限制（只研究不实施）

2. Subagent 研究 + 写计划 → 运行结束

3. Announce flow 发送特殊消息：
   [PLAN READY] "任务名" plan completed
   session: agent:xxx:subagent:yyy

   To approve: sessions_send sessionKey="..." message="APPROVED: proceed"
   To reject:  sessions_send sessionKey="..." message="REJECTED: <reason>"

   Summary: 计划摘要

4. 主 agent 审批：
   sessions_send → 同一 session → 保留计划上下文 → 正常执行

   失败时发 [PLAN FAILED]，不提供审批指令
```

**状态显示**：`getStatusForPrompt()` 中 plan mode subagent 显示 `[PLAN]` / `[PLAN:AWAITING APPROVAL]` / `[PLAN:APPROVED]` 标签。

## 状态持久化与重启恢复

`SubagentRegistry` 负责持久化：

- `saveSubagentRegistryToDisk()` — 每次状态变更时写入磁盘
- `loadSubagentRegistryFromDisk()` — 进程启动时恢复
- 恢复后通过 `syncFromRecord()` 同步到 `SubagentManager` 内存状态
- 已完成的记录也会恢复到 `completed` map，确保总数上限在重启后仍然生效

## 工具一览

| 工具名                     | 用途                                              |
| -------------------------- | ------------------------------------------------- |
| `sessions_spawn`           | 创建后台 subagent（支持 planMode）                |
| `sessions_subagent_remove` | 删除已完成的 subagent，释放槽位                   |
| `sessions_history`         | 读取 subagent 的完整输出                          |
| `sessions_send`            | 向 subagent session 发消息（用于 plan mode 审批） |
| `sessions_list`            | 列出所有 session（包含 subagent session）         |
