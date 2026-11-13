---
status: current
layer: domain
domain: retrieval
canonical_for:
  - knowledge-retrieval-behavior
related:
  - docs/current/index.md
  - docs/current/domains/documents/index.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/changes/2026-11-08-knowledge-retrieval/design.md
  - docs/changes/2026-11-10-deep-research-command/design.md
last_verified: 2026-11-10
---

# 知识库检索当前事实

本页描述已实现并可复现的检索行为：词法 + 向量双通道、RRF 融合、单字回退、可选模型查询扩展，以及由用户斜杠命令显式触发的知识库上下文注入。检索**不是** Agent 工具：是否查阅资料由用户决定。

> **代码差异（2026-11-12 核对，未抹平）**：`9d6cfb2 feat: preload knowledge directory for commands`（2026-11-11）把 `/查询资料库`、`/探索主题` 的注入单位从"检索分片"改成"预载 `<configDir>/knowledge/index.md` 目录，由模型按其中的 `path` 自行 `read` 原文"，`ChatService` 因此不再调用 `KnowledgeService.buildContext()`。本页 §2–§3.5 描述的分片注入链（`RetrievalService` / `KnowledgeService` / `contextRefsJson` 去重）代码仍在、测试仍绿，但当前没有调用方；`ChatService` 的日志字段也随之变为 `knowledgeOutcome: 'directory_loaded'`、`injectedDocumentCount: 0`。目录预载的现状见 [资料入库](../../domains/documents/index.md) 的目录文件一节与 `docs/changes/2026-11-12-knowledge-catalog-bootstrap/`。恢复分片口径还是补齐预载口径，尚未决定。

## 1. 入口

| 入口 | 说明 |
|---|---|
| `RetrievalService.search({ query, limit?, documentIds?, minVectorScore?, expand? })` | 分片级检索，只负责排序，不负责上下文 |
| `KnowledgeService.buildContext({ conversationId, query, loadedRefs })` | 把命中聚合成文档并渲染成注入块；由 `ChatService` 在斜杠命令轮次调用 |
| `POST /api/chat/stream` 的 `prompt` 前缀 `/查询资料库 ` | 用户显式检索入口；后端解析并剥掉命令后再入库与调用模型 |
| `POST /api/chat/stream` 的 `prompt` 前缀 `/探索主题 ` | 研究入口：固定先检索，再加载内置 `deep-research` skill 生成知识文档与 SVG 知识地图；检索链路与上面完全相同 |
| `npm run verify:retrieval --workspace @teachforge/backend -- <file> <query…>` | 手工验证脚本 |

模型没有检索工具。`search_documents` 及其注册、测试已于 2026-11-09 删除：触发权归用户，避免"模型不调用"与"模型滥用"两种失败模式。

## 2. 通道与融合

| 通道 | 实现 | 关键参数 |
|---|---|---|
| 词法 | FTS5 `chunk_fts` + `bm25(chunk_fts, 5.0, 1.0)` | 单个中文 run ≤3 bigram 用短语，更长用 bigram 的 OR；run 之间用 OR；**文档标题按顶层标题索引进每个分片**（heading 列，权重 5） |
| 向量 | `chunk_embeddings` 按 `embeddingModel + embeddingDim` 过滤后在进程内点积 | 余弦下限 `0.55`（实测无关句 0.47–0.48、相关句 >0.6） |
| 查询扩展 | `LlmQueryExpander`：错字纠正 + 同义词/术语 | 仅词法零命中时触发；800 ms 预算；名次惩罚 `+5` |
| 单字回退 | `content LIKE '%字%'` 扫描 | 单汉字查询专用（bigram 索引无法回答） |

- 融合：RRF `k = 60`，每路取 50 个候选（`CHANNEL_DEPTH`），默认返回 12 条。
- 文档标题进索引（2026-11-09 实测修正）：问句点名文档时（`EDMA`、`LLM4LB`），中文问题词命中手册、英文论文正文里没有这些中文词，纯正文索引会让手册压过论文。标题作为每个分片的顶层标题词写入 `heading` 列，`bm25(..., 5.0, 1.0)` 的权重让"文档名命中"成为强信号。旧资料需重新入库才会带上标题词（无重索引入口）。
- 词法连接词为 OR 而非 AND（2026-11-09 实测修正）：输入是自然语言问题，AND 会让"某一个分句不在该分片里"直接归零。真实语料上「LLM4LB 是什么？落地时的主要挑战是什么」对含 `LLM4LB` 的分片（7 处字面命中）**返回 0 条**；改为 OR 后同一问题正常命中。召回归 OR，排序归 BM25（命中词越多分越高）。
- 结果包含 `chunkId`、`content`、`locatorJson`、`document`（id/title/fileName/path）与分通道分数。
- 降级：向量不可用时词法照常返回；扩展失败或超时视为未扩展；两条通道都空才返回空数组。

## 3. 斜杠触发的知识上下文

`/查询资料库 <问题>` 是本版本唯一的检索入口（纯开关，不接受范围参数）；`/查询知识库`、`/知识库` 作为旧别名仍然有效，三者等价：

- 解析规则：命令必须位于开头且后接空白；命令单独出现、`/查询资料库化 …`、出现在句中都不算命令，按普通文本发送（不静默丢字，也不静默关检索）。
- 命令字符串是**协议**：`knowledge-command.ts` 的 `KNOWLEDGE_COMMAND` 与 `SlashCommandMenu.insert` 必须同词。两者不一致时命令不会被识别，原文直接送进模型，模型会用 `grep` 去 workspace 里找内容并自称查过资料库（2026-11-09 实际发生）。两处都有注释与测试钉住。
- 输入框：输入 `/` 弹出单条菜单「查询资料库」，回车或点击后**命令以标签形式挂在输入区内**（composer 是 textarea，无法行内渲染 chip，标签位于输入框顶部），草稿里只留问题；发送时 `agent-chat-adapter` 把 `/查询资料库 ` 拼回 prompt，因此后端契约与入库文本不变。标签可点 × 移除，发送后自动清除。Esc 关闭菜单、Ctrl/Cmd+Enter 仍是发送。
- 有命令 → 本轮**固定**检索一次，命令文本从入库的用户消息与模型输入中剥掉。
- 无命令 → 完全不检索，不调用 `RetrievalService`，无任何 token 成本。

### 3.1 范围

范围来自数据模型与用户选择，不由模型判断（`DocumentsService.resolveKnowledgeScope`）：

1. **显式选择优先**：会话 `metadataJson.knowledge.documentIds` 非空时，只检索这些资料（未知 id 被过滤）。这是覆盖语义，不是叠加：单库安装里所有导入资料都是共享的，叠加等于没选。
2. 没有显式选择时：`conversation_documents` 关联资料 ∪ `documents.isShared = true` 的共享资料；
3. 两者都为空时回退到全部资料。

显式范围通过 `GET/PUT /api/conversations/:id/knowledge-scope`（`{ documentIds: string[] }`）读写，存在 `conversations.metadataJson` 的 `knowledge` 命名空间下；空数组清除覆盖，恢复默认范围。该能力目前只有 API：桌面端没有范围选择入口（原先输入框上方的"资料范围"行已按产品要求移除），`ChatService` 每轮仍会读取它。

> 与 `docs/source/data-model-design.md:57` 的差异：设计草案写的是"共享资料 + 会话资料 + 显式选择子集"（叠加）。当前实现改为覆盖，原因是共享集合已包含全部导入资料，叠加式选择无法表达"这次只看这几篇"。

### 3.2 注入单位与数量

- 注入**分片**，不注入整篇文档。整篇方案（聚合 → 重建正文 → 每篇预算 → 文档名路由）已被否决：它用三层机制换掉一次工具调用，单轮花掉 15k+ tokens 在模型用不到的段落上。
- 数量：`KNOWLEDGE_CHUNK_LIMIT = 8`。真实语料实测 8 片合计 3.6k–4.1k tokens（含每片头部元数据）。依据：一个问题的证据通常落在 1–2 篇资料里，两片一组的 8 片足以给出定义、例子与可被质疑核对的原文，同时不超过上下文的约 3%；再少则缺少引用依据，再多则把无关段落一起塞进窗口。
- 每个分片渲染为 `### 片段 N（资料：…；章节：…；页码：…）` + 正文，页码与章节来自 `locatorJson`，保证答案可核对。
- 候选：一次检索取 `RERANK_CANDIDATE_LIMIT = 24` 个分片交给重排，再取前 8。
- 查询扩展在注入路径上**关闭**（`expand: false`）：范围已很窄，重排承担精度。
- 命中为 0 或范围为空时不注入正文，改为注入一句明确通知，要求模型如实说明"没查到/资料库为空"，不得用记忆替代资料。

### 3.2.1 重排

`LlmChunkReranker`（`knowledge/chunk-reranker.ts`）用本机已配置的 chat Provider 对 24 个候选排序，输出 JSON 索引，超时 `1500 ms`，超时或解析失败一律 `null` → 保留 RRF 顺序。

- 隐私：不产生新的外发对象 —— 选中的分片本来就要进同一个 Provider 的 prompt 才可能被回答，重排只是提前一次同源调用。
- 只重排、不裁剪：模型没提到的候选仍排在后面，避免把排序步骤变成召回回退。
- 未配置 Key 时自动跳过（`stats.reranked = false`）。

### 3.3 去重（持久化）

- 每轮注入的分片写入该轮 **user 消息行**的 `messages.contextRefsJson`：

```json
{"knowledge":{"query":"…","triggeredBy":"command","chunks":[{"chunkId":"…","documentId":"…","documentVersionId":"…","title":"…","headingPath":["…"],"pageStart":1,"pageEnd":1}]}}
```

- 下一轮从已加载的历史行反推 `chunkId` 集合（`ConversationsService.beginTurn().loadedChunkIds`），命中过的分片不再注入；若候选全部已加载则返回 `already_loaded` 并注入一句说明。
- 真相来源是**历史里实际存在的证据**，不是进程内状态：重启不失效。将来加入历史裁剪时，被裁掉的记录自然消失、文档重新注入，这是期望行为。

### 3.4 注入位置

知识块不进入 system prompt：`ChatService` 把它和附件正文一起作为 `LlmRequestOptions.promptContext` 交给 `LearnAgent`，由后者拼在本轮 user message 前面（`## 用户输入` 标记之后是用户原话）。system prompt 因此逐字稳定，provider 的前缀缓存不会被每轮数据打断。

### 3.5 探索主题

`/探索主题 <主题>` 复用本节的检索链路，不改变范围、分片上限、重排或去重：

- 命令解析由 `chat/turn-command.ts` 完成，`/探索主题` 与 `/查询资料库` 可组合、顺序不限；研究轮次即使没写 `/查询资料库` 也固定检索。
- 检索结果仍写入该轮 `contextRefsJson.knowledge`，`triggeredBy` 仍为 `command`。
- `ChatService` 额外向 `LearnAgent` 传 `skillName: 'deep-research'`；`LearnAgent` 把 `/skill:deep-research` 放在模型 prompt 首位，资料块与主题作为参数。技能正文只进模型输入，不进 SQLite 消息或快照。
- 产物是会话工作区里的 `知识文档.md` 与 `知识地图.svg`，按普通 artifact 登记。详见[Agent Runtime](../../platform/agent-runtime.md#技能装载与探索主题)。

## 4. 日志

全部走 `writeStructuredEvent`（Nest Logger + JSON 单行，`logging/structured-logger.ts`），并带本轮 `requestId` / `conversationId`。

| 事件 | 级别 | 关键字段 |
|---|---|---|
| `chat.turn.accepted` | log | `knowledgeCommand`、`researchCommand`、`promptLength`、`userPromptLength` |
| `chat.llm.stream.started` | log | `knowledgeOutcome`、`injectedDocumentCount`（=注入分片数）、`injectedTokens`、`researchCommand` |
| `knowledge.context.injected` | log | `query`（≤200 字）、`chunks[]`（`chunkId`/`documentId`/`title`/`headingPath`/`pageStart`）、`scopeDocuments`、`candidateChunks`、`skippedAlreadyLoaded`、`reranked`、`injectedChunks`、`injectedTokens`、`elapsedMs` |
| `knowledge.rerank.skipped` / `.failed` | debug / warn | 未配置 Provider 或重排失败；请求继续用 RRF 顺序 |
| `knowledge.context.no_hits` / `.already_loaded` / `.empty_scope` / `.budget_exhausted` | log / warn | 同上口径，说明为什么没有注入正文 |
| `conversations.context_refs.failed` | error | 去重记录写入失败（不影响本轮回答） |
| `retrieval.search.completed` | log | `query`、`limit`、`scopedDocumentCount`、`lexicalHitCount` / `denseHitCount` / `expandedHitCount`、`expansion`（`used`/`no_hits`/`skipped`）、`fusedCount`、`hitCount`、`hydrateDroppedCount`、`outcome`（`hit`/`no_candidates`/`hydrate_missing`）、总耗时与分通道耗时、`topChunkIds` |
| `retrieval.search.skipped` | warn | `reason`（`empty_query`/`non_positive_limit`） |
| `retrieval.lexical.no_indexable_terms` | warn | 查询无法产出 FTS5 表达式（全是停用/标点） |
| `retrieval.lexical.matched` | debug | `channel`（`lexical`/`expanded`）、实际 MATCH 表达式（≤300 字）、`rowCount`、`topScore` |
| `retrieval.lexical.substring_scanned` | debug | 单汉字 LIKE 回退的 `character`、`rowCount` |
| `retrieval.dense_channel.scored` | debug | `modelId`、`dimension`、`vectorRowCount`、`acceptedCount`、`skippedByWidth`、`skippedByFloor`、`bestBelowFloor`、`topScore` |
| `retrieval.dense_channel.failed` | warn | 向量不可用的技术原因（`detail` + 安全错误字段），检索继续走词法通道 |
| `retrieval.expansion.terms` / `.empty` / `.failed` | debug | 扩展词、修正查询与实际 MATCH 表达式；扩展失败只降级不报错 |

约定：分片正文与注入正文都不进日志（只记 token 数、页码、标识），结构化日志只放标识、计数与阶段。

## 5. 实测

### 5.1 中文教材（2026-11-08，961 分片）

| 场景 | 结果 |
|---|---|
| 语义召回（无字面重叠） | 「为什么模型表现不好要改 Harness」命中第 192 页原文段落 |
| 混合召回 | 「上下文窗口管理」同时获得词法 0/2/9 名与向量 4/7/14 名 |
| 负例 | 「光合作用」在 AI 教材中 0 命中；`???` 无词法贡献 |
| 单字 | 「工」由 9 个命中（bigram 漏检）恢复为可检索，224 ms |
| 延迟 | 常规查询 6–19 ms；向量缺失时退回词法仍可返回 |

### 5.2 真实混合语料（2026-11-09，`Desktop/论文`，11 篇 / 1688 分片）

语料：8 篇英文 PDF 论文 + 3 篇中文 DOCX（学生手册、期刊论文、会议提要）+ 1 个 Word 锁文件（正确拒绝，`UNSUPPORTED_FORMAT`）。

入库实测（`DocumentsService.importFromPath`）：

| 文件类型 | 分片 | 耗时 |
|---|---|---|
| 小论文 PDF（21–83 片） | 21–83 | 0.8–3.8 s |
| 长 PDF（269 片，含 2 个 TOC 页告警） | 269 | 9.1 s |
| 中文 DOCX（3 / 222 / 346 / 531 片） | 3–531 | 0.1 s / 44.6 s / 113 s / 209 s |

DOCX 慢在 mammoth 转换 + 分块 tokenizer；531 片的期刊论文约 3.5 分钟。转换后的 `<base>.md` 全部生成，首片偏移与正文逐字一致（12/12）。

检索质量：本语料先后暴露了四处缺陷，逐条修复后 5/5 首位正确。注入单位同时从「整篇文档」退回「分片」，成本从 ~15.6k tokens 降到 2.5k–4.0k。

| 查询 | 首轮 | 最终（分片注入，无 Provider Key） |
|---|---|---|
| `LLM4LB 是什么？落地时的主要挑战是什么` | **no_hits** | `CM25_LLM4LB…` ✅ 第一，2682 tokens |
| `环境分割多址 EDMA 的可行性结论是什么` | `学生手册-2026` | `Environment_…EDMA…` ✅ 第一，2811 tokens |
| `学生手册里关于抄袭的范围界定是什么` | 级联失败（手册被上一轮错误注入） | `学生手册-2026` ✅ 第一，3724 tokens |
| `VLBC 用了什么调制方案` | `物联网学报_VLBC…` ✅ | 同 ✅，2460 tokens |
| `课题组 AI 智能体建设的目标和安排` | `课题组AI智能体…` ✅ | 同 ✅，3998 tokens |

四处修复（全部由该语料的数据驱动，逐条可复现）：

1. **词法 run 之间改 OR**：`LLM4LB` 在 7 个分片里字面出现，AND 表达式却返回 0 条。自然语言问题不能按关键词 AND 处理。
2. **文档标题索引进 `heading` 列**：问句点名文档时，英文论文正文里没有中文问题词，纯正文索引让手册压过论文。标题以权重 5.0 进入每个分片的 heading 词。
3. **"具名术语优先"词法通道**（`buildDistinctiveMatchQuery`）：先用 ≥3 字符的 ASCII 词与 ≥3 字的连续中文短语检索，命中即用；未命中再退回整句词元 OR。`LLM4LB`/`EDMA`/`VLBC` 因此成为决定性信号，而普通问题（无具名术语）行为不变。
4. **注入单位改回分片**（`KNOWLEDGE_CHUNK_LIMIT = 8`）：整篇文档方案（聚合 → 重建正文 → 每篇预算 → 文档名排序 → 候选窗口 50）已删除，代码量与 token 成本同时下降。

未验证：重排在本机没有 Provider Key，`stats.reranked` 全为 `false`，只由桩重排验证了"顺序被采纳"和"失败回退"。真实模型的重排效果需配置 Key 后复测。

## 6. 未实现

- 本地交叉编码器重排：当前重排调用 Provider（1500 ms 预算、失败退回 RRF）。本地 ONNX 重排模型未引入（`env.allowRemoteModels = false`，模型需随仓库分发）。
- 标题词的存量回填：标题索引只对重新入库的资料生效，旧数据没有重索引入口。
-"本轮未查阅资料"的界面标记按产品决定不做；输入框已提供 `/` 触发式菜单。
- 引用展示与答案形态：`contextRefsJson` 已写入，UI 尚未消费。
- 中文 gold set 的消融评估（RRF、扩展、阈值均未标定）。
