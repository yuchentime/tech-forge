---
status: accepted
layer: decision
domain: memory
canonical_for:
  - long-term-memory-injection-boundary
related:
  - docs/decisions/2026-11-11-long-term-memory.md
  - docs/current/domains/memory/index.md
  - docs/changes/2026-11-11-long-term-memory/design.md
decided_at: 2026-11-11
---

# 长期记忆的每轮注入边界

## Context

聊天链路在每轮请求里调用 `MemoryService.buildChatContext(userPrompt)`，命中后把 `## 长期记忆` 块拼进本轮 user message。实际行为与最初设计一致：

- 注入块只属于当前轮；快照保存前 `replaceInjectedUserText()` 会把它从 user entry 剥掉，下一轮不会回放，所以**不存在逐轮累积**。
- 每轮上限是 3 条 × 200 字，加上固定声明，约 650 字符。
- 检索用一个相似度下限过滤，低于下限不注入。

使用中暴露了四个问题：

1. **阈值偏松**：0.65 是按“无关 0.59–0.65、相关 0.70–0.76”的探针校准的，但“先给结论”“用中文回答”这类通用偏好对几乎任何提问都能过线，于是每轮都被注入。它不是重复文本，却持续锚定回答方式，属于上下文污染。
2. **同轮自我回灌**：`captureUserMessage()` 原本在 `beginTurn()` 之后立刻触发，后台写入可能赶在本轮检索之前完成，用户刚说的“以后都用简体中文”会被同一轮再注入一次。
3. **标记字符串两份**：注入头在 `memory.service.ts` 与 `llm/session-entries.ts` 各写一份。改文案漏改一处时，快照剥不掉旧块，才会出现真正的累积。
4. **profile 里的检索默认值易误读**：`memory-engine.ts` 的 profile 写着 `minScore 0.65 / topK 3`，但 `pack`/`search`/`write` 都显式传参覆盖，这个值只是兜底。

## Decision

1. **保留“每轮注入 + 快照剥离”的机制**，不改成系统提示词、一次性持久 entry 或纯工具召回。
2. **收紧注入面**：`MEMORY_MIN_SCORE 0.65 → 0.72`、`MEMORY_MAX_ITEMS 3 → 2`、`MEMORY_CONTENT_MAX_CHARS 200 → 150`；`MEMORY_TOKEN_BUDGET 400` 与 1.5 s 超时不变。上限降到约 350 字符。
3. **捕获排在检索之后**：`ChatService` 先 `buildChatContext()`，再 `captureUserMessage()`；本轮注入永远看不到本轮刚写入的句子，写入只影响后续轮次。
4. **注入头单一来源**：新增 `memory/memory-context.ts` 导出 `MEMORY_CONTEXT_HEADER`，注入与快照清洗都引用它。
5. **profile 检索值定位为兜底**：在 `memory-engine.ts` 注明调用方都会显式传 `minScore`/`limit`，注入阈值只由 `memory.service.ts` 决定。

## Alternatives

| 方案 | 未采用原因 |
|---|---|
| 去掉每轮注入，仅靠 `memory_search` 工具 | 模型不会主动查，召回率断崖；工具调用还会增加首 token 延迟 |
| 首轮或 `contextMessage` 一次性注入 | 快照清洗会剥掉非 durable 块，第二轮就看不见；durable custom entry 只追加，会真累积 |
| 把记忆放进系统提示词 | 破坏 provider 前缀缓存；检索是 query 相关的，静态化只能全量注入，成本随记忆条数线性增长 |
| 维持 0.65 阈值、只减少条数 | 通用偏好仍会逐轮过线；条数只改成本，不改误命中 |
| 每次注入都全量列出记忆 | 成本无界，且与“只在与当前请求相关时使用”冲突 |

## Consequences

- 每轮固定成本从约 650 字符降到约 350 字符；检索与嵌入次数不变。
- 0.72 仍在实测相关带（0.70–0.76）内，但更靠近上沿；召回不足时优先降到 0.68，而不是回到 0.5。
- 捕获时序改变后，用户在被打断/取消的那一轮说出的“记住…”仍会写入（捕获发生在检索之后、流开始之前），只是不会回灌当轮。
- 快照清洗对注入头的依赖变成编译期可检查的引用；改文案不会再静默留下旧块。
- 新增用例：注入条数与 150 字截断（`memory.test.cjs`）、检索先于捕获（`agent-stream.test.cjs`）。
