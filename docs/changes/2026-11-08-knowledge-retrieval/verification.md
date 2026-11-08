---
status: current
layer: change
domain: knowledge-retrieval
canonical_for:
  - knowledge-retrieval-verification
last_verified: 2026-11-08
version: 1.0
acceptance_review_status: pending review
---

# 知识库落库闭环验收（分块 + 持久化）

本文件只覆盖**已实现**的部分：本地文件路径 → 解析 → 分块 → `documents` / `document_versions` / `document_chunks`。索引写入（`chunk_search_terms` + FTS 触发器）、向量化与检索**尚未实现**，对应 AC 以"未实现"标注，不作为本轮验收项。

## 验证分层

业务线验收以**真实集成**为准，不靠 mock 证明：

- **L1**：分块器纯函数断言（偏移不变量、标题轨迹、超长段落切分、目录页跳过）。无外部依赖，也不 mock。
- **L2（验收门槛）**：真实 Nest 模块图 + 真实 SQLite 文件（跑生产 migration）+ 真实解析器 + 磁盘上的真实 PDF/DOCX/Markdown。断言直接走 raw SQL，不经过被测 ORM 映射。
- **L3**：真实个人资料的可用性判断（分片长度是否适合阅读和引用）。

任何一条业务线必须通过 L2 才能进入下一条线。

## 执行命令

```bash
npm run test:document-ingest --workspace @teachforge/backend
npm run verify:document-ingest --workspace @teachforge/backend -- <file> [file...]
```

`verify:document-ingest` 会把 SQLite 与复制后的源文件写到 `TEACHFORGE_DATA_DIR`（默认 `<cwd>/.verify-data`），便于手工检查落库结果。

## Acceptance Criteria

### AC-01 分块偏移可回溯到解析文本

| 要素 | 内容 |
|---|---|
| 代码位置 | `apps/backend/src/documents/chunking/document-chunker.ts` |
| 前置条件 | 任意解析结果 |
| 预期行为 | 对每个分片，`parsed.text.slice(locator.charStart, locator.charEnd) === chunk.content` |
| 禁止出现 | 先裁剪页面再计算偏移，导致字符位置与解析文本错位 |
| 判定方式 | L1 断言 + 落库后重新解析同一文件比对 |

### AC-02 标题轨迹只在 Markdown 上生效

| 要素 | 内容 |
|---|---|
| 代码位置 | 同上（`format` 参数控制） |
| 前置条件 | `format: 'markdown'`（DOCX/MD）与 `format: 'plain_text'`（PDF） |
| 预期行为 | Markdown 分片带 `headingPath`；PDF 分片不把代码里的 `# 注释` 误判为标题 |
| 禁止出现 | PDF 正文里以 `#` 开头的行污染 `headingPath` |
| 判定方式 | 真实样本计数：PDF 961 个分片 0 个带 `headingPath`；DOCX 55 个分片全部带 |

### AC-03 分片长度受 embedding token 控制

| 要素 | 内容 |
|---|---|
| 代码位置 | `document-chunker.ts`（`CHUNK_TARGET_TOKENS = 500`、`CHUNK_MAX_TOKENS = 500`、`CHUNK_OVERLAP_TOKENS = 50`）、`token-counter.ts` |
| 前置条件 | 任意文档；计数器为模型自带分词器（仓库内 `tokenizer.json`） |
| 预期行为 | 每个分片 `locator.tokenCount ≤ 500` 且等于分词器对该 `content` 的计数；相邻分片重叠 ≤50 tokens 且 p50 接近 10% |
| 禁止出现 | 以字符数代替 token 计数；单分片超过 512 窗口（会被模型静默截断） |
| 判定方式 | L2 断言 `tokenCount === countTokens(content)`；真实样本统计 `max = 500`、重叠上限 50 tokens |

### AC-04 目录页不进入索引

| 要素 | 内容 |
|---|---|
| 代码位置 | 同上（消费 `TOC_LIKE` warning） |
| 前置条件 | 解析结果含 `TOC_LIKE` 且带 `pageNo` |
| 预期行为 | 该页的分块被跳过，后续分片偏移仍与解析文本一致 |
| 禁止出现 | 通过删除页面文本来跳过目录，导致后续偏移整体错位 |
| 判定方式 | L1 断言（三页样本，目录页被跳过且切片仍匹配） |

### AC-05 一次落库写满三张表

| 要素 | 内容 |
|---|---|
| 代码位置 | `apps/backend/src/documents/documents.service.ts` |
| 前置条件 | 支持格式的本地文件绝对路径 |
| 预期行为 | 写入 1 条 `documents`、1 条 `document_versions`（`processingStatus = chunked`、`contentHash`、`workspaceRelativePath`）、N 条 `document_chunks`（`sequenceNo` 连续、`locatorJson` 可解析）；源文件被复制到托管目录且字节一致 |
| 禁止出现 | 分片在事务外逐条写入；源文件仅被引用而未归属托管目录 |
| 判定方式 | L2 "ingest persists document, version and chunks" |

### AC-06 重复入库按内容幂等

| 要素 | 内容 |
|---|---|
| 代码位置 | 同上（`contentHash` 去重） |
| 前置条件 | 同一文件内容再次提交 |
| 预期行为 | 返回 `duplicate: true` 与同一 `documentVersionId`，不新增 document/version 行 |
| 禁止出现 | 每次调用都新建文档，造成重复资料 |
| 判定方式 | L2 "ingest is idempotent for the same file content" |

### AC-07 失败留痕且不产生半成品

| 要素 | 内容 |
|---|---|
| 代码位置 | 同上（`markFailed`） |
| 前置条件 | 声明为 `.pdf` 但内容损坏；不支持的扩展名 |
| 预期行为 | 解析失败时保留 version 行并写 `processingStatus = failed` + `processingError`，不写分片；不支持的格式在创建任何行之前就被拒绝 |
| 禁止出现 | 失败后静默留下 `parsing` 状态；失败文档产生空分片 |
| 判定方式 | L2 "records a failed parse…" 与 "rejects unsupported files…" |

### AC-08 同一资料可追加新版本且旧分片保留

| 要素 | 内容 |
|---|---|
| 代码位置 | `DocumentsService.ingestFile({ documentId })` |
| 前置条件 | 已存在一份资料，提交内容不同的新文件并指定其 `documentId` |
| 预期行为 | 同一 `documentId` 下新增 `versionNo = 2` 的版本，两个版本各自保留分片；`documents` 仍只有 1 行 |
| 禁止出现 | 内容变更被当成新资料；追加版本时覆盖或删除旧版本分片 |
| 判定方式 | L2 "ingest appends a new version…"（raw SQL 校验两版本分片数均存在） |

### AC-09 读取入口能反映真实落库状态

| 要素 | 内容 |
|---|---|
| 代码位置 | `listDocuments()` / `getDocumentDetail()` / `listVersionChunks()` |
| 前置条件 | 已入库一份资料 |
| 预期行为 | 列表返回最新版本号、状态、分片数；详情返回全部版本；分片按 `sequenceNo` 升序；未知 id 返回 `null`；指定不存在的 `documentId` 时入库直接报错而不是静默落到别的资料 |
| 禁止出现 | 读取入口返回与表内数据不一致的计数；未知名被当作新建资料 |
| 判定方式 | L2 "read models report document, version and chunk state" |

### AC-10 测试必须真实联动

| 要素 | 内容 |
|---|---|
| 判定方式 | 集成用例通过 `NestFactory.createApplicationContext` 启动 `TypeOrmModule.forRootAsync(buildDatabaseOptions)` + `DocumentsModule`；SQLite 使用临时目录中的真实文件并执行生产 migration（`synchronize: false`）；断言使用 `dataSource.query()` 的 raw SQL；输入是磁盘上真实的 Markdown/DOCX/损坏 PDF |
| 禁止出现 | mock 解析器、mock Repository、`synchronize: true` 建表、只断言 service 返回值而不查表 |

### AC-11 词法索引在真实数据库里可检索

| 要素 | 内容 |
|---|---|
| 代码位置 | `database/migrations/1793950000000-chunk-search-index.ts`、`retrieval/text-normalizer.ts`、`DocumentsService.persistChunks()` |
| 前置条件 | 任意文档入库完成 |
| 预期行为 | `chunk_search_terms` 行数等于分片数；`chunk_fts` 与来源表行数一致；中文四字词、两字前缀、英文词干均可命中；`buildMatchQuery` 把中文 bigram 组成短语、英文词用 AND 连接；命中可 join 回 `chunkId` |
| 禁止出现 | 中文查询归一化后为空串却执行 MATCH；删除来源行后 FTS 仍返回该分片（触发器未生效）；负数 bm25 直接当正分使用 |
| 判定方式 | L2 "lexical index makes Chinese and English words findable in the real database"（含负例与触发器删除断言） |

### AC-12 未实现项（不在本轮验收）

- `chunk_embeddings` 与本地向量化：未实现。
- 检索接口、RRF 融合、引用组装、`messages.contextRefsJson` 写入：未实现。
- 上传 API、Renderer 入口、会话资料关联（`conversation_documents`）：未实现。

## 本轮实测（2026-11-08，win32 x64 / Node 25）

| 样本 | 结果 |
|---|---|
| `test:document-ingest`（真实 Nest 上下文 + 真实 DB 文件 + migration） | **11/11 通过**，933 ms |
| `AI-Agents-in-Depth-zh-CN.pdf`（11 MB / 313 页） | 5,085 ms，**961 分片 / 1016 词法行**，`indexed`，`TOC_LIKE × 7` |
| `AI员工平台_作业背景文档_脱敏版_v1.docx`（50 KB） | 289 ms，**55 分片**，`indexed`，`UNSTRUCTURED_TABLE × 1` |
| 分片 token 分布 | PDF p50 = 461、max = 500、min = 34、超限 0；重叠上限命中 50 tokens，零违规 |
| 词法命中 | `智能体` / `编排模式` / `Harness` 均命中；`量子纠缠`（库中不存在）命中 0 |
| 重复入库 | 第二次 4 ms 返回 `duplicate`，文档/版本/分片计数均不变 |

## 已知限制

- 表格结构不保留（仅 `UNSTRUCTURED_TABLE` warning），与解析层限制一致。
- 目录页识别依赖解析层 warning；未被识别的点线页会留下极短分片。
- 不指定 `documentId` 时，内容变化的同一文件会新建一份资料；调用方需要"同一份资料的历史版本"时必须显式传 `documentId`。
- 多词英文查询按 AND 组合，跨分片出现的两个词不会命中原分片（由后续向量检索补足）。
