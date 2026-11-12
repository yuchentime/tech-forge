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
last_verified: 2026-11-10
---

# 资料入库当前事实

本页描述已经由代码与测试验证的入库行为：本机文件 → 解析 → 分块 → 词法索引 → 向量 → `ready`。目标或未实现的能力单独标注。

## 1. 入口

- Nest Provider：`DocumentsService.ingestFile({ filePath, documentId?, title?, isShared?, signal? })`。
- HTTP（`DocumentsController`，与本机 token 同级保护）：`GET /api/documents` 列表、`POST /api/documents/import { filePath, title? }` 导入、`DELETE /api/documents/:documentId` 删除。
- 桌面端：侧栏「知识库」视图 → 「导入资料」调系统文件选择器 → 上述 import；列表显示标题、状态、分片数与导入时间，行内二次确认后删除。
- 手工入口保留：`npm run verify:document-ingest --workspace @teachforge/backend -- <file>`。
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
- 词法索引按 `heading` / `body` 两列写入：`heading` = 文档标题 + `headingPath`，`body` = 分片正文。文档标题因此成为每个分片的顶层标题词（`bm25` 权重 5.0 / 1.0）。
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
- 源文件被复制到 `<dataDir>/documents/<documentId>/v<versionNo>/<originalName>`，`workspaceRelativePath` 相对数据目录保存；`<dataDir>` 为 `TEACHFORGE_DATA_DIR`，未设置时默认 `~/.tech-forge`（SQLite 主库位于其 `db/` 子目录）。
- 转换后的正文另存为同目录的 `<baseName>.md`：仅对需要转换的格式（PDF/DOCX）写入；`.md`/`.markdown`/`.txt` 本身就是可读文本，不写第二份。内容用 `joinParsedPages`（分块器同一拼装规则），因此 `locator.charStart/charEnd` 对这份文件同样成立；写入失败只产生 `CONVERTED_MARKDOWN_FAILED` 警告，不影响入库与检索。
- 导入时另存的用户可见副本位于 `<configDir>/knowledge/<documentId>/`，与 Agent workspace 隔离。
- 界面文案不出现 `向量`、`索引`、`分片`、`embedding`、`OCR` 等内部术语：状态显示为"可以搜索 / 只能关键词搜索 / 正在读取 / 正在整理 / 导入失败"，分片数显示为"N 段"。

## 5. 读取模型

| 方法 | 返回 |
|---|---|
| `listDocuments()` | 文档列表 + 最新版本号、状态、分片数、字节数、导入时间、`processingError` |
| `getDocumentDetail(documentId)` | 全部版本及各自分片数、错误 |
| `listVersionChunks(documentVersionId)` | 按 `sequenceNo` 升序的分片 |
| `importFromPath({ filePath, title? })` | 复制到知识库目录并入库，返回 `IngestDocumentResult + storedPath`（绝对路径，位于知识库根下） |
| `deleteDocument(documentId)` | 事务清除六张表相关行，再删除两份文件副本 |


- 整篇正文不再由 documents 域重建：知识上下文只注入检索命中的分片（见 retrieval §3.2），`document_chunks` 仍是正文的唯一持久副本。
- `resolveKnowledgeScope(conversationId, explicitDocumentIds?)`：显式选择非空时只返回这些资料（覆盖默认范围）；否则会话关联资料 ∪ 共享资料，两者皆空时回退全部资料。范围判定归 documents 域，检索只消费 id 列表。
## 6. 迁移与依赖

- `1793950000000-chunk-search-index.ts`：`chunk_search_terms` + `chunk_fts`（external content）+ insert/delete 触发器。
- `1793960000000-chunk-embeddings.ts`：`chunk_embeddings`（行级 `embeddingModel`/`embeddingDim` 戳记）。
- 运行时依赖：`pdfjs-dist`、`mammoth`、`@huggingface/tokenizers`、`@huggingface/transformers`；模型与分词器随仓库分发，运行时不联网。

## 7. 导入与删除

导入（`POST /api/documents/import`）与删除（`DELETE /api/documents/:documentId`）由同一把串行队列保护，避免 embedding 的 CPU 抢占与并发写库：

| 阶段 | 行为 |
|---|---|
| 暂存 | 源文件复制到 `<configDir>/knowledge/.importing/<uuid>/<原文件名>`，`configDir` 是 `TEACHFORGE_CONFIG_DIR`（默认 `~/.tech-forge`），**不在 Agent workspace 内** |
| 入库 | 对该副本调用 `ingestFile({ isShared: true })`；重复内容返回 `duplicate: true` |
| 归位 | 成功后 `rename` 到 `<configDir>/knowledge/<documentId>/<originalName>`；重复或失败删除暂存目录 |
| 删除 | 事务内依次清 `chunk_embeddings`、`chunk_search_terms`（触发器同步 `chunk_fts`）、`document_chunks`、`document_versions`、`conversation_documents`、`documents`，提交后再删 `<dataDir>/documents/<id>` 与 `<configDir>/knowledge/<id>` |
| 拒绝 | 版本处于 `parsing`/`chunking` 时删除返回 409（`DOCUMENT_PROCESSING`）；未知资料或非法 id 返回 404 |
| 失败 | 解析或分块失败返回 422（`NO_TEXT_LAYER` 等），版本记为 `failed` 且无分片；工作空间不可写返回 500 `WORKSPACE_UNWRITABLE` |
| 错误信封 | `{ statusCode, code, message, detail }`：`message` 是中文可执行文案（渲染层直接展示），`detail` 保留技术原因，同时写 `documents.import.*` / `documents.file.cleanup_failed` 结构化日志 |
| 非阻断失败 | 删除后文件清理失败 → `fileCleanup: 'partial'`；导入成功后另存上传副本失败 → `warnings[]` 追加 `UPLOAD_COPY_FAILED`；两者都不改变数据库结论，也不会静默 |
| 失败残留 | 解析/切分失败的尝试会留下一条 `failed` 资料行（状态显示"导入失败"，可删除）；再次导入同一字节返回 `duplicate: true` + `status: 'failed'`，用户在删除前无法重试成功 |

存在的两份副本：知识库副本（`<configDir>/knowledge/<id>/`，用户可见的上传文件）与入库快照（`<dataDir>/documents/<id>/v<n>/`，`workspaceRelativePath` 相对数据目录）。删除会同时清理两者；文件删除失败不影响数据库结论。

隔离：知识库根**不放在 Agent workspace 下**，避免默认 `grep` 扫到上传原文；`SettingsService.getKnowledgeDirectory()` 把它作为 guarded directory 交给 `workspace-file-tools.ts`，**默认拒绝**该子树内的读取（含绝对路径与 `..` 别名），只有当前用户请求里明确点名该路径并表达读取意图时才放行（与外部写授权同一思路）。写入本就限制在 workspace 内，因此知识库目录不可被 Agent 改写。旧安装的 `<workspace>/knowledge` 在启动时由 `DocumentsService.onModuleInit` 一次性移动到新位置，目标已存在时不动。

目录文件 `<configDir>/knowledge/index.md`：`DocumentCatalogIndexService.rebuild()` 按数据库最新 `ready` 版本整体重写（临时文件 + rename），导入或删除后触发；`DocumentsService.onModuleInit` 在启动时检查，文件缺失就按数据库重建一次（空库写成 `## 资料目录` + “资料库当前为空”，不是空文件）。路径只在 `SettingsService.getKnowledgeCatalogPath()` 定义一次，写入、读取与文件工具豁免共用。它是知识库根里唯一可被 `read` 读取的文件（`readableGuardedPaths` 精确匹配），用于回答“资料库里有什么”；上传原文仍是 guarded。

## 8. 未实现

- `conversation_documents` 关联写入：会话资料范围目前由 `conversations.metadataJson` 的显式选择承担，该表仍只被删除路径引用。
- 扫描件 OCR、表格结构还原（仅告警）。
- 索引重建/重嵌的运维入口（换模型目前只能整库重灌）。
- 失败版本的内容哈希仍按「重复」短路：同一内容解析失败后再次导入会直接返回 `duplicate: true` + `failed` 版本，无法重试（2026-11-09 用真实 Word 锁文件复现）。修正方向是重复判定只认 `indexed`/`ready` 版本。

## 9. 实测（2026-11-08，win32 x64）

| 样本 | 结果 |
|---|---|
| `AI-Agents-in-Depth-zh-CN.pdf`（11 MB / 313 页） | 961 分片，入库 41.9 s（含向量），`ready` |
| `AI员工平台_作业背景文档_脱敏版_v1.docx`（50 KB） | 55 分片，289 ms |
| 分片 token | p50 = 461、max = 500；重叠上限 50 tokens 零违规 |
