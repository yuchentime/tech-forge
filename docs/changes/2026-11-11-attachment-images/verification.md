---
status: current
layer: backend
domain: chat-attachments
last_verified: 2026-11-11
---

# 验收

| 项 | 期望 | 证据 |
|---|---|---|
| 转换命名 | `lesson.docx` 复制原件并生成 `lesson.md`，不生成 `text.md`；指针指向 `lesson.md` | `test/chat-attachments.test.cjs` · `a binary document keeps its original and gains an extracted text copy` |
| 文本不转换 | Markdown 只保留原文件，无 `text.md`；指针指向原文件 | 同上 · `an attachment is copied into the conversation session directory` |
| 图片存储 | PNG 复制到会话目录，无文本副本；`stored.images` 带 `image/png` 与 base64；指针指向原图 | 同上 · `an image attachment is stored, encoded and pointed at its own file` |
| 图片视觉输入 | 本轮 `LlmRequestOptions.images` 携带图片，`promptContext` 列出图片文件名 | 同上 · `a chat turn sends attached images as vision input` |
| 失败分类 | 缺失 → `missing`；不支持的扩展名 → `unsupported`；伪装成 PNG 的文本 → `unreadable`，三种引用都保留 | 同上 · `an unreadable or unsupported attachment is reported, not fatal` |
| 快照清洗 | 当前轮与历史轮 user entry 的 `image` 块被移除，纯用户文本保留 | `test/session-entries.test.cjs` · 图片相关两条用例 |
| 文件选择器 | 聊天附件可选 PDF/DOCX/MD/TXT/PNG/JPEG/GIF/WebP；知识库导入仍只选文档 | `apps/desktop/electron/main/main.ts` 两个 IPC handler；`npm run build:electron` 与渲染层 `tsc --noEmit` 通过 |

## 命令

```text
cd apps/backend
npm run test:chat-attachments   # 8 passed
npm run test:session-entries    # 9 passed
npm run test:document-parser    # 9 passed

cd apps/desktop
npm run build:electron
npx tsc --noEmit --project tsconfig.app.json
```

## 已知限制

- 真实视觉请求需要本机 DeepSeek API Key；仓库内测试只验证到 `LlmService` 的输入契约，未向 provider 发请求。
- 超过内联限制的图片记为 `unreadable`，不自动改走 Files API。
