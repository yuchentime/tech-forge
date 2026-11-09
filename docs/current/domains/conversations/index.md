---
status: current
layer: domain
domain: conversations
canonical_for:
  - agent-conversation-persistence
related:
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/domains/conversations/api-contract.md
  - docs/current/domains/conversations/backend-behavior.md
  - docs/source/data-model-design.md
  - docs/source/data-model-fields.md
  - docs/changes/2026-11-07-conversation-session-persistence/design.md
  - docs/changes/2026-11-07-conversation-history-sidebar/design.md
  - docs/changes/2026-11-07-agent-flow-logging/verification.md
  - docs/changes/2026-11-08-chat-api-rename/brief.md
  - docs/changes/2026-11-08-conversation-tool-activity-history/brief.md
  - docs/changes/2026-11-08-conversation-tool-activity-history/design.md
  - docs/changes/2026-11-08-conversation-tool-activity-history/verification.md
  - docs/changes/2026-11-08-conversation-tool-activity-history/worklog.md
last_verified: 2026-11-08
---

# Conversation 对话持久化

当前 Agent 聊天使用 SQLite 中的 `ConversationEntity` 和 `MessageEntity` 保存对话。用户输入、Pi assistant/toolResult 消息快照和工具执行状态均写为有序消息行。`ConversationsService` 负责查询、排序、写入和下一请求时的中断对账；Conversation 模块提供只读列表和可见消息历史 API。Agent、LLM、持久化及查询边界通过同一请求 ID 输出结构化诊断日志，具体字段和脱敏规则见 [Conversation backend 行为](backend-behavior.md)。

## 当前行为

- `POST /api/chat/stream` 接收 `prompt` 和可选 UUIDv4 `conversationId`。未提供 ID 时后端创建 Conversation，并在 SSE 流开始时发送 `conversation` 元数据事件。
- Renderer 将活动 ID 保存在 localStorage，并在该 UI 活动对话的后续请求中复用。
- Agent 页面启动时读取会话摘要并显示在左侧栏；若 localStorage 中的活动 ID 仍存在，则读取该会话最近 30 条可见消息。选中其他会话也只加载最近 30 条；存在更早消息时，用户可按需继续加载并前置到当前 LocalRuntime 线程。
- 历史 DTO 的状态由 Renderer 按角色映射：只有 assistant 向 LocalRuntime 传递状态；user 保留文本、ID 和时间。该契约已通过真实 Electron 恢复/切换及实际 assistant-ui 转换回归验证。
- `GET /api/conversations` 按 `updatedAt DESC, createdAt DESC` 返回摘要；标题使用实体标题、首条用户消息文本或“新对话”的显示回退，不写回实体。
- `GET /api/conversations/:conversationId/messages` 默认返回最近 30 条可见终态 user/assistant 文本及 `hasMore`；使用同会话消息 ID 游标读取更早一页。单页按 `sequenceNo ASC` 返回；user 行可嵌套其轮次中的安全 `toolActivities` 摘要，工具执行行不会作为顶层消息返回。
- 每轮开始时，后端在短 SQLite 事务中保存 `user/completed` 行和 `assistantTurn/pending` 标记；模型调用不在数据库事务内。
- Pi assistant 与 `toolResult` 消息按原生消息结构逐事件持久化；工具执行开始、进度、最终结果和终态另存 `toolExecution` 行。Pi 扩展钩子等待 SQLite 写入后才让事件继续派发或工具开始执行。
- 模型上下文优先从 `pi_session_snapshots` 恢复（含 Pi compaction 等条目）；仅当快照落后于 SQLite 最新历史或不存在时，才按 `sequenceNo` 用 UI 历史重建。UI 历史仍完整保存在 SQLite，与模型上下文不是同一集合。
- Message `sequenceNo` 在 Conversation 内递增；ChatService 在单一 backend 进程内按 conversation 串行化同一对话请求。
- 应用重启后，后端优先从快照恢复模型上下文；快照缺失或落后时再从 SQLite 重建。Renderer 在 Agent 页面启动后会加载上次选中对话的可见历史。

## 当前边界

- 工具消息及执行状态保存在本地 SQLite。历史 API 可在对应 user 行下返回工具名、状态、耗时、可选路径和 `grep` 搜索词；不会暴露完整工具参数、部分/最终结果或 Pi `toolResult` 内容。
- 没有重命名或删除 API；会话摘要列表不分页，消息历史固定为 30 条一页并支持按需读取更早内容。
- 异常退出后的恢复在该对话下一次请求开始时执行；不会续跑原来的 provider 调用。
- 对账发现 assistant tool call 缺少 toolResult 时，会优先用已保存的工具最终结果重建；若最终结果还未产生，则补一条合成中断错误结果，避免重放可能已产生外部副作用的工具调用。
- 每轮读取全部历史，没有持久化摘要或上下文裁剪；超长对话可能超过模型上下文窗口。

实现入口见 [Conversation backend 行为](backend-behavior.md) 和 [Conversation API 契约](api-contract.md)；实体字段草案仍位于 `source/`，以代码作为当前事实。
