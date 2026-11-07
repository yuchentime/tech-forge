---
status: approved
layer: change
review_type: design_review
created_at: 2026-11-07
design_path: docs/changes/2026-11-07-agent-chat-layout-history-pagination/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: Agent Chat Layout and History Pagination

## Summary

| Field | Value |
|---|---|
| Design | docs/changes/2026-11-07-agent-chat-layout-history-pagination/design.md |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: remove everything outside the screenshot's red-framed chat workspace; lock scrolling to the conversation list and messages while keeping the composer fixed; initially fetch 30 messages and load earlier history on demand.
- Design goals in scope: full-viewport two-pane chat, two internal scroll regions, 30-message backend pages, stable older-page cursor and renderer prepend.
- Design items outside ask: no chat redesign beyond the current palette/content hierarchy; no new history management actions or model-context truncation.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | Every proposed change maps to one of the three requested behaviors. |
| No premature new abstraction layer | pass | Reuses App, AgentChatPage, ConversationSidebar, controller, service and existing preload request bridge. |
| No speculative generalization | pass | Page size is fixed at 30 for the one current history consumer; no generic query/cache layer. |
| Cross-cutting surface growth justified | pass | The existing history endpoint and renderer consumer must change together for on-demand paging. |
| Operational weight justified | pass | Read-only SQLite queries only; no cache, queue, migration or background process. |
| Alternatives Considered includes a simpler option | pass | Full-history truncation and offset paging are considered and rejected for direct reasons. |
| Touch/complexity budget reasonable | pass | Changes remain within the Agent page, query contract and Conversations query owner. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | No tables are needed. |
| Alterations / migrations scoped | pass | No columns or indexes change. |
| Cross-domain FK / shared tables justified | pass | No new relation or shared table. |
| Rollback / backfill cost acceptable | pass | No persisted data changes or backfill. |
| No speculative schema for unused futures | pass | The cursor reuses MessageEntity.id and existing sequenceNo. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 through AC-04 cover API first page, cursor page, scroll boundaries and renderer paging. |
| AC 代码接地 | pass | The path, Controller, Service, existing DTO, MessageEntity.id/sequenceNo and page components exist. Planned page metadata is explicitly a new response contract, not a claim about current code. |
| AC 可判定 | pass | Message counts/order/visibility, cursor boundary, scroll regions and request replacement behavior have direct pass/fail outcomes. |
| AC 粒度合适 | pass | Criteria cover the API and UI decision points without prescribing every implementation statement. |
| 与 design.md 目标对应 | pass | Each goal has one or more criteria. |
| Must-Not-Break 业务语义保留 | pass | Existing local history projection, active conversation and Agent stream invariants remain explicit. |

### Compatibility — Existing Consumers

| Check | Result | Notes |
|---|---|---|
| Existing API consumers identified | pass | Search found the renderer history call in AgentChatPage as the current consumer. |
| Response change is bounded | pass | Only that consumer is updated with the messages/hasMore page shape; message fields remain unchanged. |
| Existing local bridge and authorization preserved | pass | The endpoint still runs through window.teachforge.request and existing main/preload security checks. |
| Model history remains complete | pass | Paging affects only visible Renderer reads; AgentService/ConversationsService turn restoration is unchanged. |

## Findings

### Over-design / risk findings

- None found. The design does not introduce new state infrastructure, storage, or generic pagination.

### Suggested cuts (thinner design)

- None. The API metadata and stable cursor are required to avoid a misleading or incomplete “view earlier” affordance.

### Worth keeping (surprising but justified now)

- Query up to 31 visible text messages and return at most 30, so hasMore is accurate without a speculative empty fetch.
- Keep the existing sticky ViewportFooter so assistant-ui can account for composer height during auto-scroll; constrain the ancestor height instead of replacing the runtime primitive.

## Developer Decision

- Decision: approved (PASS; no confirmation gate required)
- Reason / accepted cuts: The scope matches the request and reuses existing boundaries.
- Confirmed at: 2026-11-07

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | PASS permits implementation after the Acceptance Criteria Review is approved. |

