---
status: current
layer: change
review_type: design_review
created_at: 2026-11-10
design_path: docs/changes/2026-11-10-knowledge-session-cards/design.md
verdict: PASS
confirmation_status: approved
version: 3.0
---

# Design Review: knowledge-session-cards

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-10-knowledge-session-cards/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: Implement the approved simple session-card design, define a mock API schema in `RehearsalsController`, show complete assessment summaries with on-demand details, and keep a separate conversation entry point. Follow-ups selected reuse of `{ conversationId, fact }` for the existing cards API, then requested a separate detail page with a top-left return action.
- Design goals in scope: Preserve the current mock route and `{items}` envelope; reuse the conversation-fact item schema; join titles in the renderer; map fact mastery and assessment timestamps to the grid; move long details into a separate view with a top-level back button; retain the card list position and existing conversation navigation.
- Design items outside ask: Persistent aggregate data, time decay, Markdown rendering, evaluation generation, and database changes.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | The design changes only the card detail presentation; API, data ownership, card summary and navigation remain as approved. |
| No premature new abstraction layer | pass | No new service framework or persistence layer; uses existing controller, bridge, and React feature boundary. |
| No speculative generalization | pass | Schema fields are limited to the current card UI. |
| Cross-cutting surface growth justified | pass | One backend contract and one renderer feature are required for the requested card view. |
| Operational weight justified | pass | No queue, cache, migration, or third-party dependency. |
| Alternatives Considered includes a simpler option | pass | Design rejects a new database model and chat-stream embedding. |
| Touch/complexity budget reasonable | pass | The UI adjustment is scoped to local state and view composition in the existing knowledge-profile page plus current docs. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | No new table is introduced for mock data. |
| Alterations / migrations scoped | pass | No schema migration. |
| Cross-domain FK / shared tables justified | pass | No cross-domain persistence or FK is introduced. |
| Rollback / backfill cost acceptable | pass | Static mock data and additive UI/API can be removed without data migration. |
| No speculative schema for unused futures | pass | No inferred knowledge graph or long-term profile entity. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 through AC-04 cover reused fact schema, ordering, card mapping, and navigation. |
| AC 代码接地 | pass | `RehearsalsController.getKnowledgeCards` is the existing route; `KnowledgeProfilePage` and its API helper own mapping; navigation targets the existing conversation loader. |
| AC 可判定 | pass | Expected fields, ordering, detail-page transition/return, and allowed side effects are stated explicitly. |
| AC 粒度合适 | pass | Criteria cover key API/UI boundaries without prescribing method-by-method implementation. |
| 与 design.md 目标对应 | pass | Each goal has a corresponding acceptance criterion. |
| Must-Not-Break 业务语义保留 | pass | Existing conversation recovery and rehearsal routes remain explicit constraints. |

### Permission / Data Ownership

| Check | Result | Notes |
|---|---|---|
| Local-only data boundary preserved | pass | Requests use the existing protected local bridge; no new data leaves the device. |
| Mock state clearly bounded | pass | Mock evaluation values are explicitly presented as prototype data and are not persisted. |

## Findings

### Over-design / risk findings

- Mock values may not match actual rehearsal results; the prototype must keep that limitation clear.

### Suggested cuts (thinner design)

- No further cuts required. The previously considered seven-day decay and ignored state remain excluded. The list stays mock-only and does not implement fact persistence or generation.

### Worth keeping (surprising but justified now)

- Keep `conversationId` as the stable list-item identity and title lookup key; it also targets the existing conversation recovery path.
- Keep `lastAssessedAt` for within-group ordering; `generatedAt` describes publication and does not drive mastery ordering.
- Keep the card list mounted while the detail view is active so returning preserves the reader's list position without adding a routing layer.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: PASS gate; the scope contains three fixed mastery states and no time-decay behavior. The v3 UI change adds no data or routing layer.
- Confirmed at: 2026-11-10

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | v3 design review and AC strict review are recorded in `verification.md`; implementation may proceed under the user's explicit detail-page feedback. |
