---
status: approved
layer: change
review_type: design_review
created_at: 2026-11-10
design_path: docs/changes/2026-11-10-directory-knowledge-library/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: directory-knowledge-library

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-10-directory-knowledge-library/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: implement the handed-over directory-driven knowledge-library change.
- Design goals in scope: replace the active chunk/FTS/vector path with validated catalog entries and Agent-directed, read-only access to converted source text; retain old modules and historical data during observation.
- Design items outside ask (if any): no accounts, external network retrieval, catalog vector search, or deletion of legacy storage.

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | The developer accepted a mixed managed root; index routing remains the sole read authority. |
| No premature new abstraction layer | pass | Pi entry manipulation remains in LlmService, its existing owner; the standalone session writer port is removed. |
| No speculative generalization | warning | “Future RAG replacement” should not require an unproven generic switch now; retain narrow domain interfaces only where a current caller crosses the boundary. |
| Cross-cutting surface growth justified | pass | Catalog state, trusted path projection, and per-session Pi context are distinct responsibilities that cannot safely remain implicit. |
| Operational weight justified | pass | Existing `libraryQueue` and atomic replacement avoid introducing a job system or an external queue. |
| Alternatives Considered includes a simpler option | pass | The design rejects context-file catalog injection, global directory reads, and automatic legacy backfill. |
| Touch/complexity budget reasonable | pass | The change spans storage, SQLite, Pi session snapshots, file tools, chat, UI, and a bundled skill, but its storage and session ownership contracts are now explicit. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | Extending `document_versions` is preferable to adding another catalog table for a one-to-one version property. |
| Alterations / migrations scoped | pass | New catalog columns are named; legacy `indexed` remains read-compatible and the list/read projection stays owned by DocumentsService. |
| Cross-domain FK / shared tables justified | pass | No new FK or shared table is proposed. |
| Rollback / backfill cost acceptable | pass | Explicit rebuild avoids surprise provider cost; index remains a rebuildable database projection. |
| No speculative schema for unused futures | pass | The proposed fields support the immediate catalog only. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 through AC-09 are present. |
| AC 代码接地 | pass | Current anchors such as `SettingsService.initializeFiles`, `DocumentsService.importFromPath`, `ChatService.stream`, and Pi APIs exist; new components have defined owners and composition boundaries. |
| AC 可判定 | pass | The index is the sole source for a canonical converted-Markdown whitelist; binary originals in the same root remain unreadable. |
| AC 粒度合适 | pass | The ACs focus on trust boundaries, lifecycle, and production-path removal rather than method-by-method implementation. |
| 与 design.md 目标对应 | pass | Catalog creation, atomic projection, command semantics, legacy isolation, and research behavior are covered. |
| Must-Not-Break 业务语义保留 | pass | Snapshot hygiene, protected settings, tool isolation, and rehearsal separation are explicit. |

## Findings

### Over-design / risk findings

- Resolved: the developer approved a mixed `<configDir>/knowledge` root. Index parsing, rather than directory shape, defines the only Agent-readable converted Markdown; source binaries remain outside the whitelist.
- Resolved: LlmService remains the owner of Pi session entries and snapshot restoration. The coordinator supplies revision/text only; LlmService identifies prior `knowledge_index` custom entries in restored entries before issuing `context_edit`.

### Suggested cuts (thinner design)

- Keep index-derived canonical-path validation as the only exception to the knowledge-root read deny rule.
- Keep Pi session manipulation in LlmService rather than adding a second session-state owner.

### Worth keeping (surprising but justified now)

- Fixed `AGENTS.md` loaded through an override, not discovery: it preserves the system instruction boundary while still making the policy auditable.
- Atomic rebuilding of the catalog from database state: deletion and retries otherwise make the catalog untrustworthy.
- Retaining legacy retrieval modules without production callers: necessary for the requested observation period and historical data compatibility.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: developer chose a mixed managed knowledge root, routed exclusively by index; Pi context ownership remains in LlmService.
- Confirmed at: 2026-11-10

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | Implementation may proceed after the Acceptance Criteria Review is approved. |
