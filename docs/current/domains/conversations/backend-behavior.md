---
status: current
layer: domain
domain: conversations
canonical_for:
  - conversation-session-backend-behavior
related:
  - docs/current/domains/conversations/index.md
  - docs/current/domains/conversations/api-contract.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/changes/2026-11-07-conversation-history-sidebar/verification.md
  - docs/changes/2026-11-07-conversation-session-persistence/verification.md
  - docs/changes/2026-11-07-agent-flow-logging/design.md
  - docs/changes/2026-11-07-agent-flow-logging/verification.md
last_verified: 2026-11-07
---

# Conversation 后端行为

## 写入流程

`AgentController` 校验请求并将 `conversationId` 交给 `AgentService`。`AgentService` 在进程内按 ID 排队，然后调用 `ConversationsService.beginTurn()`：确认或创建 Conversation、对账遗留行、读取已有消息、按 `sequenceNo` 取最大值并加一，接着写入本轮 user 消息和 pending `assistantTurn` 标记。新 ID 由 backend 生成 UUIDv4。

事务结束后，`AgentService` 才调用 `LlmService.stream()`。`LlmService` 注册请求级 Pi 扩展钩子：每个 assistant/toolResult 的 `message_start/update/end` 以及工具执行 `start/update/end` 都先写入 `MessageEntity`，其中 `tool_execution_end` 的最终结果也先落库；SQLite 提交后 Pi 才继续后续事件处理或启动工具。`AgentService` 在已持久化的事件到达后再投影和转发安全字段。用户行在模型调用前已写入。

流结束、失败或取消时，`finishTurn()` 在短事务内更新 `assistantTurn` 和仍处于 pending 的消息/工具行；助手快照保留已经生成的原生内容。`Conversation.updatedAt` 随每轮开始和结束更新。SQLite 写入失败会中止 Pi 请求并作为流错误处理。

## Pi 上下文恢复

每轮开始时，`ConversationsService` 按 `sequenceNo` 检查上一轮遗留状态。未完成 assistant 快照转为失败或取消状态，并从不完整快照删除尚未完成的 toolCall block，保留已持久化文本。运行中的工具行标记为 interrupted。若已结束的 assistant 消息包含没有对应 `toolResult` 的调用，服务优先用 `tool_execution_end` 行里的最终结果重建 toolResult；若没有最终结果则补一条合成错误结果，避免恢复时 Pi 重放该工具。

`LlmService` 将当前对话的 user 行和持久化 Pi assistant/toolResult 行按 `sequenceNo` 映射成 `SessionMessageEntry`，并传给 `SessionManager.inMemory(cwd, { id }, entries)`。旧版本纯文本 assistant 行仍以当前 Pi model 元信息和零 usage 计数重建。assistant/toolResult 原生 payload 与用户输入一起传给大模型；assistantTurn 标记和 toolExecution 状态行不进入模型上下文。Pi SDK 仍由 `SessionManager` 负责构造下一次请求历史，SQLite 是外部持久来源，不创建 Pi session 文件。

## API 与错误

| 边界 | 当前契约 |
|---|---|
| 请求 | `POST /api/agent/stream`：`prompt` 必填，`conversationId` 可选 UUIDv4 |
| 首个 SSE 元数据 | `conversation`：仅包含 backend 确认的 `conversationId` |
| 请求 ID 未找到 | 后端不隐式创建新对话；流发送通用 Agent error SSE 事件，请求不写入消息行 |
| provider / 存储错误 | 通过安全错误 SSE 处理；provider 失败会结束 assistantTurn 为 failed；Pi 事件写入失败会触发 Pi abort 并作为流错误暴露 |
| 客户端断开 | 取消 Pi 请求并将 assistantTurn 设为 cancelled；中断工具行保留为 interrupted/failed 状态 |

Conversation 查询接口由 `ConversationsController` 暴露，并经现有本地 token 与 loopback HTTP 边界访问：

- `GET /api/conversations` 按 `updatedAt DESC, createdAt DESC` 返回摘要。标题优先使用非空 `Conversation.title`，否则使用首条 user 消息的文本（折叠空白并限制为 80 个字符），没有文本时为 `新对话`。该读取不回写标题。
- `GET /api/conversations/:conversationId/messages` 接受 UUIDv4；Conversation 不存在时返回 404。消息只包括 `user`/`assistant` 角色和 `completed`/`failed`/`cancelled` 状态，按 `sequenceNo ASC` 返回 `id`、`role`、纯文本 `content`、`status`、`createdAt`。不存在的会话不隐式创建。
- 消息查询仅输出文本内容；内部 `toolExecution`、`toolResult`、`assistantTurn`、pending 状态、thinking 和工具调用内容不进入 API 响应。无可显示文本的 assistant 行会被省略。
- 列表和消息历史当前全部读取，不分页；空列表返回 `[]`，空历史返回 `[]`。

## 诊断日志

Agent 请求由 `AgentController` 生成 `requestId`，沿轮次编排、Pi/LLM 执行和消息/工具持久化传递；列表和历史查询分别使用自己的 requestId。Backend 通过 Nest `Logger` 输出 JSON 生命周期记录，包含阶段、状态、行数/事件数、耗时及安全错误类型，消息与工具进度按 debug 级别限速记录。日志不包含 prompt、assistant 正文、工具参数/结果、原始异常 message、provider payload 或凭据；日志不改变 API/SSE 契约。详见 [Agent Runtime 日志约定](../../platform/agent-runtime.md#运行日志) 和[变更验收](../../../changes/2026-11-07-agent-flow-logging/verification.md)。

### 已知边界

- 同一对话的串行化只覆盖当前 backend 进程，不适用于多进程并发写入场景。
- 进程崩溃不会恢复同一个 provider 调用；清理和历史对账在该 Conversation 的下一次请求开始时执行。
- 每次请求读取完整历史；长对话可能超过模型上下文窗口。当前没有持久化摘要或裁剪。
- 中断时工具产生的外部副作用无法回滚；恢复会为无结果调用写入错误 toolResult，避免自动重复执行。
- Renderer localStorage 只保存一个活动对话 ID；Agent 页面启动时读取列表并恢复该 ID 的可见消息，用户可通过侧栏加载其他会话。
