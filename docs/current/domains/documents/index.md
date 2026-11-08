---
status: current
layer: domain
domain: documents
canonical_for:
  - document-ingest-behavior
related:
  - docs/current/index.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/domains/retrieval/index.md
  - docs/changes/2026-11-08-document-parser-adapter/design.md
  - docs/changes/2026-11-08-knowledge-retrieval/design.md
last_verified: 2026-11-08
---

# 资料入库当前事实

本页描述已经由代码与测试验证的入库行为：本机文件 → 解析 → 分块 → 词法索引 → 向量 → `ready`。目标或未实现的能力单独标注。

## 1. 入口

- Nest Provider：`DocumentsService.ingestFile({ filePath, documentId?, title?, isShared?, signal? })`。
- **没有 HTTP 端点、没有上传 UI**；手工入口是 `npm run verify:document-ingest --workspace @teachforge/backend -- <file>`。
- `filePath` 必须是绝对路径的普通文件；扩展名决定解析器，不支持的格式在创建任何数据库行之前就被拒绝。

## 2. 解析

调用 `platform/document-parser`（不归 Documents 域所有）：

| 格式 | 实现 | 结果 |
|---|---|---|
| PDF | `pdfjs-dist` 6（ESM，经 `load-esm.ts` 加载） | 按页重建行与段落；返回 `pages[]`、`TOC_LIKE`/`MULTI_COLUMN_SUSPECTED` 等告警；无文本层抛 `NO_TEXT_LAYER` |
| DOCX | `mammoth` `convertToMarkdown` | 单页；表格被拍平并产出 `UNSTRUCTURED_TABLE`；加粗短段落提升为 `##` 伪标题 |
| MD / TXT | 直接读取 | 单页 |

## 3. 分块

- 预算以 embedding token 计：目标与上限都是 **500 tokens**（+2 特殊 token 在 512 窗口内），重叠 **50 tokens**（10%）。
- 分词器：`@huggingface/tokenizers` + 仓库内 `apps/backend/assets/models/bge-small-zh-v1.5/tokenizer.json`，离线可用。
- 标题优先、段落回退、超长段落按 token 二分切分；`TOC_LIKE` 页的分块被跳过。
- `locatorJson` 记录 `{ headingPath, pageStart?, pageEnd?, charStart, charEnd, tokenCount }`；不变量：`chunk.content === parsed.text.slice(charStart, charEnd)`。
- 单文档超过 5000 分片抛 `DOCUMENT_TOO_LARGE_FOR_INDEX`，不静默截断。

## 4. 落库与状态

一个事务写 `document_chunks` 与 `chunk_search_terms`（FTS5 由触发器同步），随后另一个阶段写 `chunk_embeddings`。

| 状态 | 含义 |
|---|---|
| `parsing` | 已写文档/版本行，解析进行中 |
| `chunking` | 解析完成，分块与词法写入进行中 |
| `indexed` | 分片与词法索引已提交，可全文检索；embedding 失败时停在此状态并写 `processingError = EMBEDDING_FAILED: …` |
| `ready` | 向量也已提交 |
| `failed` | 解析或分块失败，`processingError` 记录原因，不产生分片 |

- 幂等键是文件内容的 SHA-256：同一内容重复提交返回 `duplicate: true`，不新增行。
- 同一份资料的历史版本需显式传 `documentId`，`versionNo` 自增，旧版本分片保留。
- 源文件被复制到 `<dataDir>/documents/<documentId>/v<versionNo>/<originalName>`，`workspaceRelativePath` 相对数据目录保存。

## 5. 读取模型

| 方法 | 返回 |
|---|---|
| `listDocuments()` | 文档列表 + 最新版本号、状态、分片数 |
| `getDocumentDetail(documentId)` | 全部版本及各自分片数、错误 |
| `listVersionChunks(documentVersionId)` | 按 `sequenceNo` 升序的分片 |

## 6. 迁移与依赖

- `1793950000000-chunk-search-index.ts`：`chunk_search_terms` + `chunk_fts`（external content）+ insert/delete 触发器。
- `1793960000000-chunk-embeddings.ts`：`chunk_embeddings`（行级 `embeddingModel`/`embeddingDim` 戳记）。
- 运行时依赖：`pdfjs-dist`、`mammoth`、`@huggingface/tokenizers`、`@huggingface/transformers`；模型与分词器随仓库分发，运行时不联网。

## 7. 未实现

- 上传 API 与 Renderer 入口。
- `conversation_documents` 关联（会话资料范围）。
- 扫描件 OCR、表格结构还原（仅告警）。
- 索引重建/重嵌的运维入口（换模型目前只能整库重灌）。

## 8. 实测（2026-11-08，win32 x64）

| 样本 | 结果 |
|---|---|
| `AI-Agents-in-Depth-zh-CN.pdf`（11 MB / 313 页） | 961 分片，入库 41.9 s（含向量），`ready` |
| `AI员工平台_作业背景文档_脱敏版_v1.docx`（50 KB） | 55 分片，289 ms |
| 分片 token | p50 = 461、max = 500；重叠上限 50 tokens 零违规 |
