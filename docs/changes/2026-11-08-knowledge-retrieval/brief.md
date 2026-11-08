---
status: draft
layer: change
domain: knowledge-retrieval
created_at: 2026-11-08
---

# 本地知识库检索 Brief

## Problem

TeachForge 已有资料实体（`documents` / `document_versions` / `document_chunks` / `conversation_documents`）和已设计的解析适配层（v1 文本层提取，可替换为 MinerU），但没有分块、索引和检索流程。`retrieval`、`knowledge`、`embedding` 三个 Service 是空壳，上传的资料无法被 Agent 用作回答依据，也无法引用到具体章节。

此前评估过托管检索服务（Supermemory）作为替代：其自托管形态在 Windows 上只到 0.0.8（v5 API 需 0.9+，须依赖 Docker Linux 容器），二进制闭源且遥测默认开启，embedding 模型受维度锁死约束，引用粒度只到 chunk 无页码。不满足"本地优先、教材正文不出本机、Windows 桌面可直接安装"的要求，已否决。

## Decision / Scope

自建全本地检索栈，中文为主（约 9 成）、英文兼容：

| 组件 | 技术 | 作用 |
|---|---|---|
| 文本归一化 | 自研纯函数（NFKC + Han bigram + ASCII 分词） | 让 FTS5 对中文可用 |
| 关键词检索 | SQLite FTS5（`unicode61` + porter 词干化） | BM25 排序 |
| Embedding 推理 | `@huggingface/transformers` + `onnxruntime-node`（CPU EP） | Node 进程内本地推理 |
| 向量模型 | `Xenova/bge-small-zh-v1.5`（q8，512 维，22.9 MB） | 中文语义召回 |
| 数据存储 | `better-sqlite3`（现有 TypeORM 连接） | 本地持久化，向量存 BLOB |
| 融合 | RRF（k=60） | 合并 BM25 与余弦排名 |
| 向量检索加速 | 暂不引入 `sqlite-vec` | 当前规模暴力扫描 8.6 ms，无需 ANN |

范围：入库分块与索引写入、范围过滤、双路检索与融合、引用数据结构、索引代际切换与降级。不包含 Agent 侧自动检索编排与 UI，另立变更。

## Out Of Scope

- LLM wiki、知识图谱、跨会话记忆抽取、用户画像。
- 交叉编码器重排（rerank），仅在检索评估显示召回不足时再评估。
- `sqlite-vec` 虚拟表；保留 BLOB 暴力扫描，达到触发条件再换。
- OCR 与版面解析；由文档解析适配层负责。
- 任何 HTTP/SSE 契约变更与桌面端页面。

## Acceptance 概要

- 中文查询可在 FTS5 命中，包含 2 字词查询，英文词走词干化。
- 中文语料上双路 + RRF 优于任一单路（由本地 gold set 消融证明）。
- 检索结果带 `documentId`、`versionId`、章节标题与页码定位，能写回 `messages.contextRefsJson`。
- 向量不可用（模型缺失/加载失败/编码未完成）时退化为 FTS 单路，检索不失败。
- 全流程在断网、无第三方账号的环境下可用。

详细设计见 [设计文档](design.md)。
