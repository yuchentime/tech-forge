---
status: implemented
layer: change
domain: conversations
canonical_for:
  - conversation-session-persistence-verification
last_verified: 2026-11-07
version: 2.0
acceptance_review_status: approved
---

# Conversation Session Persistence Verification

## Test Layer Taxonomy

- **L1 — Local Logic Verification**: backend and desktop production builds plus code-level state/contract checks.
- **L2 — Automated Real-World Verification**: temporary SQLite integration checks across AgentController, AgentService, ConversationsService, and LlmService.
- **L3 — Human-Aided Verification**: desktop restart check to confirm the active conversation ID survives and the next prompt continues stored context.

## Acceptance Criteria（代码级验收规则）

### AC-01 Optional conversation identity

| 要素 | 内容 |
| --- | --- |
| 代码位置 | apps/backend/src/agent/dto/agent-prompt.dto.ts AgentPromptDto; AgentController.stream(); AgentService.stream(); AgentStreamEvent |
| 前置条件 | POST /api/agent/stream receives a valid prompt with no conversationId or an existing UUID |
| 预期行为 | Missing ID creates one conversation and emits one conversation metadata event; existing ID continues that record; the desktop persists the ID and sends it on later turns |
| 禁止出现 | One request's conversation ID or transcript crossing into a different requested conversation |
| 判定方式 | DTO/SSE/bridge code inspection and request-flow check |

### AC-02 Ordered transcript persistence

| 要素 | 内容 |
| --- | --- |
| 代码位置 | ConversationEntity.id; MessageEntity.conversationId, sequenceNo, role, contentJson, status; ConversationsService |
| 前置条件 | A valid Agent prompt begins and a user/assistant turn is created |
| 预期行为 | User content and a pending assistantTurn marker are stored before provider I/O; each native Pi assistant message has its own ordered row and progresses from pending to completed, failed, or cancelled; sequenceNo is unique and increasing |
| 禁止出现 | Provider I/O before initial rows are saved, or any assistant message snapshot missing from SQLite |
| 判定方式 | Temporary SQLite query after success, provider failure, and cancellation |

### AC-03 SDK context restoration

| 要素 | 内容 |
| --- | --- |
| 代码位置 | ConversationsService.beginTurn(); LlmService.stream(), LlmService.createSession(), SessionManager.inMemory() |
| 前置条件 | A conversation contains persisted user, Pi assistant, and optional toolResult rows from a prior turn |
| 预期行为 | Rows are reconciled and ordered by sequenceNo, mapped to Pi session message entries, and supplied to SessionManager.inMemory(cwd, { id }, entries) before session.prompt(); recoverable partial assistant text is retained |
| 禁止出现 | Restoring context by assigning session.agent.state.messages, or including another conversation's rows and runtime-only turn/toolExecution markers |
| 判定方式 | SDK session manager input inspection and second-turn provider context check |

### AC-04 Terminal-state persistence and cancellation

| 要素 | 内容 |
| --- | --- |
| 代码位置 | AgentService.stream(), ConversationsService.finishTurn(), MessageEntity.status |
| 前置条件 | Model run completes, throws, or the SSE client disconnects |
| 预期行为 | assistantTurn marker ends in completed, failed, or cancelled; in-flight Pi/tool rows receive terminal or interrupted status; same-conversation lock is released |
| 禁止出现 | Pending runtime rows after a handled terminal path, or a cancelled run emitting success |
| 判定方式 | SQLite state inspection after success, provider failure, and aborted request |

### AC-05 Conversation isolation and sequence safety

| 要素 | 内容 |
| --- | --- |
| 代码位置 | AgentService.stream(); ConversationsService; MessageEntity IDX_messages_conversation_sequence |
| 前置条件 | Two requests target the same conversation, or requests target different conversations |
| 预期行为 | Same-conversation requests execute in order with distinct sequenceNo values; separate conversations do not share history |
| 禁止出现 | Duplicate sequenceNo, mixed transcript context, or a lock left held after error/cancellation |
| 判定方式 | Concurrent temporary SQLite stream exercise |

### AC-06 Incremental Pi transcript persistence

| 要素 | 内容 |
| --- | --- |
| 代码位置 | LlmService.createConversationPersistenceExtension(); AgentService.persistPiEvent(); ConversationsService; MessageEntity.contentJson/status; Pi AgentSessionEvent |
| 前置条件 | An Agent request receives Pi message and tool execution events |
| 预期行为 | User input and an assistantTurn marker are committed before model I/O; awaited Pi extension hooks commit each assistant/toolResult message start/update/end snapshot and tool execution start/update/end state (including the final result) before Pi proceeds; projected events are forwarded only afterward |
| 禁止出现 | A transcript event exists only in process memory after its projected event has been sent to the client |
| 判定方式 | Controlled SQLite stream exercise that inspects persisted content after each event boundary |

### AC-07 Interrupted-turn restoration

| 要素 | 内容 |
| --- | --- |
| 代码位置 | ConversationsService.beginTurn(); LlmService.createSessionEntries(); SessionManager.inMemory() |
| 前置条件 | A previous request left a pending/failed/cancelled assistant row, a partial assistant snapshot, or a finalized tool call without a tool result |
| 预期行为 | The next request reconciles stale pending Pi message/toolExecution rows, restores persisted Pi messages in order, preserves recoverable assistant text and completed tool results, and rebuilds any missing toolResult from its durable final result or an error record |
| 禁止出现 | Replaying an orphaned side-effecting tool call, dropping already persisted tool results, or mixing messages from another conversation |
| 判定方式 | Temporary SQLite interruption/restart exercise followed by inspection of the restored SessionManager entries and tool invocation count |

## Required Automated Checks

~~~bash
npm run build --workspace @teachforge/backend
npm run build --workspace @teachforge/desktop
~~~

- [L1] Backend and desktop builds confirm the changed request/event contract compiles across NestJS and Electron.
- [L2] Temporary SQLite stream exercise covers persistence and restart restoration; no live provider credentials are required when the model stream is stubbed.

Execution status for L001: these checks were not run. The implementation task instructions prohibit adding or running tests/build verification; therefore AC runtime behavior remains unverified.

The v2.0 checks below extend L1/L2 coverage for durable event writes and interruption recovery; they have not been run in L002.

## Required Manual Checks

- [L3] Restart the desktop app after one completed turn, send a follow-up, and confirm the backend uses the prior conversation context.
  - 原因：This confirms the desktop's localStorage ID survives the actual Electron lifecycle.
  - 执行人：Developer.
  - 判断标准：The follow-up request carries the same conversationId and the database retains both turns.

Execution status for L001: the desktop restart check was not run; persistence across an actual Electron restart remains unverified.

## Must-Not-Break Checks

- [ ] Existing text deltas and safe tool activity remain visible during a normal Agent run.
- [ ] Stop and window disconnect still abort the active model request.
- [ ] Health and Course prototype requests remain available through their existing JSON bridge.
- [ ] The local authentication token remains private to Electron Main.

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| First prompt without an ID | New conversation ID is persisted and returned before model events | L2 | Temporary SQLite stream | Establishes durable identity |
| Follow-up prompt after restart | Prior completed chat entries appear in Pi SessionManager context | L2/L3 | Stubbed provider plus Electron restart | Proves context survives process replacement |
| Provider failure | Assistant row is failed with partial text if any | L2 | Stubbed stream rejection | Prevents false completed transcript state |
| Client disconnect | Assistant row is cancelled and lock is released | L2 | Abort SSE request | Preserves cancellation semantics |
| Parallel prompts in one conversation | Ordered, unique sequence numbers | L2 | Concurrent requests | Prevents history corruption |
| Different conversation IDs | Context and rows remain isolated | L2 | Two temporary conversations | Prevents cross-thread data leakage |
| Crash after assistant delta | Latest assistant snapshot remains in SQLite and is available to the next request | L2 | Stop backend between message_update and message_end | Protects generated work from process loss |
| Crash after tool call / during tool execution | Tool call is restored with a synthetic interruption result and is not invoked again | L2 | Stop backend after tool_execution_start | Avoids duplicate side effects |
| Completed tool result | Full Pi toolResult message is present in the transcript and restored in order | L2 | SQLite content inspection plus stubbed provider | Preserves tool output needed for later turns |

## Known Guardrails

- L1 build success does not establish SQLite/runtime behavior.
- L2 checks must use a temporary database and clean it up.
- Do not expose raw Pi tool results or full message payloads through the desktop bridge.
- Do not keep a database transaction open while awaiting the model provider.

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
| --- | --- | --- |
| Mutating session.agent.state.messages | Pi does not treat it as authoritative persisted context | Restore through SessionManager entries |
| Storing only text deltas in renderer memory | Restart loses model context | Persist messages in SQLite |
| Holding a SQLite transaction through a model request | A slow provider blocks unrelated local database work | Use short turn-start and finalization writes |

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | AgentPromptDto、AgentController.stream()、AgentService.stream() 和后端/桌面 AgentStreamEvent 均已存在；可在现有请求与事件类型上增加会话 ID。 |
| AC-02 | pass | ConversationEntity、MessageEntity 和 ConversationsService 已存在；sequenceNo、role、contentJson、status 及唯一序号索引均可直接复用。 |
| AC-03 | pass | LlmService.stream()/createSession() 已存在；安装版本导出的 SessionManager.inMemory(cwd, options, entries) 接受 FileEntry[]，与 Pi 官方 SDK 恢复外部历史的说明一致。 |
| AC-04 | pass | AgentService.stream()、AgentController.stream()、请求取消信号和 MessageEntity.status 均已存在；终态回写可在现有流生命周期中实现。 |
| AC-05 | revised | 将代码位置从未实现的“AgentService conversation lock”改为现有 AgentService.stream()、ConversationsService 和 IDX_messages_conversation_sequence；锁是本变更内的行为目标，不作为现有代码锚点。 |
| AC-06 | revised | 初稿采用嵌套 transcript；按现有 MessageEntity 的 sequenceNo/role/contentJson 改为每条 Pi message 与 toolExecution 使用独立有序行，更便于 SQL 检查与恢复。 |
| AC-07 | revised | 初稿把合成 toolResult 放入 transcript envelope；修订为插入独立 `role=toolResult` 行，并在下一请求前完成 orphan call 对账。 |

- 评审结论：AC-05 已修订并重新核验；全部 AC 可判定，可进入编码。
- 评审方 / 确认人 / 时间：Codex（实现方自审）/ 2026-11-07

v2.0 Acceptance Criteria Review:

- 评审结论：AC-06、AC-07 已对照当前代码与安装的 Pi SDK 事件/API 核验；全部 AC 可判定，可进入 L002 实施。
- 评审方 / 确认人 / 时间：Codex（实现方自审）/ 2026-11-07

v2.0 AC revision review:

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
|---|---|---|
| AC-06 | pass | 采用独立 MessageEntity 行；sequenceNo、role、contentJson、status 均为现有字段，Pi message/tool event discriminants 在安装 SDK 类型中存在。 |
| AC-07 | pass | 使用既有排序字段恢复 Pi message 行；合成 toolResult 也是标准 Pi message 行，避免重复执行没有结果记录的工具调用。 |

- 评审结论：AC-06/07 修订后重新核验通过；全部 AC 可判定，允许继续 L002。
- 评审方 / 确认人 / 时间：Codex（实现方自审）/ 2026-11-07

## Version History

v1.0 covers initial SQLite transcript persistence and multi-turn Pi context restoration. v2.0 was triggered by developer feedback requiring durable in-flight Pi transcript and tool recovery; see the v2.0 criteria and review above.
