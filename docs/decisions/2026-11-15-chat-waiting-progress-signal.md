---
status: accepted
layer: decision
domain: agent-runtime
canonical_for:
  - chat-waiting-progress-signal
related:
  - docs/current/platform/agent-runtime.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/postmortems/2026-11-15-waiting-progress-hidden-after-text.md
  - apps/desktop/src/features/agent/turn-progress.ts
  - apps/desktop/src/features/agent/agent-event-bus.ts
  - apps/desktop/src/features/agent/AgentChatPage.tsx
decided_at: 2026-11-15
---

# 聊天等待进度的信号来源

## Context

聊天回答区的等待行（转动图标 + 当前动作 + 秒级耗时）原先只在 `AgentEventBus` 的 `phase === 'working'` 时渲染。`publish()` 收到首个 `message_update(text_delta)` 就把 phase 改为 `responding`，之后只有 `tool_execution_start/end`、`turn_start` 等生命周期事件能把它拉回 `working`。

模型在说完一句前导文本（例如「我先建文档。」）后，常常进入长时间静默：继续 reasoning，或生成一整篇 `.md` 的 `write` 工具参数。后端 `projectChatSessionEvent()` 只转发 `text_delta`；Pi 的 `thinking_delta`、`toolcall_start/delta/end`、`message_start/end` 都被有意过滤，没有其它 SSE 帧。于是 phase 冻结在 `responding`，等待行消失，而 assistant-ui 的 `isRunning` 仍让「停止生成」可点——用户在长文档生成期间看不到任何进度信号（[事故复盘](../postmortems/2026-11-15-waiting-progress-hidden-after-text.md)）。

这一现象暴露的是信号缺口，不是渲染缺陷。修复有两个方向：

- **A（前端静默判据）**：记录每轮最近一次被接受的流事件时间；本轮仍活跃且静默超过阈值时重新显示等待行。
- **B（后端阶段事件）**：把被过滤的 thinking/toolcall 事件投影成不带内容的阶段帧（`reasoning` / `toolcall`），让 UI 得到真实的「正在思考 / 正在准备工具调用」状态。

## Decision

1. **当前采用 A**。`AgentEventBus` 在快照之外记录 `lastEventAtByTurn`，`begin()` 写入起始时间，`publish()` 对每个被接受的帧更新时间（包括 phase 已是 `responding` 的重复 text delta）；`getLastEventAt(turnId)` 只读暴露。
2. `turn-progress.ts` 是唯一判定点：`shouldShowTurnProgress(phase, lastEventAt, now)`。`working` 恒显示；`responding` 仅在 `now - lastEventAt >= TURN_PROGRESS_SILENCE_MS`（当前 1000ms）时显示。`idle` 永不显示。
3. 页面用 1 秒 tick 重渲染等待行，读取 `Date.now()` 计算耗时与静默窗口；时间戳不放进不可变快照，避免每个 text token 触发 React 订阅者重渲染。
4. **不修改 SSE、preload、桥接校验或 Pi 事件投影**。thinking 与工具参数内容继续不越过后端边界；没有新增事件类型。
5. **B 保留为明确候选，不视为已否决**。后续触发条件与迁移步骤见下节；切换到 B 时 A 的判定函数保留为兜底，不静默删除阈值与测试。

## Alternatives

| 方案 | 未采用原因 |
|---|---|
| A 前端静默判据（采用） | 不改任何传输契约；实现面只有事件总线、一个纯函数和页面 tick；可用纯逻辑与浏览器事件回放验证。代价是判定延迟 1–2 秒，且只能表达笼统的「正在思考」。 |
| B 后端阶段事件（保留） | 语义最准，可区分 reasoning 与工具参数生成，且对任何 SSE 消费者都成立。但需要改 `chat-events.ts`、SSE 契约、`isChatStreamEvent`、preload、adapter/bus、后端测试，并加节流；当前没有第二个消费者或阶段文案需求，收益不足以先付契约成本。 |
| C 文本出现后常驻等待行 | 文本持续流式时也会一直显示，制造假的「未响应」信号，且与「停止生成」形成双重动效；用户无法从界面判断是否卡住。 |
| D 每收到 text delta 就更新不可变快照中的时间戳 | 语义与 A 相同，但每个 token 都通知页面级 `useSyncExternalStore` 订阅者，流式期间增加无意义的 React 渲染。 |
| E 只保留「停止生成」作为活性信号 | 这正是事故状态：按钮存在但内容区静止，用户无法区分「在生成大文档」与「卡住了」。 |

## Consequences

- 文本开始流式后，等待行先隐藏；静默 1 秒后重新出现（最迟约 2 秒，受 1 秒 tick 影响），下一个增量到达后约 1 秒内再次隐藏。
- 阈值与 tick 粒度决定误报/漏报：模型正常的 chunk 间隔通常远低于 1 秒，若某 provider 在流式途中也出现 >1 秒停顿，会出现一次可见的等待行闪回。调到更大的值只需改 `TURN_PROGRESS_SILENCE_MS`，判定语义不变。
- 等待行在 `responding` 静默期只能显示「正在思考…」（无进行中工具时），无法说明模型是在 reasoning 还是生成工具参数；这是 A 的已知表达上限。
- 事件总线的 liveness 时间与快照同生命周期（按轮保留、不主动删除），与现有 `snapshot` 的内存取舍一致。
- 回归：`apps/desktop/test/agent-stream.test.cjs` 固定「重复 text delta 仍刷新 liveness」与四种判定，`build:renderer` 校验类型与页面接线。

## Switch To B: Triggers And Steps

必须切换到 B（而不是继续调阈值）的条件，出现任一项即重新评估：

1. 真实 Provider 下等待行在文本持续流式时反复闪回，或静默超过阈值仍不出现（误报/漏报各出现一次以上）。
2. 产品要求等待行区分「正在思考」与「正在准备写入/调用工具」，或要求显示具体工具参数生成进度。
3. 出现第二个需要该阶段的消费者（其他窗口、future web 客户端、演练/课堂复用聊天流）。
4. 为其它需求已经转发 `toolcall_*` 或 `thinking_*`（届时 B 的传输成本接近零）。
5. `TURN_PROGRESS_SILENCE_MS` 因模型差异被调整两次以上，说明单一阈值不再成立。

迁移步骤（保持可回滚）：

1. `apps/backend/src/chat/chat-events.ts` 增加不含内容的阶段事件，例如 `{ type: 'activity', stage: 'reasoning' | 'toolcall' }`；在 `projectChatSessionEvent()` 中把 `thinking_start/delta`、`toolcall_start/delta` 折叠为它，并按约 1 次/秒节流。
2. `apps/desktop/src/types/chat-stream-event.ts` 的 `isChatStreamEvent` 增加精确字段校验；preload 与 Electron Main 无需新增逻辑（未知事件仍被拒绝）。
3. `AgentEventBus.publish()` 把该事件映射为 `phase: 'working'` 并记录 stage；`describeTurnStatus()` 优先使用 stage 文案（「正在思考…」/「正在准备写入…」）。
4. `shouldShowTurnProgress()` 保留为兜底（例如阶段事件在节流窗口内缺失），阈值可下调；不得删除对应回归测试，改为断言阶段事件优先。
5. 同步 `docs/current/platform/agent-runtime.md` 的 SSE 事件清单、`docs/current/platform/architecture-and-code-placement.md` 的等待行描述，并在本 ADR 追加「已被 B 替代」的说明与日期。
