---
status: draft
layer: change
domain: conversations
created_at: 2026-11-07
---

# Agent Chat Layout and History Pagination Tasks

## Preconditions

- [x] Design Review verdict is PASS.
- [x] Conversation and Agent Runtime current docs are identified.
- [x] Build and visual verification targets are known.

## Tasks

1. [x] Keep automated test additions/runs out of scope under the task constraint; use build and visual checks.
2. [x] Implement fixed-size paged history in the existing Conversations query path.
3. [x] Update the desktop request/response handling and prepend earlier history.
4. [x] Remove outer shell and constrain scrolling to the sidebar list and message viewport.
5. [x] Update current conversation and platform docs plus manifest.
6. [x] Run build checks and inspect visual layout at desktop and narrow widths.

## Verification Commands

~~~bash
npm run build:renderer --workspace @teachforge/desktop
npm run build --workspace @teachforge/backend
~~~

## Completion Checklist

- [x] Code behavior matches design.
- [x] Automated tests were not added or run under task constraints; build and visual checks are recorded.
- [x] Current docs reflect final behavior.
- [x] Historical or superseded docs are marked if any were affected; none were superseded by this change.
- [x] No task-only document is routed as required runtime context.

