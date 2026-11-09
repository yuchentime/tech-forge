---
status: current
layer: change
domain: knowledge-retrieval
canonical_for:
  - knowledge-command-verification
last_verified: 2026-11-09
version: 1.0
---

# `/知识库` 注入链路验收

验收以真实集成为准：真实 Nest 模块图 + 真实 SQLite 文件（跑生产 migration）+ 真实解析器 + 内置 embedding 模型，不 mock 检索与分块。

## AC

| AC | 断言 | 证据 |
|---|---|---|
| AC1 命令解析 | 句中/后缀/裸命令三种形态都不触发；开头命令被剥掉 | `test/knowledge-context.test.cjs` · `command parsing keeps non-command prompts untouched` |
| AC2 分片注入 | 注入文本以 `### 片段 N（资料：…；页码：…）` 渲染，分片来自索引且 ≤ 8 条 | 同上 · `the context carries ranked chunks with citation anchors` |
| AC3 去重 | 第二轮传入 `loadedChunkIds` 后 `outcome = already_loaded`，不重复注入 | 同上 · `a turn whose chunks are already in history injects nothing` |
| AC3.1 数量上限 | 候选超过上限时只注入 8 条，且每条 chunkId 都能在 `document_chunks` 查到 | 同上 · `the chunk count is capped and every chunk id exists in the index` |
| AC3.2 重排 | 桩重排反转顺序后注入顺序随其变化（`reranked = true`）；重排抛错时退回 RRF 顺序 | 同上 · `the reranker decides the order…` / `a failing reranker falls back…` |
| AC4 去重跨进程/跨轮 | 同一会话连续两轮（真实 HTTP）→ `injected` 后 `already_loaded` | 端到端 smoke（见下） |
| AC5 无命中 | 无关问题 `outcome = no_hits`，注入"没查到"通知而非正文 | 同上 · `an unrelated question reports no hits instead of guessing` |
| AC6 空库 | `outcome = no_scope` | 同上 · `an empty library reports an empty scope` |
| AC7 成本 | 注入 tokens 由注入文本按内置 tokenizer 实测计入 `stats.injectedTokens` | 同上 · `the context carries ranked chunks with citation anchors` |
| AC8 无命令不检索 | `chat.turn.accepted.knowledgeCommand = false`，`chat.llm.stream.started.injectedDocumentCount = 0` | 端到端 smoke |

## 端到端 smoke（真实进程 + 真实 HTTP）

`TEACHFORGE_DATA_DIR=<scratch>` 下用 `DocumentsService` 真实入库一份 Markdown，再从 `.test-dist/main.js` 启动后端并 `POST /api/chat/stream`：

```
SMOKE_RESULT {
  "secondTurnConversationReused": true,
  "outcomesInOrder": ["injected", "already_loaded", null],
  "acceptedFlags": [true, true, false]
}
knowledge.context.injected
  {"query":"光合作用发生在哪里","documents":[{"title":"生物讲义","pageStart":1,"pageEnd":1,"tokenCount":62,"truncated":false}],
   "scopeDocuments":1,"candidateDocuments":1,"skippedAlreadyLoaded":0,"injectedTokens":62,"elapsedMs":137}
knowledge.context.already_loaded
  {"query":"光反应产物是什么","candidateDocuments":1,"elapsedMs":3}
```

第二轮 `elapsedMs = 3`：去重读的是历史行，没有重新读盘或重建正文。`conversations.context_refs.failed` 为 0，说明 refs 写入成功。

### 显式范围（2026-11-09 补充）

| AC | 断言 | 证据 |
|---|---|---|
| AC9 覆盖语义 | 显式选择非共享资料后，共享资料不再命中（`outcome = no_hits`），选中的资料仍可命中 | `test:knowledge-context` · `an explicit conversation scope overrides the default range` |
| AC10 持久化 | `setKnowledgeScope` 写入 `conversations.metadataJson`，重新读取来自 SQLite；空数组清除覆盖并把列写回 `null` | 同上 · `the conversation scope survives a reload and clears back to the default` |

## 真实语料验收（2026-11-09）

`C:/Users/Administrator/Desktop/论文`：8 篇英文 PDF + 3 篇中文 DOCX（另有 1 个 Word 锁文件被正确拒绝），共 1688 分片。

入库：全部 `ready`；转换后的 `<base>.md` 全部生成，12/12 首片偏移与正文逐字一致；`学生手册-2026.docx`（346 片）113 s、`物联网学报_VLBC_vf_260206.docx`（531 片）209 s 为最慢两例。

检索（每个问题独立会话，避免上一轮注入干扰）：

| 查询 | 注入首篇 |
|---|---|
| `LLM4LB 是什么？落地时的主要挑战是什么` | `CM25_LLM4LB_v1_251007-xw` ✅ |
| `环境分割多址 EDMA 的可行性结论是什么` | `Environment_…EDMA…` ✅ |
| `学生手册里关于抄袭的范围界定是什么` | `学生手册-2026` ✅ |
| `VLBC 用了什么调制方案` | `物联网学报_VLBC_vf_260206` ✅ |
| `课题组 AI 智能体建设的目标和安排` | `课题组AI智能体建设项目会议提要_v2_261008` ✅ |

同一问题重问：已注入文档不再重复（`already_loaded` 或只补未加载的次要文档），token 不重复计。

### 分片注入（2026-11-09 修订后的最终形态）

同一语料、每个问题独立会话，注入 8 个分片：

| 查询 | 首篇注入 | 注入 tokens |
|---|---|---|
| `LLM4LB 是什么？落地时的主要挑战是什么` | `CM25_LLM4LB…` ✅ | 2682 |
| `环境分割多址 EDMA 的可行性结论是什么` | `Environment_…EDMA…` ✅ | 2811 |
| `学生手册里关于抄袭的范围界定是什么` | `学生手册-2026` ✅ | 3724 |
| `VLBC 用了什么调制方案` | `物联网学报_VLBC…` ✅ | 2460 |
| `课题组 AI 智能体建设的目标和安排` | `课题组AI智能体…` ✅ | 3998 |

整篇文档注入时代同批问题约 15.6k tokens（4–6 倍）。重排在本次运行中始终 `reranked = false`（scratch 配置无 Provider Key），仅由桩重排验证契约。

HTTP 端到端（真实进程 + 真实 SSE，整篇方案时期）：`POST /api/chat/stream` 带 `/知识库 …` → `knowledgeCommand=true`、注入 EDMA 论文（15767 tokens）、`knowledgeOutcome=injected`；随后因 scratch 配置无 Provider Key，`llm.stream.failed`（预期内，只证明注入链路）。

该语料同时暴露并修复了三个排序缺陷（词法 AND→OR、文档分求和→最佳分片、候选窗口 12→50 + 文档名优先），前后对比见 `docs/current/domains/retrieval/index.md` §5.2。

## 回归

`npm run test:retrieval` 11/11、`test:knowledge-library` 6/6、`test:conversation-history` 3/3 通过；`tsc --project tsconfig.build.json` 全量通过。

## 未覆盖

- 真实模型回答质量（需要可用 Provider Key）：smoke 只证明注入内容与日志，不评价答案。
- 桌面端输入框提示、未查阅资料标记：UI 未改动，用户以纯文本输入命令。
- 跨版本重新入库：新版本产生新的 `documentVersionId`，旧 ref 不再匹配，会重新注入——符合"证据在上下文里"的判定，未单独立测试。
