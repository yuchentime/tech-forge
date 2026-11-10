---
status: draft
layer: change
domain: knowledge-profile
created_at: 2026-11-10
---

# 会话知识掌握卡片 Tasks

## Preconditions

- [x] Design Review verdict is `PASS`.
- [x] API response fields and lifecycle are identified.
- [x] Current API and conversation-navigation boundaries are known.

## Tasks

1. [x] Add knowledge card response types.
2. [x] Add the initial mock route to `RehearsalsController`; the page now consumes the facts collection API.
3. [x] Add a typed desktop API client and the two-column card page.
4. [x] Add the sidebar entry and route conversation jumps through the existing handler.
5. [x] Update current knowledge-profile docs and manifest routing.
6. [x] Review the final diff and report checks not run.
7. [x] Change the existing cards API item schema to `{ conversationId, fact }` while preserving its route and envelope.
8. [x] Validate nested fact payloads and map them to the existing card presentation.
9. [x] Update v2 acceptance criteria, design review and current API documentation.
10. [x] Move long fact details into a separate page with a top-left back action and preserve the list position.
11. [x] Load the lightweight facts collection for cards and fetch one conversation's full fact only after opening details.

## Verification Commands

Automated commands are intentionally not run unless requested. Planned checks:

```bash
npm run build:backend
npm run build --workspace @teachforge/desktop
```

## Completion Checklist

- [x] Code behavior matches design.
- [x] Current docs reflect final behavior.
- [x] `docs/manifest.yaml` routes the new feature.
- [x] No task-only document is routed as required runtime context.
