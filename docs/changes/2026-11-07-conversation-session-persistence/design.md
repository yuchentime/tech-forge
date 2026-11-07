---
status: implemented
layer: change
domain: conversations
created_at: 2026-11-07
landed_in: L001, L002
version: 2.0
updates_current:
  - docs/current/domains/conversations/index.md
  - docs/current/domains/conversations/backend-behavior.md
  - docs/current/platform/architecture-and-code-placement.md
---

# Conversation Session Persistence Design

## Problem

The Agent stream creates every Pi session with SessionManager.inMemory() and sends only the newest prompt to the model. The conversations and messages tables already exist, but no service writes or reads them. Closing the app therefore loses both the visible thread and model context.

The Pi SDK makes SessionManager authoritative for model context. For externally stored history, its documented path is to create the session with a manager populated from entries; assigning session.agent.state.messages does not replace persisted context. This change uses SQLite Conversation/Message rows as the durable source and reconstructs Pi entries for each request.

> Current contract: v2.0 below supersedes conflicting v1.0 behavior descriptions in the baseline sections. Pi event snapshots and tool execution state are persisted incrementally and reconciled on the next request after an interruption.

## Goals

- Persist each Agent user prompt and assistant response in the existing conversations and messages tables.
- Rebuild Pi context from completed messages in sequence order for the next turn in the same conversation.
- Keep one active conversation ID in the current desktop Agent thread and preserve it across app restarts.
- Record interrupted responses as failed or cancelled with any text already received.
- Keep SQLite transactions away from model and filesystem side effects.

## Non-Goals

- Conversation listing, switching, renaming, deletion, or multiple-thread UI.
- Rehydrating old message bubbles into the visible Assistant UI after restart; the stored context is available to future prompts.
- Pi JSONL file persistence. SQLite remains the transcript source of truth.
- Schema migrations; the existing entity fields and indexes are sufficient.

## Must-Not-Break Existing Behavior

- Agent streaming still emits the existing Pi lifecycle, safe tool, and text-delta events.
- Cancellation still aborts the active Pi session and closes the HTTP stream.
- The local token and Origin checks remain in Electron Main and backend bootstrap.
- Health and Course JSON endpoints keep their existing request and response contracts.
- User and assistant message content continues to be the only conversation transcript stored; tool results are not exposed as chat messages.

## Current Behavior

- POST /api/agent/stream accepts AgentPromptDto.prompt only.
- AgentService.stream() delegates the latest prompt to LlmService.stream().
- LlmService.createSession() configures a Pi SDK session with SessionManager.inMemory() and disposes it after each request.
- ConversationsService is an empty provider. ConversationEntity and MessageEntity are registered with TypeORM and created by the personal-learning schema migration.
- The desktop adapter sends only the latest user message; its Agent thread and the event bus live in renderer memory.

## Proposed Behavior

1. AgentPromptDto accepts an optional UUID conversationId. If absent, AgentService creates a ConversationEntity with an application-generated UUID. If present, the ID must resolve to an existing conversation.
2. AgentService emits a small conversation metadata event before Pi events. The desktop adapter stores that ID in localStorage and includes it on later requests. The event contains no transcript or provider data.
3. ConversationsService reads completed messages ordered by sequenceNo and, in a short database transaction, appends the current completed user message and a pending assistant message. The transaction ends before any model call.
4. LlmService converts the prior user/assistant rows into Pi SessionMessageEntry values and creates the SDK session with SessionManager.inMemory(cwd, { id: conversationId }, entries). It does not assign agent.state.messages.
5. AgentService forwards the existing projected Pi events while accumulating text deltas. On natural completion it stores the assistant text with status completed; on model failure or cancellation it stores received partial text with status failed or cancelled.
6. Requests for the same conversation are serialized within the backend process so history reads and sequence allocation cannot race. Other conversations remain independent.
7. On app restart the visible LocalRuntime begins empty, but the desktop adapter reuses its stored conversationId; the backend restores prior completed context from SQLite for the next prompt.

## Alternatives Considered

| 方案 | 结论 | 理由 | 是否升级为 ADR |
|---|---|---|---|
| Use Pi's default file-backed SessionManager | 否决 | It would create a second transcript store outside the application SQLite database and require file-to-row consistency. | n/a |
| Rebuild history by prefixing text to each prompt | 否决 | It bypasses Pi's SessionManager context model and risks prompt formatting ambiguity. | n/a |
| Assign session.agent.state.messages after construction | 否决 | Pi documents SessionManager as authoritative; direct state assignment does not replace future request history. | n/a |
| Restore external history with SessionManager.inMemory entries and persist rows in SQLite | 采用 | Uses the SDK's supported external-history route and the existing application entities as the durable source. | n/a |

## Business Flow

1. The user sends a prompt from the current Agent thread.
2. The adapter supplies its stored conversationId, or omits it on the first turn.
3. The backend resolves or creates the conversation, saves the user message, and creates a pending assistant message.
4. The backend restores completed conversation messages into a Pi session and streams the response.
5. The backend stores the final or partial assistant response. The desktop keeps the same conversationId for later prompts and app restarts.

## End-to-End Data Interaction Flow

~~~mermaid
sequenceDiagram
  participant U as User
  participant R as React LocalRuntime / adapter
  participant P as Preload and Electron Main
  participant C as AgentController
  participant A as AgentService
  participant V as ConversationsService
  participant DB as SQLite Conversation and Message rows
  participant L as LlmService / Pi SessionManager
  participant X as Model provider
  U->>R: Submit prompt with stored conversationId
  R->>P: Start typed Agent stream
  P->>C: POST /api/agent/stream + local token
  C->>A: Validated prompt and optional ID
  A->>V: Resolve conversation and read prior messages
  V->>DB: Read ordered rows; create user and pending assistant rows
  A-->>R: conversation metadata event
  A->>L: Stream prompt with persisted history
  L->>L: SessionManager.inMemory(cwd, id, entries)
  L->>X: Model request with restored context
  X-->>L: Pi session events
  L-->>A: Ordered Pi events
  A->>V: Save completed, failed, or cancelled assistant content
  V->>DB: Update assistant row and conversation timestamp
  A-->>P: Existing safe Pi events and terminal event
  P-->>R: Typed bridge events
  R->>R: Keep conversationId in localStorage
~~~

| 关键节点 | 输入 | 节点职责 | 输出 / 状态变化 | 关键边界 |
|---|---|---|---|---|
| Agent adapter | Prompt and optional localStorage ID | Sends the active thread ID and saves the initial ID event | Reuses one conversation across app restarts | Renderer receives no local token |
| AgentController | Validated AgentPromptDto | Converts request to SSE and aborts on disconnect | Stream frames | Existing local authentication remains unchanged |
| AgentService | Prompt, ID, abort signal | Coordinates turn persistence, Pi streaming, and per-conversation serialization | Assistant status and safe Pi events | No database transaction spans model I/O |
| ConversationsService | Conversation ID and transcript rows | Reads completed history and writes ordered messages | SQLite transcript | Unique sequence index plus serialized writes |
| LlmService | Prior user/assistant rows | Converts rows into SDK SessionMessageEntry values | Pi context from SessionManager | SDK manager is authoritative for context |

## Data And API Impact

- POST /api/agent/stream request adds optional conversationId; omitting it starts a new conversation.
- SSE adds a conversation event containing only conversationId.
- User messages use role user and status completed. Assistant rows begin pending and end completed, failed, or cancelled. contentJson stores JSON text blocks.
- No entity or migration changes are planned. Existing unique (conversationId, sequenceNo) index remains the ordering guard.
- The current desktop UI keeps one active conversation. It does not yet expose conversation selection or render the prior transcript after restart.

## Frontend Fetching Logic

- The adapter reads one active conversationId from localStorage and passes it through the typed stream bridge.
- A first turn omits the ID; the conversation event stores the generated ID before later prompts.
- There is no separate message-history fetch in this change. The backend reads prior messages for model context; visible message restoration is deferred with multi-conversation UI.
- A failed request before the metadata event leaves no ID in the renderer, so a later prompt can start a separate conversation without corrupting the prior one.

## Frontend Behavior

- The current Assistant UI thread continues to work as before during one app run.
- After restart, the UI begins with an empty rendered thread but the next model request uses prior completed messages from the same stored conversation.
- Existing tool activity remains scoped to the current run and is not written as MessageEntity rows.

## Backend Fetching Logic

- ConversationsService loads MessageEntity rows for one conversation ordered by sequenceNo and filters model history to completed user/assistant rows.
- The turn-start transaction creates the ConversationEntity if needed, allocates the next two sequence numbers, and inserts the user and pending assistant rows.
- The transaction closes before LlmService starts. Final status and content are written in a separate short update after stream completion, failure, or cancellation.
- LlmService maps the ordered rows to a linear Pi entry chain using their message IDs and timestamps. It includes only persisted chat roles, not tool result payloads.
- No in-memory transcript cache is needed; every turn reads SQLite, so restart behavior follows the same path as an in-process turn.

## Backend Behavior

- A valid existing conversationId continues that conversation. An unknown ID emits a safe SSE error and does not silently create a different conversation.
- A missing conversationId creates a new conversation with a UUID generated by the backend.
- A per-conversation lock covers history read, turn row creation, and the model stream; the lock is released on every terminal path.
- The assistant row is retained with partial content when the run fails or is cancelled. Only completed rows are fed into later model context.
- Database errors before the model starts prevent provider calls. A failure to finalize persistence is surfaced as a stream error.

## Error Handling

- Invalid conversationId format is rejected by DTO validation.
- Unknown conversationId does not create or modify any rows.
- Missing provider configuration follows existing safe SSE error handling and marks the assistant row failed.
- Disconnect or Stop aborts Pi and marks the assistant row cancelled with any collected text delta.
- SQLite write errors are not hidden as successful completion.

## Risks

- The current desktop UI does not render persisted messages after restart; only the next model request restores them.
- Full history is loaded for every turn. Very long conversations may exceed model context or require repeated compaction; durable compaction is deferred.
- A process crash can leave an assistant row pending. Startup reconciliation of abandoned pending rows is deferred.
- The lock is process-local. This matches the single backend process launched by the desktop app; a future multi-process backend would need database-level serialization.

## Verification

- Build backend and desktop to catch the changed request/event contract.
- Exercise first-turn creation, second-turn restoration, restart restoration, stream failure, cancellation, unknown IDs, and concurrent requests against a temporary SQLite database.
- Confirm the Agent event whitelist still excludes full Pi messages and tool results.
- Confirm no session files are created by Pi for this flow.

## Design Deviations

| 偏差 | 发现于 | 与设计不符之处 | 处理（改设计 / 改现状文档 / 接受） |
|---|---|---|---|

## v1.0 Version History

The design sections above record the v1.0 baseline, which stored only user and assistant text. The v2.0 amendment below records the later durability requirement and is authoritative where behavior differs.

## Current Doc Updates

- [x] docs/current/domains/conversations/index.md
- [x] docs/current/domains/conversations/backend-behavior.md
- [x] docs/current/platform/architecture-and-code-placement.md
- [x] docs/manifest.yaml

## v2.0 Durability Amendment

### Trigger

Developer feedback requires tool calls, tool results, assistant output, and user input to be persisted as they occur so the next request can recover after an interrupted run.

### Updated persistence contract

- The user row and pending `assistantTurn` marker are committed before starting Pi, as in v1.0.
- Each Pi assistant or `toolResult` message gets its own ordered `MessageEntity` row with a tagged native-message payload in `contentJson`.
- `message_start`, every `message_update`, and `message_end` update that Pi message row; tool execution start/update/end state, partial output, and the final `tool_execution_end` result are stored in a separate `toolExecution` row. An awaited Pi extension hook commits each write before the SDK proceeds to the next event or starts the corresponding tool. AgentService projects and forwards the event only after the hook completes.
- Finalized assistant messages, tool calls, and tool results retain their Pi message structure. The current user prompt remains the separate user row; turn markers and tool execution metadata are not sent to the model.
- Existing v1.0 text-block rows remain readable. No columns or migration are added.
- The `assistantTurn` marker remains `pending` during the run, then becomes `completed`, `failed`, or `cancelled`. Pi message rows keep their own streaming/completion state.

### Recovery contract

- On the next request, `ConversationsService.beginTurn()` finds leftover pending Pi message rows and running tool execution rows, marks them interrupted, and reconciles history before returning it.
- `LlmService` restores prior user rows and persisted Pi assistant/toolResult rows in sequence order, including recoverable partial assistant output. Legacy plain-text assistant rows are converted as before. Turn markers and tool execution metadata are excluded from model history.
- If a finalized tool call has no persisted toolResult message, recovery rebuilds it from the durable `tool_execution_end` result when available; otherwise it inserts an error `toolResult` row with any partial output. The next model request will not replay a potentially side-effecting operation.
- An incomplete assistant tool-call block that never reached `message_end` is discarded during recovery; text already received from that message remains available.
- Recovery continues from durable conversation history on the next request; it does not resume the original provider process or claim an unfinished tool's external side effect was rolled back.
- The v1.0 statement that tool results are not stored is superseded: tool call/result messages are stored locally in SQLite, but remain excluded from the renderer event bridge and visible chat bubbles.

### v2.0 Version History

### v2.0 — 2026-11-07

- 触发：开发者要求每轮即时持久化用户/助手消息、工具调用和工具结果，以支持中断后恢复。
- 改动内容：复用 `MessageEntity` 分行保存 Pi assistant/toolResult 消息及 toolExecution 状态和最终结果；按 Pi message/tool events 逐事件写入；新请求恢复历史并重建缺失的 toolResult。影响 AC-02、AC-03、AC-04，并新增 AC-06、AC-07。
- 影响范围：消息持久化、后端读取/恢复流程、失败与取消边界；不新增表或 migration。
- 处理状态：已实施（L002）。
