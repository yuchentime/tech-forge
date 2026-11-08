---
status: draft
layer: change
domain: knowledge-retrieval
created_at: 2026-11-08
version: 1.0
updates_current:
  - docs/current/platform/architecture-and-code-placement.md
---

# 本地知识库检索设计

## 实现状态（2026-11-08）

已实现：`documents/chunking/document-chunker.ts` 与 `DocumentsService.ingestFile()`——本地文件路径 → 解析 → 分块（500 tokens / 10% 重叠）→ 事务写 `documents` / `document_versions` / `document_chunks` / `chunk_search_terms` → 本地 embedding 写 `chunk_embeddings`，状态 `parsing → chunking → indexed → ready`；`documentId` 可追加新版本；`listDocuments()` / `getDocumentDetail()` / `listVersionChunks()` 提供读取。检索：`retrieval/text-normalizer.ts`（中文 bigram 归一化与 MATCH 构造）+ `RetrievalService.search()`（词法 + 向量双通道，RRF k=60 融合，`documentIds` 范围过滤，向量相似度下限 0.55）。迁移：`1793950000000-chunk-search-index.ts`、`1793960000000-chunk-embeddings.ts`。

未实现，因此下方设计中的对应部分仍是目标而非事实：

- 交叉编码器重排（rerank）、对话级检索编排（把命中拼进 prompt）、`messages.contextRefsJson` 写入。
- 上传 API、Renderer 入口、`conversation_documents` 关联；调用入口是 `verify:document-ingest` / `verify:retrieval` 脚本。
- 中文 gold set 的消融评估（RRF 相比单路增益尚未量化）。

验收见[落库闭环验收](verification.md)。

## Problem

资料已经能落到 `document_versions` 和 `document_chunks`，但没有检索能力：`RetrievalService`、`KnowledgeService`、`EmbeddingService` 均为空壳，`document_chunks` 没有写入流程，也没有任何索引。Agent 只能看到对话上下文，无法基于教师上传的资料回答，也无法给出可核查的引用位置。

约束来自产品定位：单用户、本地优先、教材与讲义正文不出本机、Windows 桌面直接安装。因此不能引入托管检索服务，也不能依赖 Docker、Python 常驻服务或云端 embedding。

## Goals

- 中文为主的混合检索：SQLite FTS5（BM25）+ 本地向量（余弦）+ RRF 融合。
- 英文兼容：ASCII 词分词与词干化，支持英文词命中中文文档中的英文术语。
- 引用可定位：结果携带文档、版本、章节标题与页码起始位置，可写入 `messages.contextRefsJson`。
- 索引可重建、可整代切换；任一索引不可用时检索降级而非失败。
- 零网络依赖：模型随包分发，首次运行不需要下载。

## Non-Goals

- 不做 rerank、不做 MMR、不做查询改写（v1 先测出基线再加）。
- 不建 LLM wiki 页面、知识图谱或记忆抽取。
- 不建独立向量数据库或 `sqlite-vec` 虚拟表。
- 不决定 Agent 何时调用检索、检索结果如何拼进 prompt。
- 不处理 PDF 版面解析与 OCR；输入是解析适配层输出的 Markdown。

## Must-Not-Break Existing Behavior

- 既有表结构与迁移链不变（`documents`、`document_versions`、`document_chunks`、`conversation_documents`）；新表全部为可重建的派生数据。
- Agent 流式对话、对话持久化、工具活动展示、Electron 认证桥接保持不变。
- 资料范围语义不变：`isShared = true` 表示跨 Conversation 可检索，`conversation_documents` 表示关联到当前 Conversation；不同 Conversation 的私有资料不得混入。
- 检索不写业务表；不新增 HTTP endpoint。

## Current Behavior

- `DocumentEntity`：`id`、`title`、`isShared`、时间戳。
- `DocumentVersionEntity`：`versionNo`、`originalName`、`mimeType`、`workspaceRelativePath`、`byteSize`、`contentHash`、`processingStatus`、`processingError`。
- `DocumentChunkEntity`：`documentVersionId`、`sequenceNo`、`content`、`locatorJson`，唯一索引 `(documentVersionId, sequenceNo)`。
- 文档解析适配层（含 2026-11-08 修订）给出内部契约 `ParseDocumentResult { text, pages[], format, parser, source, warnings }`，结果按页返回，并明确"解析正文由未来调用方决定是否持久化"。调用方尚未存在。

## Evidence Measured On This Workstation

以下数字为 2026-11-08 在 win32 x64 / Node 25 / SQLite 3.53.4（`better-sqlite3` 13）实测，用于固定设计参数：

| 项 | 结果 |
|---|---|
| FTS5 可用性 | 内置可用 |
| `unicode61` 查中文 | 文档「光合作用的教学策略」查 `光合作用` → **0 命中**（整句成单一 token） |
| `tokenize='trigram'` | 3 字查询命中；**2 字查询 0 命中** |
| 预切 bigram + `porter unicode61` | 2 字命中、短语命中、`strategy` 命中 `strategies` |
| `bm25(fts, 0.0, 5.0, 1.0)` | 首列 `UNINDEXED` 也占一个权重参数，可用 |
| 暴力余弦 10k chunk × 384 维 | 扫描 + 排序 **8.6 ms**，占用 14.6 MiB |
| `bge-small-zh-v1.5` q8 | 22.9 MB 文件 / 24 MB 落盘，512 维 |
| 编码吞吐 | 200 chunk 817 ms（**4.1 ms/chunk**），10k chunk ≈ 41 s |
| `multilingual-e5-small` q8 | 112.8 MB，384 维，762 ms/200 chunk |
| `bge-m3` q8 | **543.3 MB**，1024 维，20 chunk 278 ms（13.9 ms/chunk），编码后进程 RSS **961 MB**，10k chunk ≈ 139 s |
| 中文 token 密度 | 400 汉字 = **123 tokens**（`model_max_length` 512，≈1600 汉字） |
| e5 query/passage 前缀影响 | 带前缀 0.8449/0.8983/0.8372，不带 0.8493/0.8989/0.8365，排序不变 |
| 离线加载 | `allowRemoteModels=false` + `localModelPath` 可从本地目录加载 |
| `onnxruntime-node` 体积 | win32/x64 目录 64 MB（其中 DirectML + dxcompiler 36 MB 为 GPU 相关） |
| `sqlite-vec` 0.1.9 | win32 `loadExtension` 可用，`vec0` KNN 正常（**仍不引入**，见决策表） |

## Text Normalization And FTS Contract

全案唯一不可分叉的契约：入库与查询共用同一个纯函数。

```
toSearchTerms(text: string): string
```

1. 先剔除零宽与不可见字符（`U+200B–U+200D`、`U+FEFF`、`U+2060`）、Markdown 转义反斜杠与 HTML 锚点，再做 NFKC 归一化、全角转半角、转小写。DOCX 转换实测会注入这些字符（`<a id="...">`、`178\-2119`），不清理会让 bigram 切进噪声并让字符偏移失真。
2. 按 `\p{Script=Han}` 切段。Han 段长度 `n` → `n-1` 个 bigram（`n === 1` 保留单字）。
3. 非 Han 段按 `\p{L}\p{N}` 切词，保留原词交由 FTS 的 porter 词干化；归一化器自身不做词干化。
4. 各段以空格连接：`光合作用photosynthesis` → `光合 合作 作用 photosynthesis`。
5. 查询侧把连续 CJK bigram 组成**短语**（`"光合 合作 作用"`），与 ASCII token 以 `AND` 连接。使用短语而非 `AND`，否则 bigram 丢失位置信息，会命中倒序噪声。
6. CJK 单字查询（bigram 数为 0）回退 `content LIKE '%x%'`；单字查询稀有且噪声高，不为它索引 unigram。

FTS 使用 external content 指向检索词表，由触发器同步，不手工维护两处写入：

```sql
-- 归一化后的检索词流（bigram + ASCII 词）单独存一张普通表
CREATE TABLE chunk_search_terms (
  rowid   INTEGER PRIMARY KEY,
  chunkId TEXT NOT NULL UNIQUE,
  heading TEXT NOT NULL,
  body    TEXT NOT NULL
);

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  heading, body,
  content = 'chunk_search_terms', content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER chunk_search_terms_ai AFTER INSERT ON chunk_search_terms BEGIN
  INSERT INTO chunk_fts(rowid, heading, body) VALUES (new.rowid, new.heading, new.body);
END;

CREATE TRIGGER chunk_search_terms_ad AFTER DELETE ON chunk_search_terms BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, heading, body)
    VALUES ('delete', old.rowid, old.heading, old.body);
END;
```

选择 external content 而非独立存储：删除路径由触发器携带旧值，消除"调用方忘记重放旧值导致脏行"的整类 bug。chunk 在版本内不可变（每个 `documentVersionId` 只写一次），因此只需 insert/delete 两个触发器；若将来允许原地更新 chunk，再补 update 触发器。

`chunkId` 通过 `chunk_search_terms.rowid` 关联取回，FTS 表不再需要 `UNINDEXED` 列；排序使用 `bm25(chunk_fts, 5.0, 1.0)`，`heading` 权重高于 `body`。

## Chunking

- **预算以 embedding token 计，不以字符计**：目标 500 tokens，硬上限 500（+2 个特殊 token 仍在 `bge-small-zh-v1.5` 的 512 窗口内），重叠 50 tokens（目标的 10%）。
- 分词器：`@huggingface/tokenizers`（纯 JS，361 KB）+ 仓库内 `assets/models/bge-small-zh-v1.5/tokenizer.json`（429 KB）。与 transformers.js 的计数逐字一致，且离线可用、不引入 ONNX。
- 实测 token 密度（`bge-small-zh-v1.5`）：中文散文 0.97 字/token、中英混排 1.37、英文 3.09；500 tokens ≈ 498 个汉字。因此"500 tokens"与旧的 500 字符在纯中文下几乎等价，但英文长句不会被误判。
- 按 Markdown 标题层级切分，不跨 `h1`/`h2` 边界合并；标题稀疏的文档（实测 798k 字符仅 9 个标题）在超出目标长度时按段落回退切分。
- 超长段落按 token 上限二分查找切点，优先在句末标点处断开。
- 重叠通过"回退到上一分片末尾 ≤50 tokens 的位置"实现，因此 `charStart` 会与前一分片重叠；尾部短分片在不超过上限时并入前一片。
- 目录页段落（`TOC_LIKE`，形如 `7.3.2 … . . . . . 190`）不入索引；识别由解析层的 warning 提供，分块器只消费标记。
- 单文档 chunk 数上限 5000；超出返回 `DOCUMENT_TOO_LARGE_FOR_INDEX`，不静默截断。
- `locatorJson` 记录 `{ headingPath, pageStart?, pageEnd?, charStart, charEnd, tokenCount }`；页码来自解析结果的 `pages[].pageNo`，`tokenCount` 用同一分词器计算。

## Embedding

- 库：`@huggingface/transformers`（`pipeline('feature-extraction', ...)`），后端 `onnxruntime-node` CPU EP。
- 模型：`Xenova/bge-small-zh-v1.5`，`dtype: 'q8'`，`pooling: 'cls'`，`normalize: true`。**固定单一模型**，不做模型选择 UI、不做可下载模型通道。
  - 已评估并排除：`multilingual-e5-small`（384 维，跨语言备选）、`bge-m3`（543.3 MB / 13.9 ms per chunk / 961 MB RSS，随包不可接受）。
  - 换模型必须整库重嵌，见 Risks；因此不提供切换入口，避免用户进入半索引状态。
- 离线：`env.allowRemoteModels = false`、`env.localModelPath = <backend>/assets/models`；模型文件（`onnx/model_quantized.onnx` 23 MB + `config.json` + `tokenizer*.json`）随仓库分发，运行时不联网。
- 单实例 + 批量：`EMBED_BATCH_SIZE = 32`，进程内复用同一个 pipeline（实测加载 149 ms）。
- 实测吞吐（500-token 分片，本机 CPU）：**约 43 ms/分片**，313 页教材 961 分片 ≈ 42 s。短文本探针的 4 ms/分片只适用于 ~25 token 的输入，attention 随长度增长，不要用短文本吞吐估算索引时间。
- 编码在词法索引提交后进行：失败不影响已落库的分片与 FTS，状态停在 `indexed` 并记录 `EMBEDDING_FAILED`。
- 写入前已 L2 归一化，检索时余弦等价于点积。

## Storage

```sql
-- 每行自带模型标识：查询时按 (embeddingModel, embeddingDim) 过滤
CREATE TABLE chunk_embeddings (
  chunkId        TEXT PRIMARY KEY,
  documentId     TEXT NOT NULL,     -- 冗余：范围过滤不必 join 三表
  embeddingModel TEXT NOT NULL,
  embeddingDim   INTEGER NOT NULL,
  vector         BLOB NOT NULL      -- float32 LE，写入前 L2 归一化（余弦 = 点积）
);
CREATE INDEX idx_chunk_embeddings_scope ON chunk_embeddings(documentId);
```

向量查询谓词固定为 `embeddingModel = ? AND embeddingDim = ?`。换模型后旧向量对语义通道不可见，`rebuildVectorIndex()` 分批（50/批）重嵌并把 `document_versions.processingStatus` 推回 `ready`。

不做独立的索引代际表与 building/active 状态机：全量重嵌实测 10k chunk ≈ 41 s，原子切换没有实际收益，却要引入双份存储、激活步骤和失败回滚。行级模型戳记同样能保证"不同模型的向量不混算"，且部分完成时已重嵌的部分立即可用。

## Retrieval

```
FTS  → bm25(chunk_fts, 5.0, 1.0) 降序 → top 50
向量 → 余弦（点积）降序                   → top 50
RRF: score(d) = Σ 1/(k + rank_i(d)), k = 60
```

- 融合后取 top 12 → 同 `documentVersionId` 邻居扩展 ±1 chunk（补回被切断的上下文）→ 同文档去重 → 字符预算 6000 截止。
- 选择 RRF 而非加权求和：BM25 分数无上界、余弦落在 [0,1]，加权需要分数归一化与调参；RRF 只用排名，无参数标定，且任一路缺失时排序仍单调。
- 范围过滤**前置**：`documents.isShared = true` ∪ `conversation_documents(conversationId)` ∪ 用户显式子集。FTS 侧用 join 过滤，向量侧直接跳过不在范围内的 `documentId`，不做后置裁剪（后置会白扫）。
- 内部契约：

```ts
interface RetrievalHit {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  content: string;
  locatorJson: string;
  score: { rrf: number; lexicalRank?: number; vectorRank?: number; lexicalScore?: number; vectorScore?: number };
}
```

调用方（Agent、演练、引用展示）只依赖该形状。将来若更换检索后端，只改一个实现，不动调用点。

实现细节（`retrieval/retrieval.service.ts`）：

- 两路各取 50 个候选（`CHANNEL_DEPTH`），RRF `k = 60`，默认返回 12 条。
- 词法路的 MATCH 表达式由 `buildMatchQuery` 生成：≤3 个 bigram（≤4 字）用短语，更长的中文串用 bigram 的 OR 再由 BM25 排序；英文词各自成组并用 AND 连接。理由：长中文查询几乎不会作为连续短语出现，而短查询的 OR 会引入大量假阳性。
- 向量路用与写库同一个模型与维度过滤（行级模型戳记），相似度下限 `MIN_VECTOR_SCORE = 0.55`（实测无关中文句 0.47–0.48、相关句 >0.6）；可在请求中覆盖用于评估。
- 降级：embedding 不可用或向量缺失时向量路返回空，词法路照常返回，`score.vectorRank` 缺省即可看出单路结果。
- 实测：961 分片下查询 6–19 ms；命中带 `pageStart` 与字符偏移，可直接作为引用。

查询扩展通道（`retrieval/query-expander.ts`）：

- **只在词法零命中时触发**（`EXPAND_BELOW_LEXICAL_HITS = 1`）。有字面命中时不付模型往返的代价；被扩展救回的查询不会挤掉原有排名。
- 模型返回 `{ correctedQuery?, keywords[] }`：纠正错别字/OCR 噪声 + 同义词/术语，`keywords` 上限 8 个、每个 ≤20 字，去重且剔除原句已有词。
- 扩展结果**只做增补**：原查询仍作为独立通道参与 RRF；扩展项以 `EXPANSION_RANK_OFFSET = 5` 的名次惩罚加入，保证字面命中始终优先。
- 预算 800 ms（`EXPANSION_TIMEOUT_MS`），超时/无 Key/非 2xx/JSON 非法一律返回 `null`，检索回落到原有两路，不报错。
- **离线边界**：扩展会把「查询文本」发往用户配置的模型服务，但从不发送资料正文。未配置 Key 或断网时自动退化为纯本地检索。
- 单次调用可传 `expand: false` 跳过扩展，用于评估与确定性对比。

## Data And API Impact

- 新增表：`chunk_search_terms`（普通表）、`chunk_fts`（FTS5 虚表 + 两个触发器）、`chunk_embeddings`。均为可重建派生数据，可随时整表删除重灌。
- 不新增 HTTP endpoint、SSE 事件或 IPC 方法；v1 只提供 Nest Provider。
- `messages.contextRefsJson` 记录实际使用的 `documentVersionId` 与 locator，沿用既有字段，不新增表。
- `document_versions.processingStatus` 取值：`parsing | chunking | indexed | ready | failed`。`indexed` = 分片与词法索引已提交；`ready` = 向量也已提交；仅 embedding 失败时停在 `indexed` 并记录 `EMBEDDING_FAILED`。

## Backend Behavior

入库（`documents` 域）：

1. 调用解析适配层得到按页文本 `pages[]`；解析失败写入 `processingError`，不创建 chunk。
2. 按标题分块，在一个事务内写 `document_chunks`（含 `locatorJson`）与 `chunk_search_terms` 行（触发器同步 `chunk_fts`），状态置 `indexed`。事务内不做模型调用。
3. 事务提交后把该版本的 chunk 批量提交给 `EmbeddingService`；成功后写 `chunk_embeddings` 并置 `ready`，失败保留 `indexed` 并记录可重试状态。

检索（`retrieval` 域）：

1. `KnowledgeService` 解析范围，返回允许检索的 `documentId` 集合。
2. `RetrievalService` 并行执行 FTS 与向量两路；向量路在当前模型无已编码 chunk、模型不可用或某 chunk 尚未编码时跳过。
3. 融合、邻居扩展、按字符预算截断，返回 `RetrievalHit[]`。

## Error Handling

| 情形 | 处理 |
|---|---|
| 模型文件缺失或校验失败 | 检索降级为 FTS 单路，命中带 `degraded: true`；入库仍成功 |
| `onnxruntime` 加载失败 | 同上；启动时输出一次结构化告警，不阻塞后端启动 |
| 已存向量与当前模型的维度/标识不符 | 这些行被查询谓词排除，不参与语义通道；由 `rebuildVectorIndex()` 重嵌补回，不报错、不降级 |
| 编码中途失败 | 保持 `indexed`，允许按版本重试；已编码 chunk 不重复计费 |
| FTS 与向量都为空 | 返回空结果并显式标记，不臆测内容 |
| 查询串归一化后为空 | 返回空结果，不执行全表扫描 |
| 分块结果为空（解析无文本） | 不创建 chunk，状态 `failed` 并记录原因 |

## Risks

- **打包体积与 ABI**：`onnxruntime-node` 的 `win32/x64` 目录 64 MB（其中 GPU 相关 36 MB 可裁剪到约 29 MB），`onnxruntime-web` 136 MB 在 Node 路径用不到可整体剔除；`onnxruntime-node` 走 N-API，与 `better-sqlite3` 同机制，无需 electron-rebuild，但需 `asarUnpack`。**唯一未验证项**是在 Electron `utilityProcess.fork` 中加载，须在实现早期跑通；失败则退回 `onnxruntime-web`（WASM），代价是带 136 MB web 分支。
- **中文召回质量**：`bge-small-zh-v1.5` 在跨语言场景 margin 偏薄。需先建中文 gold set，不达标时切换 `multilingual-e5-small`（整库重嵌）。
- **分词口径漂移**：归一化器是入库与查询的共享契约，任何一侧改动都会静默降低召回。必须以同一函数的单测锁定。
- **模型切换成本**：换模型需全量重嵌（10k chunk ≈ 41 s）。因采用行级模型戳记，切换期间旧向量对语义通道不可见，需一次 `rebuildVectorIndex()`，没有部分生效的中间状态，也没有需要回滚的激活步骤。
- **rerank 的语言陷阱**：若后续引入交叉编码器，不能沿用常见默认 `Xenova/ms-marco-MiniLM-L6-v2`（纯英文，中文语料上会降质）；必须选多语种 cross-encoder，并用 gold set 验证增益后再上线。
- **查询扩展的代价**：仅在词法零命中时触发，但仍会把查询文本发往用户配置的模型服务（不含资料正文），且增加一次最多 800 ms 的往返。断网或无 Key 时退化；扩展质量依赖模型，术语幻觉由数量/长度上限与名次惩罚约束，但不能完全消除。
- **索引体积**：bigram 展开使 FTS 文本约占原文 1.5–2 倍；个人规模可接受，但需在大语料下复核。

## Alternatives Considered

| 方案 | 否决理由 |
|---|---|
| Supermemory 自托管 | Windows 原生仅 0.0.8（无 v5 API 且绑定全网卡），v5 需 Docker；二进制闭源、遥测默认开启；embedding 维度锁死；引用粒度仅到 chunk 无页码 |
| Supermemory 托管 | 教材正文离开本机，与本地优先定位冲突；引入第二套远程事实源 |
| LLM wiki 作为知识存储 | 不替代检索（仍需原文索引），新增第二套事实源与漂移/去重/重编译成本 |
| 仅 FTS5 | 语义查询与换说法提问召回不足 |
| 仅向量 | 术语、人名、公式等精确词命中弱；中文分词问题不可控 |
| `sqlite-vec` | 当前 10k 规模暴力扫描 8.6 ms，ANN 无收益，却多一个按平台分发的原生扩展（无 win-arm64）。触发条件：chunk > 10 万或检索 P95 > 100 ms |
| 云端 embedding API | 需网络与第三方账号，正文出本机 |

## Verification

设计阶段。实现前需将以下内容拆成可执行验收：

已完成的前置验证（本机实测，见 Evidence 一节）：FTS5 中文 bigram 命中、porter 词干化、`bm25` 列权重、暴力余弦性能、模型体积与编码吞吐、离线模型加载、`sqlite-vec` 在 win32 可用性。

待实现的验收：

- 中文 gold set（≥ 40 题：原句查找 / 换说法 / 跨文档对比 / 英文词）上，RRF 融合的 Recall@5 高于 FTS-only 与 vector-only。
- 2 字中文词、含英文术语的中文句均可命中。
- 检索结果能还原到章节标题与页码，并写入 `messages.contextRefsJson`。
- 删掉模型目录后检索降级为 FTS 且对话不中断；恢复模型目录并重建后恢复双路。
- 换 embedding 模型后旧向量不再进入语义通道，`rebuildVectorIndex()` 完成即恢复双路。
- 打包环境（Electron `utilityProcess`）内加载 `onnxruntime-node` 成功。
