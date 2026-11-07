---
status: implemented
layer: change
domain: agent-runtime
created_at: 2026-11-07
landed_in: L001
version: 1.0
updates_current:
  - docs/current/platform/agent-runtime.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/index.md
  - docs/current/domains/conversations/index.md
  - docs/current/domains/conversations/backend-behavior.md
---

# Agent Flow Structured Logging Design

## Problem

Agent requests currently have no business-flow logs in the backend. When a stream fails, the renderer receives a generic safe error, while developers cannot quickly tell whether it failed during queueing, SQLite recovery/write, Pi session setup, model execution, tool execution, or turn finalization. The current flow also lacks one correlation ID across these boundaries.

## Goals

- Create one backend `requestId` at the Agent HTTP boundary and carry it through AgentService, ConversationsService, and LlmService.
- Emit structured, searchable lifecycle logs for queue, turn, transcript recovery/persistence, Pi session setup/run, tool lifecycle, and HTTP terminal state.
- Include safe diagnostic metadata such as conversation/message/tool IDs, phase, state, counts, durations, provider/model IDs, and error stack frames.
- Log Conversation list/history query start, outcome, row count, and duration under their own request IDs.
- Keep prompts, assistant text, tool arguments/results, API keys, auth tokens, and raw provider payloads out of logs.

## Non-Goals

- No new logging provider, file sink, log shipping service, database table, or log-retention policy.
- No change to SSE event shape, cancellation semantics, persistence transactions, or user-facing error messages.
- No Renderer/Electron log forwarding or request ID display in the UI.
- No attempt to log every text delta or every Pi persistence update at the default information level.

## Must-Not-Break Existing Behavior

- Agent SSE still streams the same safe event contract and the same generic user-facing error messages.
- SQLite commits still complete before Pi proceeds to a later event or tool execution.
- Request cancellation and conversation serialization still release their resources and retain terminal status.
- Full prompts, model responses, tool arguments/results, and credentials remain outside logs.
- Conversation list/history reads remain read-only and return the same projections.

## Before Change

- `AgentController` opens the SSE response, advances `AgentService.stream()`, writes projected frames, and converts thrown failures to safe SSE errors. It creates no request correlation ID and emits no business logs.
- `AgentService` serializes requests per conversation, runs `beginTurn()`, streams Pi events through `LlmService`, persists message/tool events, and calls `finishTurn()`, with no progress or failure logs.
- `LlmService` dynamically loads Pi, initializes model/session resources, runs `session.prompt()`, and waits for transcript persistence hooks, but emits no lifecycle logs.
- `ConversationsService` owns turn/history reads and SQLite writes but emits no query or persistence logs. `ConversationsController` exposes list/history reads without logging.
- Backend currently uses Nest's default logger; there is no custom logging provider or logging configuration.

## Proposed Behavior

1. Add a small backend logging utility that writes one-line JSON events through Nest `Logger`. Every event has `event` and ISO timestamp fields plus explicit safe metadata.
2. `AgentController` creates a UUIDv4 `requestId`, logs request accepted/stream completed/stream failed/client disconnected, and passes the ID to `AgentService`. It logs prompt length only, never prompt text.
3. `AgentService` logs queue wait/acquisition, turn start/context counts, LLM start/end, Pi message/tool milestones, failure phase, finalization result, and lock release. All sub-operations receive the same `requestId` and `conversationId`.
4. `LlmService` logs session setup stages and model-run start/end/cancel/failure. It aggregates Pi event counts and logs persistence-hook failures. Provider/model identifiers are allowed; provider errors are recorded by safe error type/code and stack frames, never raw messages or payloads.
5. `ConversationsService` logs turn recovery and transaction outcomes, persisted message/tool row IDs/statuses, and list/history row counts and durations. Content is represented only by lengths/counts when progress diagnostics need them.
6. `ConversationsController` creates request IDs for list/history calls and propagates them. The list/history response body and renderer contract do not change.
7. Default `log` level records phase boundaries and terminal outcomes. `debug` records high-frequency progress metadata such as throttled message-update counts; raw text deltas and tool payloads are never emitted.
8. Failure logs omit `Error.message` because provider/tool errors may embed prompt, content, paths, or credentials. They include a normalized error type, stable error code/status when available, the failing stage, and stack frames after the first line.

## Alternatives Considered

| 方案 | 结论 | 理由 | 是否升级为 ADR |
|---|---|---|---|
| Add direct `console.log` calls across services | 否决 | Inconsistent fields/levels and no shared redaction boundary; difficult to correlate or search. | n/a |
| Add a third-party logging stack and configure transports | 否决 | The requested need is local developer diagnosis; Nest Logger already exists and no remote sink is required. | n/a |
| Correlate with Node `AsyncLocalStorage` | 否决 | Explicit context parameters make request ownership visible at the existing async service boundaries and avoid hidden ambient state. | n/a |
| Pass a generated request ID and use one structured event helper | 采用 | Minimal dependency and explicit, testable propagation across the existing controller/service flow. | n/a |

## Business Flow

The HTTP controller creates a request ID and starts the Agent stream. The ID follows queueing, SQLite turn setup, Pi session/model execution, awaited message/tool persistence, and finalization. Each boundary emits a structured event; failures retain the same ID and stage through the safe HTTP/SSE terminal response. Conversation read APIs use the same event format with their own request IDs.

## End-to-End Data Interaction Flow

```mermaid
sequenceDiagram
    participant HTTP as AgentController
    participant Agent as AgentService
    participant Conv as ConversationsService
    participant DB as SQLite
    participant LLM as LlmService / Pi SDK
    participant Tool as Pi tool
    HTTP->>HTTP: create requestId; log accepted
    HTTP->>Agent: stream(prompt, conversationId, signal, requestId)
    Agent->>Agent: log queue wait/acquired
    Agent->>Conv: beginTurn(..., requestId)
    Conv->>DB: read/reconcile/save turn
    Conv-->>Agent: history + turn marker; log row counts
    Agent->>LLM: stream(..., requestId)
    LLM->>LLM: log session setup and model run
    loop Pi messages and tool events
        LLM->>Agent: persisted Pi event callback
        Agent->>Conv: write message/tool state with requestId
        Conv->>DB: commit short write
        Conv-->>Agent: commit complete; log safe row metadata
        opt tool call
            LLM->>Tool: execute tool
            Tool-->>LLM: result/error
        end
        LLM-->>Agent: Pi event; log lifecycle/progress metadata
    end
    Agent->>Conv: finishTurn(status, requestId)
    Conv->>DB: commit final turn status
    Agent-->>HTTP: projected events / completion
    HTTP->>HTTP: log HTTP terminal status and elapsed time
```

| 关键节点 | 输入 | 节点职责 | 输出 / 状态变化 | 关键边界 |
|---|---|---|---|---|
| AgentController | Validated prompt, optional conversation ID, abort signal | Create correlation ID, log HTTP lifecycle, preserve safe SSE mapping | Same request ID passed to AgentService | Never log prompt or change error response contract |
| AgentService | Request ID and conversation command | Log queue/turn/model/tool/finalization phases and carry context to owned services | Correlated progress and terminal status | Release lock on success, error, and cancellation |
| ConversationsService | Conversation/message/tool writes and reads | Log recovery counts, committed row metadata, query counts and duration | Durable state unchanged; logs identify operation/row IDs | No content, args, results, or transaction expansion |
| LlmService / Pi SDK | Provider/model configuration, prior history, request ID | Log setup stages, run lifecycle, aggregate event counts, hook failures | Correlated run diagnostics | No prompt, response, credentials, or provider payloads |
| Structured logging helper | Event name and whitelisted metadata | Serialize uniform JSON and safe error fields through Nest Logger | One searchable log line per event | Error message first line is omitted; stack frames are bounded |

## Data And API Impact

- Add an internal `requestId` field to Agent execution options and pass it explicitly; it is not added to request DTOs or SSE payloads.
- Add optional diagnostic context parameters to ConversationsService operations so Agent and read APIs share one correlation ID.
- Add a shared logging helper under backend infrastructure. No database, API response, Electron IPC, or dependency changes.
- Event fields are explicitly allowlisted at call sites. Never spread prompt/message/tool/provider objects into log metadata.

## Frontend Fetching Logic

No frontend requests or fetching logic change. Renderer still calls the existing Agent stream and Conversation JSON endpoints.

## Frontend Behavior

No visible UI behavior change. Developers inspect backend process logs and filter by `requestId` or `conversationId`.

## Backend Fetching Logic

- Agent POST request ID originates in `AgentController`, then flows through `AgentService` to LlmService and all turn/message/tool persistence methods.
- Conversation GET request IDs originate in `ConversationsController`; service logs include duration and result count, but not response content.
- No logging transaction, queue, or cache is introduced. Existing SQLite transaction boundaries remain untouched.
- Error logging uses the current operation stage and safe exception metadata; safe SSE messages remain unchanged.

## Backend Behavior

- Information-level events mark business phase transitions and terminal outcomes; debug-level events carry throttled/high-frequency progress counts.
- Message events include role, internal ID, status, content length/block count, and elapsed time only when useful; tool events include tool name/call ID/status/duration only.
- Request IDs correlate HTTP, Agent, LLM, and persistence logs. List/history calls have independent IDs because they are separate requests.
- Existing cancellation, serialization, model, tool, persistence, and HTTP behavior remains the source of truth; logging is observational only.

## Error Handling

- Log and rethrow existing failures without converting them into success or changing the safe error sent to the Renderer.
- Log `errorType`, an allowlisted code/status, the current stage, and a bounded stack-frame list. Do not log `error.message`, `cause`, request bodies, tool data, or provider response bodies.
- Log cancellation as a terminal state rather than as an ordinary provider failure. If finalization itself fails, emit a separate `conversation.finish.failed` event before propagating the error.
- Logger serialization must tolerate non-Error thrown values and must not prevent normal cleanup.

## Risks

- Excessive progress logs could obscure useful events; high-frequency updates must be throttled and emitted at debug level.
- Explicit request ID parameters increase signatures across the existing Agent and Conversations boundaries; keep the context narrow and optional for non-Agent callers.
- Stack paths and internal IDs are useful locally but should not be forwarded to Renderer or provider/tool payloads.
- Nest's default logger is console-oriented; log shipping, rotation, and retention remain outside this change.

## Verification

- Acceptance criteria cover ID propagation, lifecycle coverage, sensitive-data exclusion, query logs, and unchanged SSE behavior.
- Use static code inspection and `git diff --check`; do not add or run tests/builds unless requested.
- Manual review confirms every log call uses whitelisted fields and no error message or payload is serialized.

## Design Deviations

| 偏差 | 发现于 | 与设计不符之处 | 处理（改设计 / 改现状文档 / 接受） |
|---|---|---|---|

## Version History

No post-delivery revision has occurred; this is the initial v1.0 design.

## Current Doc Updates

- [x] `docs/current/platform/agent-runtime.md`
- [x] `docs/current/platform/architecture-and-code-placement.md`
- [x] `docs/current/index.md`
- [x] `docs/current/domains/conversations/index.md`
- [x] `docs/current/domains/conversations/backend-behavior.md`
- [x] `docs/manifest.yaml`
