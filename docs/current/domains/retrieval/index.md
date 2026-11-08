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
last_verified: 2026-11-08
---

# 知识库检索当前事实

本页描述已实现并可复现的检索行为：词法 + 向量双通道、RRF 融合、单字回退、可选模型查询扩展，以及暴露给 Agent 的 `search_documents` 工具。

## 1. 入口

| 入口 | 说明 |
|---|---|
| `RetrievalService.search({ query, limit?, documentIds?, minVectorScore?, expand? })` | Nest Provider，无 HTTP 端点 |
| `search_documents` 工具 | 注册在 Pi 会话的 `customTools` 中，由模型决定是否调用 |
| `npm run verify:retrieval --workspace @teachforge/backend -- <file> <query…>` | 手工验证脚本 |

## 2. 通道与融合

| 通道 | 实现 | 关键参数 |
|---|---|---|
| 词法 | FTS5 `chunk_fts` + `bm25(chunk_fts, 5.0, 1.0)` | ≤4 字中文用短语，更长用 bigram 的 OR；英文词各自 AND |
| 向量 | `chunk_embeddings` 按 `embeddingModel + embeddingDim` 过滤后在进程内点积 | 余弦下限 `0.55`（实测无关句 0.47–0.48、相关句 >0.6） |
| 查询扩展 | `LlmQueryExpander`：错字纠正 + 同义词/术语 | 仅词法零命中时触发；800 ms 预算；名次惩罚 `+5` |
| 单字回退 | `content LIKE '%字%'` 扫描 | 单汉字查询专用（bigram 索引无法回答） |

- 融合：RRF `k = 60`，每路取 50 个候选（`CHANNEL_DEPTH`），默认返回 12 条。
- 结果包含 `chunkId`、`content`、`locatorJson`、`document`（id/title/fileName/path）与分通道分数。
- 降级：向量不可用时词法照常返回；扩展失败或超时视为未扩展；两条通道都空才返回空数组。

## 3. `search_documents` 工具契约

```json
{
  "content": [{"type": "text", "text": "[{\"content\":\"…\",\"document\":{\"name\":\"…\",\"path\":\"documents/<id>/v1/…\",\"title\":\"…\",\"id\":\"…\"},\"locator\":{\"headingPath\":[],\"pageStart\":1,\"pageEnd\":1}}]"}],
  "details": {"count": 1, "query": "…"}
}
```

- 参数：`query`（必填）、`limit`（1–10，默认 5）。
- 返回数组；无命中返回 `[]`；检索异常返回 `isError: true` 与「检索失败：…」，不抛出。
- `document.path` 是相对数据目录的源文件路径，可直接定位原件。

## 4. 实测（2026-11-08，win32 x64 / 961 分片）

| 场景 | 结果 |
|---|---|
| 语义召回（无字面重叠） | 「为什么模型表现不好要改 Harness」命中第 192 页原文段落 |
| 混合召回 | 「上下文窗口管理」同时获得词法 0/2/9 名与向量 4/7/14 名 |
| 负例 | 「光合作用」在 AI 教材中 0 命中；`???` 无词法贡献 |
| 单字 | 「工」由 9 个命中（bigram 漏检）恢复为可检索，224 ms |
| 延迟 | 常规查询 6–19 ms；向量缺失时退回词法仍可返回 |

## 5. 未实现

- 交叉编码器重排（rerank）与查询改写之外的重写策略。
- 会话级检索编排：`knowledge` 域仍是空壳，尚未把「共享资料 + 会话关联资料」编译成检索范围；`RetrievalService` 目前只接受显式 `documentIds`。
- 命中写入 `messages.contextRefsJson`、引用展示与答案形态。
- 中文 gold set 的消融评估（RRF、扩展、阈值均未标定）。
- 真实模型是否会主动调用 `search_documents`：未在本机验证（需要可用 Provider Key）。
