---
status: implemented
layer: change
domain: conversations
created_at: 2026-11-08
---

# Chat API Rename Brief

## Problem

The backend stream module and its HTTP route use `agent` while the request is the desktop chat flow. The backend package, API contract, and Electron bridge therefore use inconsistent names.

## Decision / Scope

Rename the backend module and its files/classes to `chat`, expose the stream at `POST /api/chat/stream`, and align the Electron IPC channels, bridge method, and safe stream event type with `chat`. Preserve the request payload, SSE payloads, persistence behavior, and Pi SDK-native event names.

## Out Of Scope

- Renaming the desktop Agent feature or Pi SDK types and lifecycle event values.
- Changing chat request fields, persistence, stream behavior, or authentication.
- Keeping `/api/agent/stream` as a compatibility alias.
