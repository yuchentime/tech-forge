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
  - docs/decisions/2026-11-11-long-term-memory.md
last_verified: 2026-11-08
---

# 已接受决策

此处收录已经接受、影响长期实现且需要说明替代方案的决策记录。

| 决策 | 结论 | 记录 |
|---|---|---|
| 知识库检索平台 | 全本地实现（FTS5 + 本地 embedding + RRF），不引入托管检索服务或 LLM wiki | [ADR](2026-11-08-local-knowledge-retrieval.md) |
| 长期记忆引擎 | `@db0-ai/core` + sql.js SQLite，注入本地 bge；不装 `@db0-ai/pi`；user 作用域、独占锁与每日备份 | [ADR](2026-11-11-long-term-memory.md) |

其他产品和数据模型取舍仍在[设计输入索引](../source/index.md)中，确认后再提升为 ADR。
