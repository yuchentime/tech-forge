---
status: current
layer: domain
domain: documents
canonical_for:
  - document-ingest-behavior
related:
  - docs/current/index.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/changes/2026-11-10-directory-knowledge-library/design.md
  - docs/changes/2026-11-12-directory-catalog-import-failure/design.md
last_verified: 2026-11-12
---

# 资料入库当前事实

本页描述已经由代码与运行验证的入库行为：本机文件 → 解析 → 转换 Markdown → 目录摘要 → `ready`。旧的“分块 → 词法索引 → 向量”模块与历史数据仍保留在仓库中，但**没有任何生产调用**（见 [目录资料库设计](../../../changes/2026-11-10-directory-knowledge-library/design.md)）。目标或未实现的能力单独标注。

## 1. 入口

- Nest Provider：`DocumentsService.ingestFile({ filePath, documentId?, title?, isShared?, signal? })`。
- HTTP（`DocumentsController`，与本机 token 同级保护）：`GET /api/documents` 列表、`POST /api/documents/import { filePath, title? }` 导入、`POST /api/documents/:documentId/catalog/retry` 只重试摘要、`DELETE /api/documents/:documentId` 删除。
- 桌面端：侧栏「知识库」视图 → 「导入资料」调系统文件选择器，一次可选多份 → 上述 import；行内二次确认后删除，摘要失败的行提供「重试摘要」。
- 手工入口保留：`npm run verify:document-ingest --workspace @teachforge/backend -- <file>`。
- `filePath` 必须是绝对路径的普通文件；扩展名决定解析器，不支持的格式在创建任何数据库行之前就被拒绝。

## 2. 解析

调用 `platform/document-parser`（不归 Documents 域所有）：

| 格式 | 实现 | 结果 |
|---|---|---|
| PDF | `pdfjs-dist` 6（ESM，经 `load-esm.ts` 加载） | 按页重建行与段落；返回 `pages[]`、`TOC_LIKE`/`MULTI_COLUMN_SUSPECTED` 等告警；无文本层抛 `NO_TEXT_LAYER` |
| DOCX | `mammoth` `convertToMarkdown` | 单页；表格被拍平并产出 `UNSTRUCTURED_TABLE`；加粗短段落提升为 `##` 伪标题 |
| MD / TXT | 直接读取 | 单页 |

## 3. 目录摘要

- `DocumentCatalogService.summarize(title, joinParsedPages(pages))` 用无工具、无 memory 的 `LlmService.generate()` 生成结构化元数据。
- 预算：输入取开头 45%、结尾 25% 与中段均匀采样，合计 12 000 字符。
- 长度只是提示词里的**软上限**（`CATALOG_SUMMARY_SOFT_LIMIT = 200`，措辞为“尽量不超过”）：校验器只检查 JSON 形状、`summary` 非空、`keywords` 3–8 个非空短语、`documentType` 非空，**不因摘要偏长拒绝**。硬上限曾把 Provider 正常返回的 260 / 397 字符摘要判成失败，使整份资料变成 `failed`。
- 校验失败抛 `DocumentCatalogError('INVALID_SUMMARY')`，message 只含长度/数量，不回显模型输出或正文；非 JSON 的解析错误被替换为固定文案，避免把原文片段写进日志或数据库。
- Provider 调用失败按 `SUMMARY_PROVIDER_FAILED` 归类。两类失败都写 `catalogStatus = 'failed'` 与安全摘要到 `catalogError`；成功输出 `documents.catalog.ready`（`summaryLength`、`keywordCount`、`trigger`），失败输出 `documents.catalog.failed`（`code`、`detail`、`trigger`），均不记录摘要或正文。

## 4. 落库与状态

| 状态 | 含义 |
|---|---|
| `parsing` | 已写文档/版本行，解析进行中 |
| `cataloging` | 解析完成，正在生成目录摘要 |
| `ready` | 转换文本与目录摘要都已就绪，`index.md` 含该资料 |
| `indexed` | 兼容旧值的历史数据，新导入不再写入 |
| `failed` | 解析失败（`processingError`）或摘要失败（`catalogStatus = 'failed'` + `catalogError`） |

- 摘要状态另存于 `catalogStatus`（`pending | ready | failed`）、`catalogSummary`、`catalogKeywordsJson`、`catalogDocumentType`、`catalogError`、`catalogedAt`。`processingStatus = 'failed'` 只表示这次导入没有产出可用的目录条目，文件与转换文本仍然保留。
- 幂等键是文件内容的 SHA-256：同一内容重复提交返回 `duplicate: true`，不新增行。失败版本同样参与幂等判定，因此失败后应使用「重试摘要」或删除后重新导入。
- 同一份资料的历史版本需显式传 `documentId`，`versionNo` 自增。
- `document_chunks` / `chunk_search_terms` / `chunk_embeddings` 不再写入；`chunkCount` 字段保留在返回结构中并恒为 `0`，界面不再展示“N 段”。
- 源文件复制到 `<configDir>/knowledge/documents/<documentId>/v<versionNo>/<originalName>`，`workspaceRelativePath` 相对知识库根保存；`<configDir>` 为 `TEACHFORGE_CONFIG_DIR`，未设置时默认 `~/.tech-forge`（SQLite 主库位于数据根的 `db/` 子目录）。
- 转换后的正文另存为同目录的 `<baseName>.md`：仅对需要转换的格式（PDF/DOCX）写入；`.md`/`.markdown`/`.txt` 本身就是可读文本，不写第二份。内容用 `joinParsedPages`，与摘要输入同一拼装规则；写入失败只产生 `CONVERTED_MARKDOWN_FAILED` 警告，不影响目录生成。
- 界面文案不出现 `向量`、`索引`、`分片`、`embedding`、`OCR` 等内部术语：状态显示为“可以搜索 / 正在读取 / 正在生成摘要 / 摘要未生成 / 导入失败”；行内只显示版本号、字节数与导入时间。
- 列表为空时显示共享空状态（`EmptyState`，图标 `Books`），说明支持的格式与用途，并把下一步指向页头「导入资料」；不在空状态里再放一个重复的导入按钮。

## 5. 读取模型

| 方法 | 返回 |
|---|---|
| `listDocuments()` | 文档列表 + 最新版本号、`processingStatus`、`catalogStatus`、字节数、导入时间、`processingError` |
| `getDocumentDetail(documentId)` | 全部版本及各自 `status`、`catalogStatus`、错误 |
| `listVersionChunks(documentVersionId)` | 历史分片只读查询，新版本恒为空 |
| `importFromPath({ filePath, title? })` | 复制到知识库目录并入库，返回 `IngestDocumentResult + storedPath`（绝对路径，位于知识库根下） |
| `retryCatalog(documentId)` | 只对最新版本重跑摘要，返回 `{ documentId, catalogStatus }`；已就绪的版本是幂等空操作 |
| `deleteDocument(documentId)` | 事务清除派生行，再删除资料的两份文件副本 |

- 摘要重试直接读取该版本已保存的可读文本（`catalogReadablePath(workspaceRelativePath)`，PDF/DOCX 指向同级 `.md`），不重新解析、不复制文件；正文缺失返回 404，版本仍在处理返回 409。
- `resolveKnowledgeScope(conversationId, explicitDocumentIds?)`：显式选择非空时只返回这些资料（覆盖默认范围）；否则会话关联资料 ∪ 共享资料，两者皆空时回退全部资料。范围判定归 documents 域。

## 6. 迁移与依赖

- `1793950000000-chunk-search-index.ts`：`chunk_search_terms` + `chunk_fts`（external content）+ insert/delete 触发器；只服务历史数据。
- `1793960000000-chunk-embeddings.ts`：`chunk_embeddings`（行级 `embeddingModel`/`embeddingDim` 戳记）；只服务历史数据。
- `1794020000000-document-catalog.ts`：`document_versions` 的目录字段。
- 运行时依赖：`pdfjs-dist`、`mammoth`；旧分块/向量依赖（`@huggingface/tokenizers`、`@huggingface/transformers`）只在历史模块中使用。

## 7. 并发、导入与删除

同时处理的上传最多 **3 份**（`IMPORT_CONCURRENCY`）：`ConcurrencyGate` 按到达顺序发放名额，其余请求等待；解析与 Provider 调用在名额内并行，SQLite 写入、删除事务与 `index.md` 重建仍串行（`withDatabaseLock`）。桌面端用同样的 3 并发提交，未启动的文件显示“排队中…”。Provider 调用是限额目标：`generate()` 之外只有这条路径会批量调用模型。

导入（`POST /api/documents/import`）、摘要重试与删除共用上述两把锁：

| 阶段 | 行为 |
|---|---|
| 入库 | 直接对用户选择路径调用 `ingestFile({ isShared: true })`；源文件随即复制到 `<configDir>/knowledge/documents/<id>/v<n>/`，没有额外的暂存目录。重复检查与版本行创建在同一把数据库锁内完成，同字节并发上传只会留下一条记录 |
| 摘要 | 解析后生成并校验目录摘要；成功则版本 `ready` 并整体重写 `index.md` |
| 重复 | 同一内容返回 `duplicate: true` + 既有版本状态，不写新行 |
| 删除 | 按外键与触发器顺序清派生行，提交后再删知识库副本；处于 `parsing`/`cataloging` 时返回 409（`DOCUMENT_PROCESSING`），未知资料返回 404 |
| 解析失败 | 返回 422（`NO_TEXT_LAYER` 等）并写 `documents.import.failed`；版本记为 `failed`，文件保留 |
| 摘要失败 | 返回 200 + `status: 'failed'` + `warnings[]` 含 `CATALOG_FAILED`，版本 `catalogStatus = 'failed'`，日志 `documents.catalog.failed`；文件与转换文本保留，可用重试端点恢复，`index.md` 不写该资料 |
| 重试结果 | 成功：`ready` + `documents.catalog.retried`；再次失败：`failed` + `documents.catalog.failed`（`trigger: 'retry'`） |
| 错误信封 | `{ statusCode, code, message, detail }`：`message` 是中文可执行文案（渲染层直接展示），`detail` 保留技术原因 |
| 非阻断失败 | 删除后文件清理失败 → `fileCleanup: 'partial'`；转换 Markdown 写入失败 → `warnings[]` 追加 `CONVERTED_MARKDOWN_FAILED` |

- 渲染层把 `status: 'failed'` 的导入结果显示为失败：状态文案为“摘要未生成”，提示可点「重试摘要」；不会把摘要失败显示成导入成功。
- 目录文件 `<configDir>/knowledge/index.md`：`DocumentCatalogIndexService.rebuild()` 按数据库最新 `catalogStatus = 'ready'` 版本整体重写（临时文件 + rename），导入、重试或删除后触发；`DocumentsService.onModuleInit` 在启动时检查，文件缺失就按数据库重建一次（空库写成 `## 资料目录` + “资料库当前为空”，不是空文件）。路径只在 `SettingsService.getKnowledgeCatalogPath()` 定义一次，写入、读取与文件工具豁免共用。它是知识库根里唯一可被 `read` 读取的文件，上传原文仍是 guarded。

隔离：知识库根**不放在 Agent workspace 下**，避免默认 `grep` 扫到上传原文；`SettingsService.getKnowledgeDirectory()` 把它作为 guarded directory 交给 `workspace-file-tools.ts`，**默认拒绝**该子树内的读取（含绝对路径与 `..` 别名），只有当前用户请求里明确点名该路径并表达读取意图时才放行。写入本就限制在 workspace 内，因此知识库目录不可被 Agent 改写。旧安装的 `<workspace>/knowledge` 在启动时由 `DocumentsService.onModuleInit` 一次性移动到新位置，目标已存在时不动。

## 8. 未实现

- `conversation_documents` 关联写入：会话资料范围目前由 `conversations.metadataJson` 的显式选择承担，该表仍只被删除路径引用。
- 扫描件 OCR、表格结构还原（仅告警）。
- 全库摘要重建端点（`POST /api/documents/catalog/rebuild`）：设计有、代码未实现；当前只有单份「重试摘要」与启动时的 `index.md` 重建。
- 失败版本的内容哈希仍按「重复」短路：同一内容在摘要失败后再次导入会返回 `duplicate: true` + `failed`，需要先重试摘要或删除那条失败记录。

## 9. 实测（2026-11-12，win32 x64）

| 样本 | 结果 |
|---|---|
| `AI员工平台_作业背景文档_脱敏版_v1.docx`（50 KB） | 摘要 3.1 s，`ready`；`index.md` 条目含类型、关键词与摘要 |
| `AI-Agents-in-Depth-zh-CN.pdf`（11 MB） | 摘要 3.2 s，`ready` |
| 摘要失败复现 | 提示词写 300、校验器硬卡 200，模型返回 260 / 397 字符 → `Invalid catalog JSON.`、`failed`、无日志；改为软上限 + 只校验形状后，任意长度摘要都能入库（本轮真实导入摘要 89 / 206 字符均为 `ready`） |
| 失败与恢复 | 注入 Provider 失败 → `documents.catalog.failed`（`code: SUMMARY_PROVIDER_FAILED`），响应 `status: 'failed'`；清除故障后重试 → `ready`，重复重试幂等 |
| 并发上限 | 同时提交 5 份：日志中 `llm.generate.started` 恰为 3 条重叠，第 4、5 条在前一批 `generate.terminated` 之后开始；总耗时约等于两批（5 份 3.1 s，串行需约 9 s）。桌面端同步显示 3 行处理中 + 2 行“排队中…” |
