---
status: passed
layer: change
review_type: design_review
created_at: 2026-11-07
design_path: docs/changes/2026-11-07-conversation-history-sidebar/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: conversation-history-sidebar

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-07-conversation-history-sidebar/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

The developer asked for a Conversation query API, startup loading into the left sidebar, and loading a conversation's message history when selected. The design adds those read paths and desktop behavior while keeping storage and stream contracts intact.

- Original ask: expose persisted conversations to the UI and load a selected conversation's messages.
- Design goals in scope: ordered list/history GET APIs, first-prompt display title, startup list fetch, selection-driven runtime restore, and stream-triggered list refresh.
- Design items outside ask: rename/delete/search/pagination, historical tool activity, title generation, and schema changes.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | The user requested list/history reads and sidebar selection; adjacent CRUD and tool-history UI remain out of scope. |
| No premature new abstraction layer | pass | Uses the existing Conversations module/controller boundary and a small renderer store needed by both startup loading and stream refresh. |
| No speculative generalization | pass | The store has one consumer and one local backend; no generic repository/query framework is introduced. |
| Cross-cutting surface growth justified | pass | Backend read APIs, the existing desktop JSON bridge, and the Agent runtime must cooperate to display persisted history. |
| Operational weight justified | pass | No jobs, cache, external service, or schema migration is needed. |
| Alternatives Considered includes a simpler option | pass | The design considers direct Agent endpoints and returning raw entity rows, then selects domain-owned projections. |
| Touch/complexity budget reasonable | pass | Changes stay within Conversations, the existing desktop Agent feature, and the current architecture/API docs. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | Existing ConversationEntity and MessageEntity contain list ordering and history content. |
| Alterations / migrations scoped | pass | Read-only projections; no entity or schema changes. |
| Cross-domain FK / shared tables justified | pass | No new relationship or cross-domain table is introduced. |
| Rollback / backfill cost acceptable | pass | Legacy text-block rows remain readable and titles are derived at query time. |
| No speculative schema for unused futures | pass | No pagination cursor, rename metadata, summary, or archive state is added. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 through AC-05 cover list, history, input/existence errors, runtime selection, and refresh. |
| AC 代码接地 | pass | Criteria anchor to existing entities, ConversationsModule, AgentChatPage, the desktop bridge, and ThreadRuntime API; new route names are explicitly the feature outputs. |
| AC 可判定 | pass | Ordering, title fallback, role/status filtering, response races, and refresh outcomes are directly inspectable. |
| AC 粒度合适 | pass | Criteria cover API and selection decisions without specifying line-level implementation. |
| 与 design.md 目标对应 | pass | Each goal maps to at least one AC. |
| Must-Not-Break 业务语义保留 | pass | Streaming, local auth, hidden tool results, and existing endpoints have explicit regression checks. |

## Findings

### Over-design / risk findings

- None blocking. Full-list and full-history reads are intentionally unpaginated for the requested initial workflow; size risk is documented.

### Suggested cuts (thinner design)

- Keep the two read endpoints text-projected; do not return raw MessageEntity rows.

### Worth keeping (surprising but justified now)

- Deriving a list title from the first user prompt is required because current ConversationEntity rows have nullable titles and a raw ID would not identify a sidebar item.
- Refreshing after stream metadata and termination keeps both newly-created and updated rows visible without polling.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: The PASS design matches the requested list, selection, and history flow; no additional CRUD or schema work is included.
- Confirmed at: 2026-11-07

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | Design scope and architecture/data-model checks pass. Strict AC-to-code review is recorded as approved in `verification.md` before implementation. |
