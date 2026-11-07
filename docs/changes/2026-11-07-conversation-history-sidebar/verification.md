---
status: implemented
layer: change
domain: conversations
canonical_for:
  - conversation-history-sidebar-verification
last_verified: 2026-11-07
version: 2.0
acceptance_review_status: approved
---

# Conversation History Sidebar Verification

## Test Layer Taxonomy

- **L1 — Local Logic Verification**: build and code-level projection checks for route, DTO, title, content, and runtime mapping.
- **L2 — Automated Real-World Verification**: API-to-SQLite and renderer bridge behavior against the local backend.
- **L3 — Human-Aided Verification**: Electron visual/interaction check when a real desktop restart or layout observation is required.

## Acceptance Criteria（代码级验收规则）

### AC-01 Conversation list API

| 要素 | 内容 |
| --- | --- |
| 代码位置 | New `GET /api/conversations` handler in the existing `ConversationsModule`/`ConversationsService`; `ConversationEntity`; `MessageEntity` |
| 前置条件 | SQLite contains zero or more Conversation rows and associated Message rows |
| 预期行为 | Returns an array ordered by `updatedAt DESC`, then `createdAt DESC`; each record has `id`, display `title`, `createdAt`, and `updatedAt`; empty storage returns `[]`; null title falls back to first user text or `新对话` |
| 禁止出现 | Returning MessageEntity content or Pi/tool payloads in list records, or changing the stored title during a read |
| 判定方式 | Controller/service code inspection and SQLite-backed response inspection |

### AC-02 Selected conversation history API

| 要素 | 内容 |
| --- | --- |
| 代码位置 | New `GET /api/conversations/:conversationId/messages` handler in the existing `ConversationsModule`/`ConversationsService`; `MessageEntity.sequenceNo`, `role`, `contentJson`, `status` |
| 前置条件 | Request supplies an existing UUIDv4 conversation ID |
| 预期行为 | Returns user/assistant text messages only, ascending by `sequenceNo`, with stable message ID, role, content, status, and timestamp; completed, failed, and cancelled assistant text is retained |
| 禁止出现 | Returning `toolExecution`, `toolResult`, `assistantTurn`, pending rows, thinking blocks, tool arguments, or raw `contentJson` |
| 判定方式 | SQLite-backed API response inspection for new native Pi rows and legacy text-block rows |

### AC-03 Conversation existence and path validation

| 要素 | 内容 |
| --- | --- |
| 代码位置 | New conversation-history route in the existing `ConversationsModule`; Nest `ParseUUIDPipe`; `ConversationEntity.id` |
| 前置条件 | Request supplies a malformed UUID or a valid UUID not found in `ConversationEntity` |
| 预期行为 | Malformed IDs return 400; unknown valid IDs return 404; no rows are created or changed |
| 禁止出现 | Treating an unknown read ID as a new conversation or returning another conversation's rows |
| 判定方式 | Route/service inspection and API requests against a temporary database |

### AC-04 Startup loading and conversation selection

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentChatPage`; existing `window.teachforge.request()`; assistant-ui `ThreadRuntime.reset()` |
| 前置条件 | Desktop app starts with zero or more conversations, or the user selects a row from the loaded sidebar |
| 预期行为 | The list loads at startup; a still-existing saved active ID restores its history; selecting a row replaces current runtime messages with that row's returned messages; new-thread action clears runtime and active ID |
| 禁止出现 | Mixing messages from two conversations, preserving a stale active ID after it is absent from the list, or applying an older click's response after a newer selection |
| 判定方式 | Renderer code inspection and desktop interaction after restart and rapid conversation switching |

### AC-05 Conversation list refresh after a streamed turn

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `agent-chat-adapter.ts`; existing `AgentStreamEvent` conversation/done/error variants; shared conversation store added by this change |
| 前置条件 | A stream creates a new conversation or updates an existing one |
| 预期行为 | Sidebar refreshes after conversation metadata and stream termination; the new/updated row is visible without app restart |
| 禁止出现 | Replacing the active conversation with an unrelated ID or clearing the list on a transient refresh failure |
| 判定方式 | Renderer stream-flow inspection and local app interaction |

## Required Automated Checks

```bash
npm run build --workspace @teachforge/backend
npm run build --workspace @teachforge/desktop
```

- [L1] Backend and desktop builds verify the new response contracts and `ThreadRuntime.reset()` mapping compile.
- [L2] SQLite API verification proves ordering, title fallback, role filtering, legacy decoding, and 400/404 behavior. Do not add or run tests without explicit user request.

## Required Manual Checks

- [L3] Restart the desktop, confirm the left sidebar loads, select two conversations in sequence, and confirm only the chosen history is visible.
  - 原因：The check validates the integrated Electron local bridge and visible runtime reset.
  - 执行人：Developer.
  - 判断标准：The active ID and visible messages match each selected row; after a new prompt the conversation appears/refreshed without restarting.

## Must-Not-Break Checks

- [ ] Existing Agent streaming and cancellation remain available.
- [ ] Selecting one conversation never mixes its visible messages with another conversation.
- [ ] Tool results and provider/session internals remain absent from the Renderer bridge.
- [ ] Health and Course JSON calls retain their existing response contracts.

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| Empty database | List endpoint returns `[]`; sidebar shows its empty state | L2 | SQLite API and UI | Defines first-run behavior |
| Conversation has null title | First user prompt becomes a display title without a DB write | L1/L2 | Projection and SQL inspection | Makes rows distinguishable |
| Mixed user/assistant/tool rows | History returns only visible user/assistant text in sequence order | L2 | SQLite query | Prevents internal data exposure |
| Click conversations A then B quickly | B history remains; late A response is ignored | L1/L3 | Request-token inspection and UI click | Prevents stale cross-thread state |
| Saved active ID no longer exists | Active ID is cleared and runtime starts empty | L1/L3 | Desktop restart | Avoids stale conversation continuation |
| New conversation stream completes | Sidebar contains the created conversation and updated time | L2/L3 | Agent stream and API list | Keeps sidebar current |
| Unknown or malformed ID | 404 or 400 respectively, with no cross-conversation data | L2 | API request | Preserves isolation |

## Known Guardrails

- L1 checks do not establish Electron IPC or SQLite runtime behavior.
- Keep the existing local token and fixed request path boundary; the renderer does not receive credentials.
- Do not return raw `MessageEntity.contentJson` to the Renderer.
- Preserve all requested visible messages; pagination and context truncation remain outside this feature.

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
|---|---|---|
| Returning complete MessageEntity records | Leaks tool/runtime payloads and storage representation | Project an explicit response DTO |
| Replacing the runtime before a history request succeeds | A transient error destroys a working thread | Validate the latest response, then reset the thread |
| Applying responses without checking selection order | A late request can overwrite the user's newer selection | Ignore stale responses by request generation |

## When To Read History

- Read `docs/changes/2026-11-07-conversation-session-persistence/design.md` when changing persisted Pi message representation or recovery behavior.

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | Uses existing ConversationEntity.title/createdAt/updatedAt and MessageEntity rows; the new route and list projection are this feature's outputs. |
| AC-02 | pass | MessageEntity already carries role/content/status/sequence; legacy and tagged Pi content parsers are present in conversation-transcript.ts. The route is a new read projection within the current Conversations owner. |
| AC-03 | pass | UUIDv4 is the existing Agent conversation-ID contract; Nest ParseUUIDPipe and ConversationEntity.id provide the read boundary and existence check. |
| AC-04 | pass | AgentChatPage, window.teachforge.request, and assistant-ui ThreadRuntime.reset() are present in current code/package declarations; selection and startup loading are new UI behavior. |
| AC-05 | pass | AgentStreamEvent already defines conversation/done/error events, and agent-chat-adapter.ts consumes them; the shared list store is scoped to this feature. |

- 评审结论：AC 已协商一致，可以进入实现。
- 评审方 / 确认人 / 时间：Codex（实现方自核 AC 与现有实体/桥接/运行时 API）/ 2026-11-07

## Implementation Verification Record

- Code inspection confirms both Conversation GET routes, the text-only/status-filtered message projection, startup list loading, saved active conversation restore, selection generation guard, new-thread reset, and stream-triggered list refresh.
- `git diff --check` passed as a whitespace/conflict-marker check.
- Backend/desktop builds and Electron interaction checks are not run in this turn; no build, test, or manual verification was requested. API and UI runtime behavior remains unverified in a running application.
- L002 reproduces the missing-export condition by comparing AgentChatPage runtime imports with the optimized Vite module exports; after changing `useAssistantState` to `useAuiState`, the same check passes. Installed package `@assistant-ui/react` is version 0.15.32.

## Version History

| Version | Trigger | AC impact | Handling |
|---|---|---|---|
| 1.0 | Initial implementation and AC review. | AC-01 through AC-05 established and reviewed. | Implemented in L001; runtime/API interaction checks were not run. |
| 2.0 | Developer reported a blank page from the removed `useAssistantState` export. | No AC change; the startup UI import compatibility is covered by the existing AC-04 startup check. | Fixed in L002 with the current `useAuiState` export; import-export check passes. |
