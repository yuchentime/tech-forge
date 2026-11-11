---
status: implemented
layer: backend
domain: chat-attachments
canonical_for:
  - attachment-conversion-naming
  - attachment-image-input
related:
  - docs/current/platform/agent-runtime.md
  - docs/current/domains/conversations/api-contract.md
last_verified: 2026-11-11
---

# 会话附件：同名转换与图片输入

## 目标

1. 需要转换的 PDF/DOCX 产物沿用源文件主名（`lesson.docx` → `lesson.md`），不再统一写 `text.md`。
2. 聊天附件支持图片（PNG/JPEG/GIF/WebP），随本轮消息作为视觉输入交给 `deepseek-flash`。

## 关键决策

| 决策 | 原因 |
|---|---|
| 转换产物命名为 `<主名>.md`，Markdown/TXT 保留原文件 | 同一目录下可直观对应源文件；避免多余副本 |
| 图片走 DeepSeek 兼容的内联 `image_url`（base64），不做 Files API 上传 | Pi SDK 的 OpenAI 兼容 provider 只序列化 `image_url`；`file_id` 需要 `file` 内容块，现有 provider 无法发出。附件只在一轮使用，Files API 的复用收益不存在 |
| 单张图片 ≤ 32 MiB，单轮图片原始字节合计 ≤ 32 MiB | provider 单图内联上限 32 MiB；base64 膨胀 4/3 后约 42.7 MiB，仍低于 48 MiB 请求体上限 |
| 按内容嗅探格式，与扩展名不符视为 `unreadable` | provider 按真实内容判断格式；提前失败比让模型收到损坏输入更清晰 |
| `LlmRequestOptions.images` 只承载本轮图片，不进入 `promptContext` | 文本上下文保持可缓存的纯文本；图片由 Pi 放进 user 消息 |
| 快照保存前丢弃 user entry 里的 `image` 块 | 否则每轮会重发并重复计费；后续轮仍可用 `read` 重新查看原图 |
| 会话附件使用独立的桌面文件选择器 | 知识库导入仍只接受文档，避免在知识库视图里提供无法入库的图片 |
| `contextRefsJson.attachments` 增加 `kind: 'text' \| 'image'` | 指针需要区分"共 N 字"与"图片"，历史行缺省时按文本处理 |

## 影响范围

- 后端：`attachments`（存储、图片编码、可读路径）、`platform/document-parser`（`requiresExtraction` 契约）、`llm`（`images` 选项、模型图片能力、快照清洗）、`conversations`（附件引用 `kind`）、`chat`（上下文渲染与图片透传）。
- 桌面：`chat:pick-attachments` IPC、preload/bridge 方法与输入区选择器。
- 文档：`current/platform`、`current/domains/conversations`、`manifest.yaml`。

## 非目标

- 不引入 DeepSeek Files API 上传与文件生命周期管理。
- 不把图片写入知识库或向量索引。
- 不改变历史接口的 `{attachmentId, name}` 投影。
