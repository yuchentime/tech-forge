---
status: draft
layer: change
domain: documents
created_at: 2026-11-08
---

# 知识库管理 Brief

## Problem

资料入库（`DocumentsService.ingestFile`）与检索（`RetrievalService` + `search_documents`）都已实现，但**没有任何 HTTP 端点或桌面入口**：

- 入库只能手工跑 `npm run verify:document-ingest -- <file>`。
- 已入库资料在桌面端不可见、不可删。
- 用户无法把自己的 PDF/DOCX/Markdown/TXT 交给 Agent 检索。

`docs/current/domains/documents/index.md` §7 把"上传 API 与 Renderer 入口"列为未实现项。

## Decision / Scope

在既有侧栏"新建课题"下方增加**知识库**视图，提供资料列表、导入资料、删除资料三条能力：

| 能力 | 实现路径 |
|---|---|
| 资料列表 | `GET /api/documents` → `DocumentsService.listDocuments()` |
| 导入资料 | Electron 原生文件选择器 → `POST /api/documents/import { filePath }` → 复制进 `<workspace>/knowledge/<documentId>/` → `DocumentsService.ingestFile()` |
| 删除资料 | `DELETE /api/documents/:documentId` → 事务删库 + 删两份文件副本 |

`workspace` 路径取自 `SettingsService.getWorkspacePath()`，即 `~/.tech-forge/config.toml` 的 `[workspace].path`。不新增表、不新增迁移、不改检索与 Agent 侧逻辑。

## Out Of Scope

- 版本管理 UI（`ingestFile({ documentId })` 追加版本已实现，但本次不暴露为目标资料）。
- 导入进度条 / SSE 进度流 / 后台 Job 队列（`jobs` 模块仍为空壳）。
- 资料标题编辑、标签、集合、会话资料关联（`conversation_documents` 仍不写入）。
- 扫描件 OCR、表格还原；由解析适配层负责。
- 索引重建 / 换模型重嵌入入口。

## Acceptance 概要

- 侧栏"新建课题"下方出现"知识库"，点击切换主区域，再点对话或"设置"可切回。
- 支持 `pdf/docx/md/markdown/txt`；其它扩展名在选择器与后端双向拒绝。
- 导入成功后：文件存在于 `<workspace>/knowledge/<documentId>/<原文件名>`，数据库状态为 `ready`（向量失败时 `indexed` + 警告），列表可见。
- 重复内容再次导入返回 `duplicate: true`，不新增行，也不在 workspace 留下多余副本。
- 删除后：`documents` / `document_versions` / `document_chunks` / `chunk_search_terms` / `chunk_fts` / `chunk_embeddings` / `conversation_documents` 均无残留，两份文件副本删除，检索不再命中。
- 处理中的资料（`parsing` / `chunking`）拒绝删除，返回 409。

详细设计见 [设计文档](design.md)。
