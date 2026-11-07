---
status: implemented
layer: change
domain: conversations
canonical_for:
  - conversation-history-sidebar-verification
last_verified: 2026-11-07
version: 3.0
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
| 禁止出现 | Mixing messages from two conversations, preserving a stale active ID after it is absent from the list, applying an older click's response after a newer selection, or attaching assistant-only `status` to user messages before `ThreadRuntime.reset()` |
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
npm run test:conversation-history --workspace @teachforge/desktop
```

- [L1] Backend and desktop builds verify the new response contracts and `ThreadRuntime.reset()` mapping compile.
- [L2] SQLite API verification proves ordering, title fallback, role filtering, legacy decoding, and 400/404 behavior. Use an isolated data directory for Electron verification.

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

- 诊断记录必须注明实际入口（Electron / 普通浏览器）、进程的数据目录与所选 ID；只有来自同一次运行的证据才能支持数据库/请求/界面之间的因果判断。
- JSON bridge 的 HTTP fetch 由 Electron Main 执行。Renderer Network 为空不能单独证明请求未发出；读取 bridge 返回状态/结构，并按需关联 Main、backend 与 Renderer 证据，不输出 token 或消息正文。
- HTTP 200 后仍加载失败时，检查 DTO 转换、`thread.reset()` 与可见渲染；不要仅凭统一的 `history_request_failed` 分类重试网络或归因为空库。用独立样本和捕获异常栈区分失败阶段。
- 修复必须让原失败场景由红转绿：实际包转换回归与真实 Electron 正文显示分别验收；构建通过、提示文案改善或 404 兜底通过不能替代原症状验证。
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

- 遇到“HTTP 成功但历史不显示”、依赖消息契约变更或跨 Electron 进程诊断时，读 [运行时契约复盘](../../postmortems/2026-11-07-conversation-history-runtime.md)。
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

### v3.0 AC recheck — 2026-11-07 (before implementation)

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | Existing `ConversationsService.listConversations()` and desktop bridge verified with two SQLite fixtures; unchanged. |
| AC-02 | pass | Existing `getConversationMessages()` returned HTTP 200 and ordered user/assistant DTOs in Electron; unchanged. |
| AC-03 | pass | Existing controller ParseUUIDPipe and service NotFoundException remain unchanged. |
| AC-04 | revised | Add role-specific runtime status rule: installed `fromThreadMessageLike()` rejects status on user messages although ThreadMessageLike accepts it statically. |
| AC-04 | pass | Rechecked against `AgentChatPage.toThreadMessage`, `runtime.thread.reset`, and installed package source; real Electron repro records HTTP 200 followed by `status is only supported for assistant messages`. |
| AC-05 | pass | Existing adapter/store metadata and terminal refresh path is outside the fix; preserve it. |

- 评审结论：approved；沿用已接受的 PASS 设计门禁，无新增架构或数据模型；仅细化 AC-04。Codex 自核，不宣称用户另行审批。

## Implementation Verification Record

- Code inspection confirms both Conversation GET routes, the text-only/status-filtered message projection, startup list loading, saved active conversation restore, selection generation guard, new-thread reset, and stream-triggered list refresh.
- `git diff --check` passed as a whitespace/conflict-marker check.
- Backend/desktop builds and Electron interaction checks are not run in this turn; no build, test, or manual verification was requested. API and UI runtime behavior remains unverified in a running application.
- L002 reproduces the missing-export condition by comparing AgentChatPage runtime imports with the optimized Vite module exports; after changing `useAssistantState` to `useAuiState`, the same check passes. Installed package `@assistant-ui/react` is version 0.15.32.

### L003 — actual Electron history regression

- Reproduction uses two conversation fixtures in an independent temporary SQLite data directory and Electron's real preload/Main/backend bridge. No model/API key is needed and no user database is modified.
- Initial result: `HISTORY_RESTORE_FAIL`; GET history returned 200 with user/assistant DTOs. Debugger caught `status is only supported for assistant messages` inside `fromThreadMessageLike()` during LocalRuntime reset.
- Competing causes: missing bridge (ruled out by actual bridge responses), missing/wrong database or HTTP failure (ruled out by fixture path and HTTP 200), client conversion/reset contract (confirmed by caught stack and package guard).
- Minimal regression: `npm run test:conversation-history --workspace @teachforge/desktop`. Exercises the production converter through the installed package's `ExportedMessageRepository.fromArray`, the same path used by reset. Before fix: 2 failed / 2 passed; after fix: 4 passed. Covers mixed roles, every terminal user status, assistant completed/failed/cancelled text and empty history.
- Real Electron after fix: selected A displays A; selecting B removes A; closing and relaunching the process with the same test data restores B; new conversation clears messages and local active ID. Failed/cancelled partial assistant text remains visible. Deleting only test conversation B then selecting its stale row produces 404, refreshes the list and preserves A. Restart with B saved as active clears the stale ID.
- `npm run test:agent-stream --workspace @teachforge/desktop`: 9 passed. `npm run build:renderer --workspace @teachforge/desktop`: passed (existing bundle-size warning). Electron compilation passed through both test commands.
- Backend standard build encountered EBUSY deleting a directory held by an existing runtime. `npx tsc --project apps/backend/tsconfig.build.json --incremental false` passed without deleting the directory; no backend source was changed in this fix.
- `git diff --check`: passed. Documentation checker: 5 existing review-filename errors (rejects design-review/index names required by the workflow) and one existing L007 re-anchor warning; no new structural findings.
- Scope limit: real model generation and recovery of missing user transcripts were not tested or changed. Stream protocol/adapter regression was tested locally.
- Visual evidence: at the initial 1280×820 window, the selected user/assistant history, partial answers and composer are visible without horizontal clipping. At the existing 960×640 minimum, history is readable but the current shell scrolls vertically and the send controls fall below the first viewport; this pre-existing layout limitation is outside the history conversion fix and is not claimed as a visual pass.

## Version History

| Version | Trigger | AC impact | Handling |
|---|---|---|---|
| 1.0 | Initial implementation and AC review. | AC-01 through AC-05 established and reviewed. | Implemented in L001; runtime/API interaction checks were not run. |
| 2.0 | Developer reported a blank page from the removed `useAssistantState` export. | No AC change; the startup UI import compatibility is covered by the existing AC-04 startup check. | Fixed in L002 with the current `useAuiState` export; import-export check passes. |
| 3.0 | Developer reported history loading still fails and supplied handoff.md. | AC-04 explicitly requires role-specific status mapping; verify actual package conversion and real Electron restore/switch/new-thread/restart. | L003 fixed; regression changed from red to green and real Electron path passed. |
