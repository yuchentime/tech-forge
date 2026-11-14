---
status: implemented
layer: change
domain: learn-notes
created_at: 2026-11-14
version: 1.0
acceptance_review_status: approved
---

# Learn Notes Rename Verification

## Test Layer Taxonomy

- **L1 — Local Logic Verification**: code inspection/build checks for renamed symbols and route wiring.
- **L2 — Automated Real-World Verification**: application migration against the configured SQLite database and schema/data inspection.
- **L3 — Human-Aided Verification**: not required for this rename.

## Acceptance Criteria（代码级验收规则）

### AC-01 Migration preserves saved rows and relational constraints

| 要素 | 内容 |
| --- | --- |
| 代码位置 | Existing `FocusItems1794070000000` / `FocusItemNote1794080000000` / `StudyNotes1794090000000` migration chain; `buildDatabaseOptions()` (`migrationsRun: true`, `migrationsTransactionMode: 'all'`) |
| 前置条件 | Migration ledger contains `FocusItems1794070000000`, `FocusItemNote1794080000000`, and `StudyNotes1794090000000`; table `focus_items` exists. |
| 预期行为 | Migration 179410 creates `learn_notes`, copies all old rows and column values, removes `focus_items`, creates the renamed indexes and foreign key, and records migration success only after the transaction commits. |
| 禁止出现 | No row loss, empty replacement table, duplicate active table, broken conversation reference, or applied migration record after a failed table copy. |
| 判定方式 | Query table list, row and field equivalence, index definitions, migration ledger, and `PRAGMA foreign_key_check` in the configured SQLite database. |

### AC-02 Learn Notes API retains behavior under its renamed route

| 要素 | 内容 |
| --- | --- |
| 代码位置 | Current `FocusItemsController` at `/api/focus-items`; `FocusItemsService`; `focus-api.ts`; intended replacement route `/api/learn-notes` |
| 前置条件 | Renderer calls the list/create/update/delete operations for saved assistant excerpts. |
| 预期行为 | Controller exposes GET/POST `/api/learn-notes`, PATCH `/api/learn-notes/:id`, and DELETE `/api/learn-notes/:id`; DTO fields and existing validation, duplicate, status, note-update, and response semantics are preserved. |
| 禁止出现 | Active controller or desktop helper uses `/api/focus-items`, or saved notes are routed into `study_notes`. |
| 判定方式 | Backend/desktop build and source inspection of controller, DTO, service, and API helper. |

### AC-03 Conversation deletion and the merged timeline keep their boundaries

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `ConversationsService.delete`; `FocusPointsPage`; `StudyNotesService` |
| 前置条件 | A conversation has a saved LearnNote and a user-authored StudyNote. |
| 预期行为 | Conversation deletion removes `learn_notes` before messages and clears the StudyNote conversation association without deleting its content; the page continues merging both result lists by creation time. |
| 禁止出现 | Delete SQL refers to `focus_items`; LearnNotes deletion cascades into `study_notes` or removes its content. |
| 判定方式 | Source inspection and SQL references; existing focused tests remain available but are not run in this task. |

### AC-04 Active code and package names are synchronized

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/backend/src/focus-items/`; `apps/desktop/src/features/focus/`; `apps/backend/package.json` (`test:focus-items`) |
| 前置条件 | Rename change is applied. |
| 预期行为 | Active backend and desktop source use LearnNote/LearnNotes names, renamed files and folders, and `test:learn-notes`; user-facing copy remains “学习笔记”. |
| 禁止出现 | Active source imports from `focus-items` or `features/focus`, or refers to `FocusItem*`; historical migration filenames/classes may retain their original names. |
| 判定方式 | `rg` search and backend/desktop builds. |

## Required Automated Checks

```bash
npm run build --workspace @teachforge/backend
npm run build --workspace @teachforge/desktop
```

- [L1] Backend build checks renamed Nest exports, TypeORM entity registration, migration compilation, and imports. It is blocked by existing imports of missing `src/jobs/jobs.module` and `src/teaching/teaching.module`; the new migration compiled independently.
- [L1] Desktop build proves the renamed page/API symbols and route callers resolve.
- [L2] TypeORM migration on the real configured SQLite database proves upgrade wiring and data preservation; inspect the actual database after migration. A subsequent DataSource startup with compiled `buildDatabaseOptions()` passed, confirming the application migration runner recognizes the completed migration and does not rerun it. The full Nest `npm run start` remains blocked by the existing missing `./jobs/jobs.module` import.
  - 适用场景：用户明确要求迁移现有本地数据库。
  - 前提条件：应用未占用数据库；the current database path is `~/.tech-forge/db/teachforge.db`.
  - 预计耗时：seconds for the current local database.
  - 副作用：adds migration 179410 and replaces the saved-excerpt table in place; a pre-migration backup is retained.
  - 清理策略：no cleanup; the migration is the requested persistent change.

## Required Manual Checks

None.

## Must-Not-Break Checks

- [ ] Existing saved assistant excerpts and their optional notes remain visible in “学习笔记”.
- [ ] User-authored notes remain in `study_notes` and are unaffected by the saved-excerpt rename.
- [ ] Deleting a conversation removes its saved excerpts but retains free-text note content.

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| Upgrade an existing DB with `focus_items` rows | `learn_notes` has equivalent rows, schema constraints, and renamed indexes; old table is absent | L2 | Apply migration and inspect SQLite | Protects user data and the live FK boundary |
| Build the backend | New module/entity/API/migration imports resolve | L1 | Backend build | Catches stale symbols after directory/class renames |
| Build the desktop app | New page/helper symbols resolve and call `/api/learn-notes` | L1 | Desktop build | Keeps bundled client and local API in sync |
| Delete a conversation with both note types | LearnNotes rows are removed; StudyNote content remains with no conversation link | L1 / L2 | Code path and existing conversation deletion behavior | Preserves the two separate data lifecycles |

## Known Guardrails

- Do not run tests as part of this task; user requested the rename and database migration, not test execution.
- Do not create `~/.tech-forge/db/techforge.db`; the application resolves `teachforge.db`.
- Preserve the historical migrations and migration ledger names.

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
| --- | --- | --- |
| Create `learn_notes` empty and leave old rows in `focus_items` | Splits reads and writes and strands existing notes | Copy all rows and replace the table atomically |
| Rename only the SQLite table | Leaves the active entity, service, API, route, and deletion SQL inconsistent | Rename the complete active package and client path together |

## When To Read History

Not applicable.

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | The configured migration runner and 179407–179409 history confirm the append point; the live database has migration 179410, six equivalent rows, no old table, renamed indexes, a valid FK, and no integrity violations. A fresh DataSource initialization via `buildDatabaseOptions()` also passed without rerunning migrations. |
| AC-02 | pass | Existing controller, DTO, service, and desktop helper define all current fields/status/error behavior; the renamed route is implemented in the controller and desktop helper, and the desktop build passed. |
| AC-03 | pass | Existing deletion SQL removes `focus_items` before messages and nulls `study_notes.conversationId`; the merged page reads both APIs independently. |
| AC-04 | pass | Active source search confirms the renamed module, files, API calls and package script; historical migration names are retained. Desktop build passed. |

- 评审结论：AC 已协商一致
- 评审方 / 确认人 / 时间：Codex implementation review / 2026-11-14
