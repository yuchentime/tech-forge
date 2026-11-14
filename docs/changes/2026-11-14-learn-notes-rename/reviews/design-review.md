---
status: passed
layer: change
review_type: design_review
created_at: 2026-11-14
design_path: docs/changes/2026-11-14-learn-notes-rename/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: learn-notes-rename

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-14-learn-notes-rename/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

The developer asked to rename `focus_items` to `learn_notes`, synchronize related filenames and package names, and create/migrate the table in the local SQLite database. The design renames the active backend and desktop contract, preserves the independent `study_notes` model, and migrates the database the application actually opens.

- Original ask: rename the saved-excerpt table and its related file/module names, then migrate the local database.
- Design goals in scope: data-preserving transactional migration, backend and desktop name/route synchronization, and application of the migration to `~/.tech-forge/db/teachforge.db`.
- Design items outside ask: user-facing behavior redesign, payload changes, free-text note schema changes, and database file rename.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | Active saved-excerpt names and route change together; user-facing flow and `study_notes` remain unchanged. |
| No premature new abstraction layer | pass | Reuses existing Nest module, controller, service, entity, TypeORM migration runner, and desktop feature boundary. |
| No speculative generalization | pass | No aliases, dual writes, generic repository, or shared note framework is added. |
| Cross-cutting surface growth justified | pass | The current renderer calls the local backend path directly through its typed helper; both ends must change together. |
| Operational weight justified | pass | One schema migration is required; it uses the existing transactional startup migration mechanism. |
| Alternatives Considered includes a simpler option | pass | In-place rename and empty parallel table are considered and rejected for concrete schema/data consistency reasons. |
| Touch/complexity budget reasonable | pass | Changes are limited to the saved-excerpt feature, its desktop integration, conversation cleanup, migration, and owning docs. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | `learn_notes` replaces the old saved-excerpt table; no additional table is introduced. |
| Alterations / migrations scoped | pass | One migration after 179409 copies the existing columns and rows and rebuilds the three indexes and FK name. |
| Cross-domain FK / shared tables justified | pass | Existing `conversationId` relation to `conversations` remains unchanged. |
| Rollback / backfill cost acceptable | pass | Up/down both copy all columns in the configured migration transaction; backup retained before applying to the local DB. |
| No speculative schema for unused futures | pass | No columns, relations, or indexes are added beyond matching the existing schema under the new name. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 through AC-04 cover migration, API behavior, adjacent deletion/timeline behavior, and active naming. |
| AC 代码接地 | pass | Criteria reference current `buildDatabaseOptions`, focus-item API/service boundaries, `ConversationsService.delete`, the existing desktop page, and the selected migration path. |
| AC 可判定 | pass | Schema, SQL, route, build, and source-reference outcomes are directly inspectable. |
| AC 粒度合适 | pass | Each criterion tests one boundary without describing method-level pseudocode. |
| 与 design.md 目标对应 | pass | Every rename/migration goal maps to an acceptance criterion. |
| Must-Not-Break 业务语义保留 | pass | Excerpt anchoring, idempotency, optional notes, timeline merge, and free-text note retention are explicit. |

## Findings

### Over-design / risk findings

- None blocking. Historical migration names intentionally remain unchanged so deployed databases retain a valid migration ledger.

### Suggested cuts (thinner design)

- Do not add a compatibility alias for `/api/focus-items`; the only current client is bundled with this local application and will switch in the same change.

### Worth keeping (surprising but justified now)

- Rebuilding the table inside the existing migration transaction makes the FK and indexes match `learn_notes` while keeping the prior rows and note values. This is more complete than `ALTER TABLE RENAME` for the requested naming synchronization.
- Keeping `study_notes` separate preserves the existing distinction between anchored assistant excerpts and user-authored free text.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: PASS; the design matches the requested table/module rename and protects the independent StudyNote lifecycle.
- Confirmed at: 2026-11-14

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | Architecture, data model, and AC quality pass. Strict AC-to-code review is recorded as approved in `verification.md` before implementation. |
