---
status: passed
layer: change
review_type: design_review
created_at: 2026-11-07
design_path: docs/changes/2026-11-07-conversation-session-persistence/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: conversation-session-persistence

## Summary

| Field | Value |
|---|---|
| Design | docs/changes/2026-11-07-conversation-session-persistence/design.md |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: implement Pi SDK session persistence using the existing Conversation and Message entities.
- Design goals in scope: store turns in SQLite, restore ordered history through the SDK SessionManager, and retain the active conversation identity across app restarts.
- Design items outside ask: conversation selection and rendering the old transcript after restart; these are explicitly deferred.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | The plan centers on SQLite transcript persistence and SDK context restoration. |
| No premature new abstraction layer | pass | Reuses the existing Agent, Conversations, LLM, and Electron bridge modules. |
| No speculative generalization | pass | One active desktop conversation matches the current single-thread UI. |
| Cross-cutting surface growth justified | pass | A conversation ID event and optional request field are needed to resume the same record. |
| Operational weight justified | pass | A process-local lock prevents sequence/history races in the single backend process. |
| Alternatives Considered includes a simpler option | pass | File-backed sessions and prompt-prefix history are considered and rejected for data consistency and SDK contract reasons. |
| Touch/complexity budget reasonable | pass | Changes are bounded to existing persistence and stream ownership boundaries. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | Existing ConversationEntity and MessageEntity represent the required data. |
| Alterations / migrations scoped | pass | No schema change; current entities contain sequence, content, status, and ID fields. |
| Cross-domain FK / shared tables justified | pass | Conversation and messages remain owned by the Conversations module. |
| Rollback / backfill cost acceptable | pass | No schema migration or existing-data rewrite is planned. |
| No speculative schema for unused futures | pass | No thread listing, ownership, Pi session file path, or compaction fields are added. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC exist and are numbered continuously | pass | AC-01 through AC-05 cover identity, writes, restoration, lifecycle, and isolation. |
| AC are grounded in code | pass | The criteria reference existing DTO/controller/service/entity owners and the installed SessionManager API. |
| AC are judgeable | pass | Each criterion names an input condition, persisted result, and forbidden outcome. |
| AC granularity is appropriate | pass | Criteria cover state and isolation boundaries without prescribing line-level code. |
| AC correspond to design goals | pass | Persistence, restart context, cancellation, and ordering each have coverage. |
| Must-Not-Break behavior is retained | pass | Streaming, cancellation, authentication, and existing JSON endpoints are retained. |

### Optional Dimensions

| Check | Result | Notes |
|---|---|---|
| n/a | n/a | No further active dimensions apply. |

## Findings

### Over-design / risk findings

- None blocking. The visible transcript does not reload after restart, which is explicitly outside this backend persistence scope.

### Suggested cuts (thinner design)

- None.

### Worth keeping (surprising but justified now)

- Persisting the active conversation ID in the desktop adapter is necessary for the current single-thread UI to resume the same SQLite transcript after restart.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: PASS; no cuts or confirmation are required before implementation.
- Confirmed at: 2026-11-07

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | AC review approved; implementation followed the reviewed SQLite and Pi SessionManager design. |

## v2.0 Design Review

### Scope Anchor

- Original ask: persist user/assistant conversations using existing entities and resume multi-turn Pi context.
- Updated requirement: persist Pi assistant snapshots, tool calls, and tool results during the run so later requests can recover after process interruption.
- Outside scope: resuming the exact provider process, rolling back external tool side effects, conversation UI history restoration, and token compaction.

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches goals / non-goals | pass | Recovery uses the existing next-request path and does not claim process continuation. |
| No new abstraction layer | pass | Adds small versioned Pi message/tool records under existing ConversationsService. |
| No speculative generalization | pass | Stores current Pi message and tool event types in existing ordered rows. |
| Cross-cutting surface justified | pass | Pi event handling already crosses LlmService, AgentService, and SQLite; durable recovery requires writes at that boundary. |
| Operational weight justified | pass | Writes are short row updates; no jobs, queues, or startup worker is needed. |
| Simpler alternative considered | pass | Writing only finalized `message_end` entries would lose streamed assistant content during an interruption; awaited event hooks are required to durably record tool state before execution proceeds. |
| Complexity budget reasonable | pass | Reuses existing ordered MessageEntity rows and `contentJson`; no schema migration. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | Existing MessageEntity can own user turns, ordered native Pi messages, and tool execution state. |
| Alterations / migrations scoped | pass | No columns or migration; contentJson format discriminators preserve backward compatibility with text-block rows. |
| Cross-domain relationships | pass | No new relationships or ownership changes. |
| Rollback / backfill acceptable | pass | Legacy text rows remain readable; each new Pi message and tool event row uses tagged JSON payloads. |
| No speculative schema | pass | No durable queue, process checkpoint, or arbitrary event log is introduced. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC are continuous | pass | AC-01 through AC-07 cover identity, writes, restoration, terminal states, isolation, incremental persistence, and recovery. |
| AC reference real code/API | pass | New criteria anchor to existing service/entity methods and Pi SDK event discriminants. |
| AC are judgeable | pass | The event write order, persisted JSON, restoration order, and tool replay count are directly inspectable. |
| Scope corresponds to updated ask | pass | AC-06 and AC-07 cover immediate durability and follow-up recovery. |

### Findings

- Over-design / blocking risks: none.
- Accepted limitation: a process crash cannot resume the same provider call. Recovery uses the durable message rows on the next request; a missing toolResult is rebuilt from a saved final result when available, or receives a synthetic error result so side effects are not blindly repeated.
- Durable tool results and arguments stay local in SQLite and are not added to the renderer message bridge.

### Developer Decision

- Decision: approved
- Reason / accepted cuts: This matches the confirmed requirement to send prior messages to the model and retain in-flight tool/message state for later recovery.
- Confirmed at: 2026-11-07

### Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | v2.0 scope and AC reviewed before implementation. |
