---
status: implemented
layer: change
domain: conversations
created_at: 2026-11-07
landed_in: L001
version: 2.0
updates_current:
  - docs/current/index.md
  - docs/current/domains/README.md
  - docs/current/domains/conversations/index.md
  - docs/current/domains/conversations/backend-behavior.md
  - docs/current/domains/conversations/api-contract.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/platform/agent-runtime.md
---

# Conversation History Sidebar Design

## Problem

Conversation and Message rows are durable, but the backend has no read API and the desktop starts with an empty assistant-ui thread. Users cannot browse prior conversations or load a selected conversation's visible messages after restart.

## Goals

- Expose all conversations in recent-update order for the desktop sidebar.
- Expose ordered user and assistant message text for one selected conversation.
- Load the list when the Agent page starts and refresh it when a streamed turn creates or updates a conversation.
- Replace the active assistant-ui thread with the selected conversation history and keep that conversation ID for follow-up prompts.
- Derive a useful list title from the first user message when `ConversationEntity.title` is null, without changing the database.

## Non-Goals

- Conversation rename, delete, archive, search, or pagination.
- Displaying historical tool activity, tool arguments, or tool results as chat bubbles.
- Generating or persisting a new conversation title with an LLM.
- Schema migrations, message editing, or conversation ownership changes.

## Must-Not-Break Existing Behavior

- Existing local-token and Origin checks continue to protect backend requests.
- Agent SSE streaming, cancellation, and per-conversation multi-turn context restoration keep their current contracts.
- Tool results and execution records remain private to SQLite and do not pass through the desktop bridge.
- The existing Course and Health JSON endpoints keep their current request and response shapes.

## Current Behavior

- `ConversationsModule` registers entities and `ConversationsService`, but has no controller or read methods.
- `AgentChatPage` uses the single long-lived assistant-ui `LocalRuntime` created by `App`; it renders only the current in-memory thread.
- `agent-chat-adapter.ts` saves one active conversation ID in localStorage and sends it on later turns, but does not load the old messages into the runtime.
- `window.teachforge.request()` already provides typed JSON requests over the authenticated Electron bridge.
- `ConversationEntity.title` is nullable. User message rows store JSON text blocks; Pi assistant rows store tagged Pi messages with their content/status.

## Proposed Behavior

1. Add `GET /api/conversations` to return an array ordered by `updatedAt DESC`, then `createdAt DESC`. Each item contains `id`, display `title`, `createdAt`, and `updatedAt`. The title uses `ConversationEntity.title` when non-empty, otherwise the first user message's text, shortened for display; an empty conversation uses `新对话`.
2. Add `GET /api/conversations/:conversationId/messages`. It verifies the conversation exists and returns terminal user/assistant rows ordered by `sequenceNo`, with text-only content and the persisted status. Tool execution, toolResult, assistantTurn, pending, and empty assistant rows are excluded from visible history.
3. A shared renderer conversation store loads the list when `AgentChatPage` mounts, exposes loading/error state to the sidebar, and refreshes after a conversation metadata event and after a stream terminates.
4. The sidebar lets the user select an existing conversation or start an empty new thread. Selecting an item requests its messages, converts them to `ThreadMessageLike`, and calls `runtime.thread.reset(messages)`. The new-thread action clears the active ID and calls `runtime.thread.reset([])`.
5. The desktop restores the last selected conversation on startup only when its ID still appears in the loaded list. A history response is applied only if it belongs to the most recent selection request.

## Alternatives Considered

| 方案 | 结论 | 理由 | 是否升级为 ADR |
|---|---|---|---|
| Add read methods directly to AgentController/AgentService | 否决 | Conversation queries belong to the existing Conversations domain; placing them in Agent mixes persistence reads into stream orchestration. | n/a |
| Return full MessageEntity rows to the renderer | 否决 | Exposes internal Pi/tool payloads and couples the UI to storage JSON formats. The API should project visible text and status. | n/a |
| Recreate a new assistant-ui runtime for every selection | 否决 | The existing single runtime can replace its thread through `thread.reset()`, preserving the current provider/composer setup with less lifecycle code. | n/a |
| Use two read endpoints, one for summaries and one for selected history | 采用 | The sidebar needs lightweight summaries at startup; message bodies are loaded only after selection. | n/a |

## Business Flow

On app start, the Agent page loads the conversation summaries. If the saved active ID still exists, it fetches and restores that conversation. Clicking another row loads that conversation's visible messages. New Agent turns continue to use the selected ID; a newly created conversation appears in the sidebar after the stream metadata arrives.

## End-to-End Data Interaction Flow

```mermaid
sequenceDiagram
  participant UI as AgentChatPage / conversation store
  participant Bridge as window.teachforge JSON bridge
  participant Main as Electron Main
  participant API as ConversationsController
  participant Service as ConversationsService
  participant DB as SQLite Conversation / Message
  UI->>Bridge: GET /api/conversations on Agent page mount
  Bridge->>Main: request with local token
  Main->>API: GET /api/conversations
  API->>Service: listConversations()
  Service->>DB: Query ordered summaries and first user text
  DB-->>Service: Conversation rows and title source
  Service-->>UI: Summary array; no message bodies
  UI->>Bridge: GET /api/conversations/:id/messages after selection
  Bridge->>API: Authenticated JSON request
  API->>Service: getConversationMessages(id)
  Service->>DB: Query visible terminal messages by sequenceNo
  DB-->>Service: User / assistant rows
  Service-->>UI: Text-only history DTOs
  UI->>UI: Convert ThreadMessageLike and reset active thread
```

| 关键节点 | 输入 | 节点职责 | 输出 / 状态变化 | 关键边界 |
|---|---|---|---|---|
| AgentChatPage / store | startup, selected ID, stream terminal event | Load summaries, restore the active ID, prevent stale selection responses from replacing a newer selection | Sidebar state and current runtime messages | No raw database payload reaches the renderer |
| `window.teachforge.request()` | Fixed GET path | Use the existing local authenticated JSON bridge | HTTP status and typed response body | Renderer cannot choose a host or token |
| ConversationsController | Route parameter | Validate UUID and delegate to the domain service | Summary/history response or 400/404 | Controller contains no SQL |
| ConversationsService | Conversation ID | Query and project entities to UI DTOs | Ordered summary or visible history | No schema writes, no transaction spanning UI/model work |
| SQLite entities | `conversations`, `messages` | Remain the durable transcript source | Existing persisted rows | Internal tool rows and Pi JSON stay server-side |

## Data And API Impact

- Add `GET /api/conversations` and `GET /api/conversations/:conversationId/messages`.
- Both endpoints are read-only and use the existing local backend authentication boundary.
- No columns, indexes, migrations, or new ownership fields are required.
- List titles are response projections only. They do not update `ConversationEntity.title`.
- The message response contains `id`, `role`, `content`, `status`, and `createdAt`; it excludes internal execution rows and non-text Pi content.

## Frontend Fetching Logic

- `AgentChatPage` calls the renderer conversation store once on mount; the Agent page is mounted with the app shell even when the Course tab is selected.
- The store calls `window.teachforge.request()` and keeps the last successful summary list plus loading/error state. A failed refresh does not clear already displayed summaries.
- If localStorage has an active ID, the page restores history only after the summary response confirms that the ID still exists. A missing ID is cleared and leaves an empty runtime thread.
- Selecting a row requests only that conversation's messages. A monotonically increasing request token discards responses from earlier clicks.
- When the request succeeds, the adapter maps database IDs, roles, timestamps, text, and terminal status to assistant-ui messages; the runtime is reset after the response is fully validated.
- New conversation metadata and stream termination trigger a summary refresh so a newly created conversation and its final update time appear without restarting the app.

## Frontend Behavior

- The Agent area has a scrollable conversation list, a new-conversation action, selected-row state, and loading/error/empty states.
- Existing conversations show their title or first-prompt fallback and update time.
- Selecting a row loads only user/assistant text into the current chat. Tool activity from previous runs is not reconstructed.
- While a stream or history load is active, conversation selection/new-thread actions and the composer are disabled to prevent changing the runtime while an old request is still writing to it.
- Starting a new thread clears local active selection and the current runtime, but creates no Conversation row until the first prompt is submitted.

## Backend Fetching Logic

- `ConversationsService.listConversations()` reads `ConversationEntity` rows ordered by `updatedAt DESC, createdAt DESC` and uses a correlated first-user-message lookup to derive the display title. It does not load every message body for each sidebar row or mutate titles.
- `ConversationsService.getConversationMessages(id)` first verifies the Conversation, then queries `MessageEntity` rows for that ID and roles `user`/`assistant`, ordered by `sequenceNo ASC`. It filters to terminal statuses and projects only text blocks.
- Tagged Pi assistant payloads are decoded by the existing transcript parser; legacy text-block assistant/user rows remain supported. Malformed content is not returned as raw JSON.
- Reads use no cache and no database transaction. The selected history is an unpaginated array as requested; pagination is deferred until measured conversation size requires it.
- Unknown IDs return 404; malformed UUID route values return 400 before service lookup.

## Backend Behavior

- `ConversationsController` is added to the existing `ConversationsModule`; the Agent stream controller and SSE event contract are unchanged.
- List response returns an empty array when no Conversation rows exist.
- Message history includes completed user turns and terminal assistant messages, including recoverable failed/cancelled partial assistant text. It excludes pending rows and internal tool/turn state.
- All messages and all conversation summaries are returned; ordering is stable and explicit.

## Error Handling

- A malformed `conversationId` path parameter returns NestJS 400 validation response.
- A valid UUID that does not exist returns 404; the renderer retains its current thread and shows a load error.
- Backend/bridge failures keep the last successful sidebar list, expose a retry action, and do not clear a successfully loaded runtime history.
- A failed/stale selection response cannot overwrite the latest selected conversation.

## Risks

- Unpaginated summaries and selected history grow with the local database; pagination can be added later if observed size warrants it.
- Display titles are derived from the first user prompt until a separate rename/title policy exists.
- Tool execution status and result rows are intentionally not visible in restored chat history.
- assistant-ui's message status mapping must keep failed/cancelled partial answers readable without presenting internal Pi payloads.

## Verification

- Backend and desktop builds validate the endpoint and renderer runtime contracts.
- Code-level/SQLite verification covers empty list, title fallback, ordering, text projection, hidden internal roles, unknown ID, and terminal statuses.
- Desktop acceptance covers startup list loading, active ID restore, conversation switching, new-thread reset, and refreshing after a streamed turn.
- Per repository instructions, implementation verification must not add or run tests unless requested.

## Design Deviations

| 偏差 | 发现于 | 与设计不符之处 | 处理（改设计 / 改现状文档 / 接受） |
|---|---|---|---|

## Version History

| Version | Trigger | Change | Impact scope | Handling |
|---|---|---|---|---|
| 1.0 | Initial implementation | Added Conversation list/history reads and sidebar restore/selection flow. | Conversations API and desktop Agent page. | Implemented in L001. |
| 2.0 | Developer reported a blank startup screen caused by a missing assistant-ui named export after L001. | No business design change; replace the obsolete state-hook name with the installed package's public hook. | `AgentChatPage` import/runtime state selector only. | Fixed in L002; focused import-export check passes. |

## Current Doc Updates

- [x] `docs/current/index.md` and `docs/current/domains/README.md`
- [x] `docs/current/domains/conversations/index.md`
- [x] `docs/current/domains/conversations/api-contract.md`
- [x] `docs/current/domains/conversations/backend-behavior.md`
- [x] `docs/current/platform/architecture-and-code-placement.md`
- [x] `docs/current/platform/agent-runtime.md`
- [x] `docs/manifest.yaml` and `docs/changes/README.md`
