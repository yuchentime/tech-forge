---
status: implemented
layer: change
domain: agent-runtime
canonical_for:
  - agent-flow-logging-verification
last_verified: 2026-11-07
version: 1.0
acceptance_review_status: approved
---

# Agent Flow Logging Verification

## Test Layer Taxonomy

- **L1 — Local Logic Verification**: inspect structured event fields, context propagation, redaction, levels, and throttling at the source boundaries.
- **L2 — Automated Real-World Verification**: run a request against the local backend/SQLite and verify correlated logs from HTTP through finalization.
- **L3 — Human-Aided Verification**: inspect logs from a local Electron run only if the backend request ID must be correlated with a developer-reported UI failure.

## Acceptance Criteria（代码级验收规则）

### AC-01 Request correlation across streamed Agent flow

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentController.stream()`; `AgentService.stream()`; `LlmStreamOptions`; `ConversationsService` turn/message/tool methods |
| 前置条件 | A valid `POST /api/agent/stream` request enters `AgentController.stream()` |
| 预期行为 | The controller creates one UUID request ID and the same ID appears in logs for queueing, turn persistence, LLM session/run, and finalization; the conversation ID is logged when known. |
| 禁止出现 | A later layer generates a conflicting ID for the same request or sends this internal ID in the existing SSE payload. |
| 判定方式 | Static inspection of parameter propagation and structured log field names across all listed methods. |

### AC-02 Agent and LLM phase outcomes

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentController.stream()`; `AgentService.stream()`; `LlmService.createSession()`; `LlmService.stream()` |
| 前置条件 | A streamed Agent request waits for its conversation lock, begins a turn, creates a Pi session, runs a model, and terminates by completion, failure, or cancellation. |
| 预期行为 | Logs identify phase start/completion/failure, request/conversation IDs, elapsed durations, model/provider IDs when known, turn status, and terminal HTTP outcome. Failure records include a safe error type/code and bounded stack frames. |
| 禁止出现 | Raw exception message, provider payload, credentials, request body, prompt, or assistant response in logs; user-facing safe SSE error behavior changes. |
| 判定方式 | Code inspection of lifecycle branches, log helper redaction, and unchanged `getSafeErrorMessage()` usage. |

### AC-03 Transcript and tool persistence visibility

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentService.persistPiEvent()`; `ConversationsService.beginTurn()`; `startPiMessage()`; `updatePiMessage()`; `startToolExecution()`; `updateToolExecution()`; `finishTurn()` |
| 前置条件 | Pi emits user/assistant message lifecycle, a tool starts/updates/ends, a prior interrupted turn is reconciled, or a turn is finalized. |
| 预期行为 | Logs identify persisted row/event type, role/tool name, status, safe row/call IDs, counts, and relevant durations; update progress is summarized or throttled. |
| 禁止出现 | Message text, tool arguments, partial/final tool results, or raw `contentJson` in logs; high-frequency text updates produce an info log per token/delta. |
| 判定方式 | Code inspection of each persistence branch and explicit metadata allowlists. |

### AC-04 Conversation query request diagnostics

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `ConversationsController.list()`; `ConversationsController.getMessages()`; `ConversationsService.listConversations()`; `getConversationMessages()` |
| 前置条件 | Renderer requests `GET /api/conversations` or `GET /api/conversations/:conversationId/messages`. |
| 预期行为 | Each request gets a UUID request ID; logs report route operation, conversation ID when applicable, duration, and summary/message counts for success or safe exception metadata for failure. |
| 禁止出现 | List titles, message contents, raw entities, or full response body in logs; response schemas or status behavior change. |
| 判定方式 | Static inspection of controller/service context propagation and log fields. |

### AC-05 Logging remains observational and safe

| 要素 | 内容 |
| --- | --- |
| 代码位置 | New shared structured logging helper; all Agent, LLM, Conversations logging call sites; `AgentController.getSafeErrorMessage()` |
| 前置条件 | Any success, error, cancellation, or progress log is emitted. |
| 预期行为 | Each record is a JSON event with stable `event`, timestamp, and relevant correlation metadata; errors omit message text and payload-bearing causes; existing SSE event and safe error contracts remain unchanged. |
| 禁止出现 | Logs alter cleanup/transaction behavior, serialize arbitrary objects, or expose prompt/response/tool/auth secrets. |
| 判定方式 | Static inspection of helper and every logging call; `git diff --check`. |

## Required Automated Checks

```bash
git diff --check
```

- [L1] Static review maps each AC to its method and verifies explicit safe fields. This is required because test/build execution was not requested in the current work instructions.
- [L1] `git diff --check` checks whitespace and conflict markers; it does not prove runtime log output.
- [L2] A local backend request with a fake/stub model can verify one request ID crosses HTTP, SQLite, LLM, and finalization logs. Do not run until integration verification is requested; use an isolated database and a stub model, with no provider credentials or external tool writes.

## Required Manual Checks

No mandatory L3 check. If a developer later reports an Electron-only issue, filter backend console output by the request ID visible in backend logs and verify stage order.

## Must-Not-Break Checks

- [x] Agent still streams the same safe SSE event shape and generic error text (source inspection; no DTO/SSE projection change).
- [x] User, assistant, and tool transcript commits still precede the next Pi action (source inspection; awaited persistence hook remains in place).
- [x] Cancellation still finalizes the turn and releases the conversation lock (source inspection; existing `finally` path remains).
- [x] No prompt, assistant text, tool argument/result, provider payload, API key, or local auth token appears in logs (source inspection of every call site and helper).
- [x] Conversation list/history responses remain unchanged and read-only (source inspection; only optional internal diagnostic context was added).

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
|---|---|---|---|---|
| Successful turn | One request ID links accepted, queue, context, LLM, persistence, finish, and HTTP terminal logs | L1/L2 | Propagation inspection; local backend integration when requested | Lets developers follow the full lifecycle |
| Existing conversation lock wait | Logs report wait/acquired and wait duration under the same request ID | L1/L2 | Queue path inspection/integration | Distinguishes contention from provider latency |
| Provider/session setup failure | Stage and safe error type/stack are logged; SSE message remains generic | L1/L2 | Failure branch inspection/integration | Localizes setup errors without exposing provider data |
| Tool succeeds or fails | Tool ID/name/status/duration appear; arguments and result do not | L1/L2 | Event hook inspection/integration | Localizes tool failures while protecting content |
| Persistence failure | Hook/transaction operation and request ID are logged before the existing stream failure | L1/L2 | Catch branch inspection/integration | Separates DB failures from model failures |
| User disconnects | Cancellation and finalization logs share the request ID; lock releases | L1/L2 | Controller/service branch inspection/integration | Confirms cleanup after interrupted streams |
| Conversation list/history query | Request ID and row counts/duration appear without titles or message text | L1/L2 | Query boundary inspection/integration | Diagnoses read-side issues without leaking transcript |

## Known Guardrails

- Do not pass prompt/message/tool/provider objects to the log helper.
- Do not log arbitrary `Error.message`, `Error.cause`, request bodies, or provider/tool payloads.
- Keep high-frequency progress logs throttled and below info level.
- Request IDs are internal diagnostics; do not add them to public SSE events without a separate contract decision.

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
|---|---|---|
| `console.log(prompt)` or logging full Pi events | Exposes user content, tool data, and provider payloads | Log IDs, event types, roles, statuses, counts, and durations only |
| Log only one generic catch at the HTTP boundary | Cannot identify whether persistence, setup, provider, or cleanup failed | Log failure at the owning boundary with request ID and stage |
| Info log for every token or DB snapshot | Floods console output and hides terminal failures | Aggregate counts and throttle progress metadata |
| Log raw error messages and causes | Provider/tool errors can embed request data or credentials | Log safe error class/code and bounded stack frames |

## When To Read History

- Read `docs/changes/2026-11-07-conversation-session-persistence/design.md` for transcript transaction and interrupted-turn reconciliation semantics.

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
|---|---|---|
| AC-01 | pass | `AgentController.stream`, `AgentService.stream`, `LlmStreamOptions`, and all listed ConversationsService mutation methods exist. The new request ID/context fields are implementation outputs; no public DTO/SSE field is required. |
| AC-02 | pass | `AgentController.stream`, `AgentService.stream`, `LlmService.createSession`, `LlmService.stream`, and `getSafeErrorMessage` exist at the named owner boundaries. |
| AC-03 | pass | `AgentService.persistPiEvent` and `ConversationsService.beginTurn/startPiMessage/updatePiMessage/startToolExecution/updateToolExecution/finishTurn` all exist and own the described persistence events. |
| AC-04 | pass | `ConversationsController.list/getMessages` and `ConversationsService.listConversations/getConversationMessages` are the existing read paths. |
| AC-05 | pass | `AgentController.getSafeErrorMessage` exists; the structured logging helper and event schema are new outputs, scoped to safe serialization and current Nest Logger. |

- 评审结论：AC 已逐条对照现有接口、字段与 service 边界核验，可以进入实现。
- 评审方 / 确认人 / 时间：Codex（实现方自核实际代码实体与 AC 位置）/ 2026-11-07

## Version History

L001 implementation is complete. Static source review and `git diff --check` are recorded in the worklog; no tests, builds, or live backend verification were requested or run.
