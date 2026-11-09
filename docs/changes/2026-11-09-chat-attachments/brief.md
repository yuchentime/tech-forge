---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-09
---

# 会话附件 Brief

## Problem

Agent 输入区只能发文字。用户手里有一份讲义/论文，想就它提问，只能先导入资料库再手写 `/查询资料库`，而检索只按问题挑 8 个分片，无法覆盖"帮我总结这份讲义"这类请求。

同时有一个界面约束：解析出的正文不能出现在聊天气泡里。用户只上传了一个文件加一段话。

## Decision / Scope

先做最小可用版本：

1. 发送时把附件复制进 `~/.tech-forge/sessions/<conversationId>/attachments/<attachmentId>/`（会话隔离，不进资料库、不进 workspace）。复制发生在发送时，因为新会话在这一刻之前没有 ID。
2. 解析正文写到同目录 `text.md`。本轮把它的开头（≤ 40000 字符）拼进 user message，与用户输入一起发送；不进入 system prompt，也不分块/检索。
3. 消息行只保留 `{attachmentId, name, characters, injectedCharacters}` 引用，历史接口只下发 `{attachmentId, name}`；UI 以标签形式附着在用户气泡内。正文不进入 SSE、不进入历史接口。
4. 附件**不进资料库**：没有 `documents` 行、没有向量、没有共享标记、没有会话范围。

## Out Of Scope

- 附件入库、向量化、分片、检索、`conversation_documents` 关联。
- token 预算、前缀截断、大纲、多形态渲染。
- 让模型调用 `read`/`grep` 去读附件。
- 附件删除、替换、去重、跨会话复用。

## Acceptance 概要

- 选一份 md 发送：模型请求里出现全文，聊天气泡只显示一个文件标签。
- 历史重新加载后标签仍在（按持久消息 ID 恢复）。
- 文件落在 `~/.tech-forge/sessions/<会话ID>/attachments/<附件ID>/` 下，按会话隔离。
- 附件被移走时，本轮给出"内容已不可用"的说明而不是空白。

## 验证

见 [verification.md](verification.md)。
