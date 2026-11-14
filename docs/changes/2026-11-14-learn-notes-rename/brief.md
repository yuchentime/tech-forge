---
status: implemented
layer: change
domain: learn-notes
created_at: 2026-11-14
---

# Learn Notes Rename Brief

## Problem

The saved assistant excerpts are persisted in `focus_items`, while the user-facing feature is already called “学习笔记”. Backend modules, desktop API helpers, and the route still use the old focus-item name, which makes the data model and implementation naming inconsistent.

## Decision / Scope

Rename the table to `learn_notes` with a transactional data-preserving migration. Rename the backend module/entity/DTO/service/controller, desktop feature/API/page names, and HTTP route to `learn-notes`. Keep the existing payload fields and note behavior. Apply the new migration to the runtime database at `~/.tech-forge/db/teachforge.db`.

## Out Of Scope

- Do not merge `learn_notes` with the separate free-text `study_notes` table.
- Do not change the user-visible “学习笔记” behavior or payload field names.
- Do not rewrite historical migrations already recorded in the migration ledger.
