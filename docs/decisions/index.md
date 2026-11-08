---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - accepted-decision-routing
related:
  - docs/README.md
  - docs/source/index.md
  - docs/decisions/2026-11-08-local-knowledge-retrieval.md
last_verified: 2026-11-08
---

# 已接受决策

此处收录已经接受、影响长期实现且需要说明替代方案的决策记录。

| 决策 | 结论 | 记录 |
|---|---|---|
| 知识库检索平台 | 全本地实现（FTS5 + 本地 embedding + RRF），不引入托管检索服务或 LLM wiki | [ADR](2026-11-08-local-knowledge-retrieval.md) |

其他产品和数据模型取舍仍在[设计输入索引](../source/index.md)中，确认后再提升为 ADR。
