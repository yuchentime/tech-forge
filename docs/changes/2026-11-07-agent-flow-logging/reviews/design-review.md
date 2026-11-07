---
status: passed
layer: change
review_type: design_review
created_at: 2026-11-07
design_path: docs/changes/2026-11-07-agent-flow-logging/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: agent-flow-logging

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-07-agent-flow-logging/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

The developer asked for proactive logs across the business flow starting at `agent.service.ts`, so developers can locate failures quickly. The design adds correlated structured logs at existing backend boundaries, including transcript persistence, Pi/model execution, tools, and conversation reads. It keeps the API and UI contracts unchanged and excludes raw content/secrets.

- Original ask: add useful logs throughout the Agent business flow, beginning at AgentService.
- Design goals in scope: request correlation, lifecycle/failure phases, persistence/tool outcome visibility, and safe diagnostics on read APIs.
- Design items outside ask: remote log shipping, file rotation/retention, UI log display, and a new telemetry platform.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | Backend flow logs answer the requested developer-diagnostics need without changing user behavior. |
| No premature new abstraction layer | pass | A small serializer/redaction helper uses Nest Logger; no transport, bus, interceptor framework, or external dependency is introduced. |
| No speculative generalization | pass | Correlation is explicit across the current Agent flow and Conversation read endpoints. |
| Cross-cutting surface growth justified | pass | `requestId` must cross controller, Agent, Conversations, and LLM boundaries to make logs searchable as one request. |
| Operational weight justified | pass | Logging has no database writes, queue, or external service; frequent progress records are throttled. |
| Alternatives Considered includes a simpler option | pass | Direct `console.log` was considered and rejected for inconsistent fields and missing safety controls. |
| Touch/complexity budget reasonable | pass | Changes are limited to backend Agent/LLM/Conversations owners, one shared logger helper, and current runtime docs. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | Logs remain process output; no persisted log table is required. |
| Alterations / migrations scoped | pass | No schema change. |
| Cross-domain FK / shared tables justified | pass | No new database relation or shared table. |
| Rollback / backfill cost acceptable | pass | Remove the helper/call sites without migration or data backfill. |
| No speculative schema for unused futures | pass | No request-id column is added to conversations or messages. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 through AC-05 cover correlation, phase outcomes, persistence/tool events, read APIs, and safety. |
| AC 代码接地 | pass | All current controllers, service methods, options, and error mapping referenced in ACs exist in the codebase. |
| AC 可判定 | pass | Event fields, prohibited content, status boundaries, and response invariants are inspectable. |
| AC 粒度合适 | pass | Criteria cover key logging/diagnostic decisions without prescribing each log statement. |
| 与 design.md 目标对应 | pass | Every design goal has an AC. |
| Must-Not-Break 业务语义保留 | pass | SSE, persistence ordering, cancellation, and safe-content boundaries are explicit. |

### Compatibility — Sensitive Logging

| Check | Result | Notes |
|---|---|---|
| Prompt/message/tool/provider payload exclusion | pass | Design prohibits raw payload logging and omits arbitrary error messages/causes. |
| Current response contract preserved | pass | No request DTO or SSE fields are added. |
| Diagnostic usefulness | pass | Request ID, phase, safe IDs, counts, status, timing, and stack frames are sufficient for local triage. |

## Findings

### Over-design / risk findings

- None blocking. The key risk is accidental content leakage; AC-05 and the logging helper constrain it.

### Suggested cuts (thinner design)

- Do not add a request-ID SSE event, log file persistence, or third-party logger in this change.

### Worth keeping (surprising but justified now)

- Omit `Error.message` and `cause` from log records: provider and tool errors can contain user or credential-bearing data.
- Pass request IDs explicitly: flow ownership stays visible rather than depending on ambient async state.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: The design adds only the correlation and lifecycle records required for local diagnosis; raw content and external logging infrastructure remain excluded.
- Confirmed at: 2026-11-07

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | Architecture, data model, AC quality, and sensitive logging boundaries pass. Strict AC-to-code review is recorded as approved in `verification.md` before implementation. |
