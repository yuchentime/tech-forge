---
status: passed
layer: change
review_type: design_review
created_at: 2026-11-08
design_path: docs/changes/2026-11-08-conversation-tool-activity-history/design.md
design_version: 1.0
verdict: PASS
confirmation_status: approved
---

# Design Review: conversation-tool-activity-history

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-08-conversation-tool-activity-history/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: the first live conversation displays tool activity, but selecting another conversation and returning loses those tool rows; inspect `getConversationMessages()`.
- Design goals in scope: include safe tool activity in history and restore it below the matching user message after page load.
- Design items outside ask: changing the live stream, exposing tool result payloads, or altering text pagination and persistence recovery.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | The fix follows the existing conversation history request and event bus path. |
| No premature new abstraction layer | pass | Reuses `ConversationsService`, `ConversationMessageDto`, `AgentChatPage`, and `AgentEventBus`. |
| No speculative generalization | pass | Adds one nested summary contract for persisted tool execution history. |
| Cross-cutting surface growth justified | pass | Backend DTO/query and desktop restore both need to carry the same summaries. |
| Operational weight justified | pass | Uses existing SQLite rows; adds no service, process, cache, or external dependency. |
| Alternatives Considered includes a simpler option | pass | Evaluates top-level tool messages, frontend-only state, and a new relation column. |
| Touch/complexity budget reasonable | pass | Keeps tool activity auxiliary to user messages and preserves existing message roles. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | Reuses `messages` rows with role `toolExecution`. |
| Alterations / migrations scoped | pass | Optional `displayPath` is stored in tagged JSON; no SQLite schema migration. |
| Cross-domain FK / shared tables justified | pass | Not applicable; all rows belong to the same Conversation. |
| Rollback / backfill cost acceptable | pass | Existing rows without paths remain readable; they show name/status/duration only. |
| No speculative schema for unused futures | pass | No durable turn FK or new table is introduced. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 through AC-03 cover backend selection, frontend restore, and safe projection. |
| AC 代码接地 | pass | All current class/method anchors exist; `toolActivities` is clearly an intended additive response field. |
| AC 可判定 | pass | SQLite fixtures and event-bus snapshots give direct pass/fail results. |
| AC 粒度合适 | pass | Criteria cover association, page behavior, and privacy without method pseudocode. |
| 与 design.md 目标对应 | pass | Each goal maps to a criterion. |
| Must-Not-Break 业务语义保留 | pass | Existing text history, pagination, live stream, and tool privacy remain explicit. |

## Findings

### Over-design / risk findings

- None. The persisted row sequence already gives a turn boundary, and no migration is needed.

### Suggested cuts (thinner design)

- No cuts. Returning top-level tool rows or relying on the renderer cache would not meet the reported reload behavior.

### Worth keeping (surprising but justified now)

- Store only `args.path` as `displayPath`; the live UI already displays that field, while full arguments/results remain private.
- Restore by persisted user row ID rather than reusing the live snapshot key, because backend and renderer message IDs are generated independently.

## Developer Decision

- Decision:
- Reason / accepted cuts:
- Confirmed at:

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | AC review completed and approved before implementation. |
