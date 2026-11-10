---
status: draft
layer: change
domain: directory-knowledge-library
created_at: 2026-11-10
---

# 目录驱动的自主资料库查阅简报

## Problem

当前资料库在用户输入 `/查询资料库` 或 `/探索主题` 后，由后端把向量与全文检索得到的分片直接注入模型。本机个人资料库的主要规模预计为几十至数百份文档；用户希望模型能先浏览由资料摘要组成的目录，再按问题读取原始转换文本，并能在没有命令时自主决定是否查阅。

现有资料副本已在 `<configDir>/knowledge/`，但该目录被文件工具默认拒读；`LlmService` 也关闭了 Pi context-file discovery。因此仅要求模型读取 `index.md` 既不能通过授权边界，也不会在运行时形成稳定的查阅策略。

## Decision / Scope

以默认 `~/.tech-forge/`（受 `TEACHFORGE_CONFIG_DIR` 覆盖）为根：创建一次性、可人工查看的 `AGENTS.md`，把固定的资料查阅策略经 `DefaultResourceLoader.agentsFilesOverride` 载入；每份成功导入的资料用已配置 Provider 生成不超过 200 字符的结构化摘要，并由后端把受校验的条目写入 `<configDir>/knowledge/index.md`。

普通对话由模型在固定策略下决定是否读取目录和可读文本副本；PDF/DOCX/PPT 等指向转换后的 Markdown，Markdown/TXT 等原生文本文件直接指向自身。`/查询资料库` 及 `/探索主题` 是显式资料库请求，后端直接把 `index.md` 作为本轮上下文加载，并在其后、用户问题前追加由后端生成的 `<agent_state>` 标记。停止新文档的分块、词法索引、embedding、RRF 与重排，并让 `ChatService`、slash command 和 deep-research 不再调用 `KnowledgeService.buildContext()`。保留 `knowledge/`、`retrieval/`、`embedding/` 代码与历史数据，但不再将它们集成到任何业务请求路径。

## Out Of Scope

- 不新增账号、身份、租户或跨用户资料隔离。
- 不把完整 `index.md` 或上传文件内容写入 AGENTS/system prompt；它们只能经本轮受控文件读取进入模型上下文。
- 不开放知识库目录的写入、shell、子 Agent 或任意配置文件读取能力。
- 不在本次变更中删除旧分片、FTS、向量表及其迁移，或承诺删除后的磁盘回收。
- 不将用户附件纳入目录资料库，也不改变附件按会话保存与读取的现有行为。
