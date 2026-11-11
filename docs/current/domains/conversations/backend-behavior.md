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
last_verified: 2026-11-10
---

# Conversation 后端行为

## 写入流程

`ChatController` 校验请求并将 `conversationId` 交给 `ChatService`。`ChatService` 通过 Conversations 模块导出的单例 `ConversationRunRegistry` 在进程内按 ID 排队，然后调用 `ConversationsService.beginTurn()`：确认或创建 Conversation、对账遗留行、读取已有消息、按 `sequenceNo` 取最大值并加一，接着写入本轮 user 消息和 pending `assistantTurn` 标记。新 ID 由 backend 生成 UUIDv4。

事务结束后，`ChatService` 才调用 `LlmService.stream()`。`LlmService` 注册请求级 Pi 扩展钩子：每个 assistant/toolResult 的 `message_start/update/end` 以及工具执行 `start/update/end` 都先写入 `MessageEntity`，其中 `tool_execution_end` 的最终结果也先落库；SQLite 提交后 Pi 才继续后续事件处理或启动工具。`ChatService` 在已持久化的事件到达后再投影和转发安全字段。用户行在模型调用前已写入。

流结束、失败或取消时，`finishTurn()` 在短事务内更新 `assistantTurn` 和仍处于 pending 的消息/工具行；助手快照保留已经生成的原生内容。`Conversation.updatedAt` 随每轮开始和结束更新。SQLite 写入失败会中止 Pi 请求并作为流错误处理。

## Pi 上下文恢复

每轮开始时，`ConversationsService` 按 `sequenceNo` 检查上一轮遗留状态。未完成 assistant 快照转为失败或取消状态，并从不完整快照删除尚未完成的 toolCall block，保留已持久化文本。运行中的工具行标记为 interrupted。若已结束的 assistant 消息包含没有对应 `toolResult` 的调用，服务优先用 `tool_execution_end` 行里的最终结果重建 toolResult；若没有最终结果则补一条合成错误结果，避免恢复时 Pi 重放该工具。

Pi 的 `getEntries()` 是模型侧会话状态（含 compaction、model/thinking 变更和 Pi 专属上下文消息），与 UI 展示的完整 SQLite 历史不是同一集合。`LlmService` 先读取 `pi_session_snapshots`：命中且其最后一条持久化消息与 SQLite 最新历史一致时，直接把快照传给 `SessionManager.inMemory(cwd, { id }, entries)`，由 Pi 按 compaction 规则构造模型上下文；没有快照，或快照落后（上一轮崩溃、快照未写成）时，才按 `sequenceNo` 用 SQLite 行重建。旧版本纯文本 assistant 行仍以当前 Pi model 元信息和零 usage 计数重建。assistant/toolResult 原生 payload 与用户输入一起传给大模型；assistantTurn 标记和 toolExecution 状态行不进入模型上下文。Pi SDK 仍由 `SessionManager` 负责构造下一次请求历史，SQLite 是 UI 历史与回退来源，快照是模型上下文的持久副本。

每轮 `stream()` 结束且没有持久化失败时，`LlmService` 将该 session 的 `getEntries()` 结果 upsert 到 `pi_session_snapshots`；保存失败只记录 `llm.session_snapshot.save.failed`，不改变已完成的流结果。

恢复出的条目（快照或 SQLite 重建）在交给 Pi 之前都会先经 `checkSessionEntries()` 核对 `toolCall`/`toolResult` 配对：没有对应调用的结果被丢弃，没有结果的调用从 assistant 消息里剥掉（保留文本），并重接 `parentId` 保持单链，修复结果立即写回快照（日志 `llm.session_snapshot.repaired`）。因为 OpenAI 兼容端点会拒绝孤立的 `tool` 消息，这类条目一旦进入快照，此后每轮请求都会以同一个 400 失败。已用真实损坏快照验证：24 条恢复条目核对后为 23 条，配对问题为 0，叶子路径覆盖全部条目。

## API 与错误

| 边界 | 当前契约 |
|---|---|
| 请求 | `POST /api/chat/stream`：`prompt` 必填，`conversationId` 可选 UUIDv4 |
| 首个 SSE 元数据 | `conversation`：仅包含 backend 确认的 `conversationId` |
| 请求 ID 未找到 | 后端不隐式创建新对话；流发送通用 Agent error SSE 事件，请求不写入消息行 |
| provider / 存储错误 | 通过安全错误 SSE 处理；provider 失败会结束 assistantTurn 为 failed；Pi 事件写入失败会触发 Pi abort 并作为流错误暴露 |
| 输出上限截断 | 最后一条 assistant 的 `stopReason=length` 时，消息行按 failed 落库、assistantTurn 结束为 failed，SSE 错误明确提示“回答被截断”；reasoning token 与正文共用输出预算，不能把只有 thinking 的 completions 当作 provider 未返回文本 |
| Pi 内部取消 | 没有客户端断开信号、但最后一条 assistant 为 `aborted` 时，消息行与 assistantTurn 都结束为 cancelled；`getLastAssistantText()` 的空文本不再触发错误 |
| 客户端断开 | 取消 Pi 请求并将 assistantTurn 设为 cancelled；中断工具行保留为 interrupted/failed 状态 |

Conversation 查询接口由 `ConversationsController` 暴露，并经现有本地 token 与 loopback HTTP 边界访问：

- `POST /api/conversations` 创建无消息的 UUIDv4 Conversation 并返回 `{ conversationId }`。该接口仅为首次发送前的线程初始化服务；创建不写消息、不会把空会话误作已有一轮对话。
- `GET /api/conversations` 按 `updatedAt DESC, createdAt DESC` 返回摘要。标题优先使用非空 `Conversation.title`，否则使用首条 user 消息的文本（折叠空白并限制为 80 个字符），没有文本时为 `新对话`。该读取不回写标题。
- `GET /api/conversations/:conversationId/messages` 接受 UUIDv4；Conversation 不存在时返回 404。默认读取最近最多 30 条有可见文本的 `user`/`assistant` 终态消息，按 `sequenceNo ASC` 返回 `{ messages, hasMore }`。最多向后端查询 31 条可见消息以准确计算 `hasMore`，响应仍最多 30 条。
- 可选 `beforeMessageId` 必须是目标会话中的现存 Message ID。服务定位该行的 `sequenceNo`，严格读取它之前最近一页；非法 UUID 或跨会话/不存在的游标返回 400。页间使用稳定消息 ID，不使用可能漂移的 offset。
- 候选行按 `sequenceNo DESC` 分批读取并在后端投影为可见文本，直到获得 31 条或耗尽候选，再将最多 30 条反转为升序。查询仍只读本地 SQLite，不更改模型侧的全量历史读取。
- 删除和 chat run 使用同一个 `ConversationRunRegistry`：chat 在等待前同步登记运行/排队项；delete 在任何数据库 await 前以同步 `tryAcquireDeletion` 占位。已有 run、排队项或删除占位时 delete 返回 409；delete 先占位时，后到 run 等占位释放后发现会话不存在并沿 stream 的安全错误路径结束。所有分支 finally 释放占位。
- 删除会话是一个事务：按 `conversation_knowledge_facts` → `rehearsal_turns` → `rehearsals` → `artifacts` → `conversation_documents` → `messages` → `pi_session_snapshots` → `conversations` 顺序清除（外键全部 `NO ACTION`），不存在时返回 404。事实生成 worker 只做条件更新，行被删除后迟到成功/失败影响 0 行并退出，不会重建派生事实。事务提交后才删除 `~/.tech-forge/sessions/<conversationId>/`；删除失败记录 `conversations.delete.session_cleanup_failed` 并返回 `partial`，不回滚数据库。删除占位覆盖目录清理，避免新 run 与旧目录清理重叠。
- 消息查询的顶层内容仅输出 user/assistant 文本；每个 user 行另附其 sequence 区间内已终态 `toolExecution` 的安全摘要，以及 `contextRefsJson.attachments` 投影出的 `{attachmentId, name}`（字数与会话文件路径不下发）。工具名、状态、耗时、可选 display path 及 `grep` 的可选搜索词可见；完整参数、partial/final result、`toolResult`、`assistantTurn`、pending 行、thinking 和原始 `contentJson` 不进入 API 响应。无可显示文本的 assistant 行会被省略。
- 每轮普通对话在 `beginTurn()` 后调用 `RehearsalsService.buildConversationDigest()`，只取尚未投递（`rehearsals.loadedContext = 0`）的最近 3 次 completed 演练摘要；摘要经 `LlmRequestOptions.contextMessage` 由 `LlmService` 作为独立 custom message entry 追加进 Pi session（`display: false`），随即 `markDigestDelivered()` 置位。`contextRefsJson.rehearsals` 通过 `mergeUserMessageContextRefs()` 合并写入 `{rehearsalIds, characters}`。digest 不进入 `messages`、SSE 或历史接口；它不被 `replaceInjectedUserText()` 清除，后续轮次从快照恢复即已携带。
- 工具执行摘要按已返回 user 行的序列区间分组，并限制在最后一个已返回 user 与其后的下一个 user 之间；工具行不计入 30 条可见消息，也不改变 `hasMore` 或游标。
- 新的工具执行记录只持久化字符串 `args.path` 作为可选 `displayPath`，以及 `grep` 的字符串 `args.pattern` 作为可选 `displayPattern`；其他参数即使存在也不落库。旧记录没有这两个字段时仍返回工具名、终态和耗时。无法解析的工具行会被跳过并记录安全诊断，不影响文本历史。
- 会话列表仍完整返回；消息历史固定分页。空列表返回 `[]`，无可见历史时返回 `messages: []` 且 `hasMore: false`。

## 诊断日志

Agent 请求由 `ChatController` 生成 `requestId`，沿轮次编排、Pi/LLM 执行和消息/工具持久化传递；列表和历史查询分别使用自己的 requestId。Backend 通过 Nest `Logger` 输出 JSON 生命周期记录，包含阶段、状态、行数/事件数、耗时及安全错误类型，消息与工具进度按 debug 级别限速记录。日志不包含 prompt、assistant 正文、工具参数/结果、原始异常 message、provider payload 或凭据；日志不改变 API/SSE 契约。详见 [Agent Runtime 日志约定](../../platform/agent-runtime.md#运行日志) 和[变更验收](../../../changes/2026-11-07-agent-flow-logging/verification.md)。

### 已知边界

- 同一对话的串行化只覆盖当前 backend 进程，不适用于多进程并发写入场景。
- 进程崩溃不会恢复同一个 provider 调用；清理和历史对账在该 Conversation 的下一次请求开始时执行。
- Agent 每次新请求仍从 SQLite 读取完整可恢复历史，不因 Renderer 的 30 条页面而截断；长对话仍可能超过模型上下文窗口。当前没有持久化摘要或裁剪。
- 中断时工具产生的外部副作用无法回滚；恢复会为无结果调用写入错误 toolResult，避免自动重复执行。
- Renderer localStorage 只保存一个活动对话 ID；Agent 页面启动时读取列表并恢复该 ID 的可见消息，用户可通过侧栏加载其他会话。
