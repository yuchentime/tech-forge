---
status: current
layer: change
domain: agent-runtime
canonical_for:
  - chat-attachment-verification
last_verified: 2026-11-09
version: 1.0
---

# 会话附件验收

集成测试使用真实 Nest 模块图（`ChatModule` + `AttachmentsModule`）、真实 SQLite、真实解析器与临时工作空间；模型用记录型桩替代。

## AC

| AC | 断言 | 证据 |
|---|---|---|
| AC1 落盘 | 原文件落在 `<configDir>/sessions/<conversationId>/attachments/<attachmentId>/<原名>`，解析正文写到同目录 `text.md`，引用记录 `characters` | `test/chat-attachments.test.cjs` · `an attachment is copied into the conversation session directory` |
| AC2 单份失败不拖垮整轮 | 不存在的文件记为 `missing`、不支持的扩展名记为 `unsupported`，其余附件仍正常；两个引用都保留 | 同上 · `an unreadable or unsupported attachment is reported, not fatal` |
| AC3 全文注入 | `ChatService.stream(..., [id])` 的模型请求中 `prompt` 仍是用户原话、`promptContext` 含正文与"本轮用户附加的文件"抬头 | 同上 · `a chat turn injects the full attachment text and keeps only the reference` |
| AC4 只存引用 | user 行 `contextRefsJson.attachments = [{attachmentId, name}]`，历史接口返回同一组引用，`content` 仍是用户输入文本 | 同上 |
| AC5 注入上限 | 42k 字附件被截到 40k 并带"本轮只提供开头"说明；第二份文件因没有余量整体跳过并列出文件名 | 同上 · `attachment text beyond the injection limit is cut, and later files are skipped` |
| AC6 后续轮指针 | 同一会话第二轮不带附件时，注入内容只有"本会话可读取的附件"指针（`text.md` 绝对路径、总字数、已注入字数），正文不重复注入 | 同上 · `a later turn points the model at the stored attachment text instead of re-injecting it` |
| AC7 快照清洗 | 保存快照前只替换最后一条 user 消息的 `message.content`，保留 `id` / `parentId` / `timestamp`；非注入消息保持不变 | `test/session-entries.test.cjs` · `the snapshot keeps only the user text, never the injected context` |

## 回归

| 命令 | 结果 |
|---|---|
| `npm run test:chat-attachments`（backend） | 5/5 通过 |
| `npm run test:session-entries`（backend） | 2/2 通过：快照只保留用户原话，id/parentId 不变 |
| `npm run test:conversation-history`（backend） | 5/5 通过 |
| `npm run test:knowledge-context`（backend） | 11/11 通过 |
| `npm run test:conversation-history`（desktop） | 10/10 通过 |
| `tsc --project tsconfig.build.json --noEmit`（backend） | 通过 |
| `tsc --noEmit --project tsconfig.app.json` / `tsconfig.electron.json`（desktop） | 通过 |
| `npm run build:renderer`（desktop） | 通过 |

## 未覆盖

- **真实 Electron 窗口目视验收**：输入区标签、气泡内标签只经过类型检查与打包。
- **真实模型回答质量**：桩只证明正文进入了请求。
- **大文件**：没有用 300 页级 PDF 验证"全文注入"的实际上限；这正是设计里接受的风险。
- **PDF/DOCX 解析**：测试只覆盖 Markdown/TXT，解析器本身由 `test:document-parser` 覆盖。
