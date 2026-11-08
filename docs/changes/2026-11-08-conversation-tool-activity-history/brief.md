---
status: implemented
layer: change
domain: conversations
created_at: 2026-11-08
---

# Conversation Tool Activity History Brief

## Problem

Tool activity is visible while a turn is running, but selecting another conversation and returning restores only user and assistant text. Persisted tool execution rows are not part of the history response, and the renderer does not rebuild its activity snapshot from history.

## Decision / Scope

Return bounded, safe tool activity summaries nested under each user message in its turn. Group persisted `toolExecution` rows by their sequence range, preserve only the tool name, status, duration, and a safe display path, and hydrate the desktop activity bus when a history page is loaded.

## Out Of Scope

- Exposing raw tool arguments, partial output, results, or Pi `toolResult` messages to the renderer.
- Changing conversation message pagination, the live SSE stream, or persistence recovery semantics.
- Adding a database table or migration for turn-to-tool linkage.
