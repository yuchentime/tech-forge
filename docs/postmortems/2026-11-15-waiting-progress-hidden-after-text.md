---
status: historical
layer: postmortem
domain: agent-runtime
created_at: 2026-11-15
last_verified: 2026-11-15
canonical_for:
  - chat-waiting-progress-silence-incident
related:
  - docs/postmortems/index.md
  - docs/decisions/2026-11-15-chat-waiting-progress-signal.md
  - docs/current/platform/agent-runtime.md
  - docs/current/platform/architecture-and-code-placement.md
  - apps/desktop/src/features/agent/turn-progress.ts
  - apps/desktop/test/agent-stream.test.cjs
---

# 2026-11-15 文本流式后等待提示消失

## Summary

用户要求把分布式锁、幂等、限流写成单独的 `.md` 文档后，Agent 先流式输出「我先建文档。」，随后进入生成文档的静默阶段。此时输入框仍显示「停止生成」，但回答区没有任何等待提示，用户无法区分「正在生成大文档」与「已经卡住」。

根因不在渲染或滚动：等待行的唯一判据是 `phase === 'working'`，而首个 text delta 会把 phase 锁到 `responding`；后端按隐私边界过滤掉 `thinking_delta`、`toolcall_*` 和 `message_*` 事件，静默期没有任何帧能把 phase 拉回 `working`。「停止生成」来自 assistant-ui 的独立 `isRunning`，所以它仍在。

修复把判据改为「本轮仍活跃且最近 1 秒没有可见流事件」，记录 liveness 时间并只在静默时显示等待行；SSE/桥接契约未变。A/B 选择的长期权衡记录在 [ADR](../decisions/2026-11-15-chat-waiting-progress-signal.md)。

## Impact

- 用户在前导文本之后看不到进度、耗时或当前动作，只能凭「停止生成」推断请求仍在运行；长文档生成可持续数十秒到数分钟，容易误判为卡死或提前取消。
- 没有数据丢失：请求未中断，工具调用与消息持久化不受影响；这是纯呈现缺口。
- 无法量化受影响会话数；触发条件（先输出文本、再长时间静默）在文件生成、长推理、工具参数生成路径上都可能出现。

## Trigger

2026-11-15 16:58 的桌面截图中，用户发送「分布式锁、幂等、限流。这三个优先讲讲，结合代码演示。代码写到单独的 .md 文档内」，Agent 回答「我先建文档。」；回答区此后没有等待行，输入框显示「停止生成」。

## Facts

| 证据 | 可推出 | 不能推出 |
|---|---|---|
| 截图同时存在流式文本、「停止生成」和空白回答区 | 本轮仍在运行，等待行没有渲染 | 模型当时的内部阶段（reasoning 还是工具参数生成） |
| `AgentChatPage.tsx` 原判据为 `activity.phase === 'working'` | 文本到达后等待行必然卸载 | 事件总线是否收到过后续帧 |
| `agent-event-bus.ts` 的 `publish()` 在 `message_update` 时把 phase 改为 `responding`，并对后续 text delta 直接返回 | phase 不会因继续输出文本而回到 `working` | 其它生命周期事件是否该出现 |
| `chat-events.ts` 只投影 `text_delta`；`thinking_*`、`toolcall_*`、`message_*` 都没有对应 SSE 事件 | 静默期没有可渲染的帧 | 后端是否仍在正常工作 |
| Pi 类型中确实存在 `thinking_delta` 与 `toolcall_delta` | 静默是过滤结果，不是没有事件 | UI 需要看到这些内容 |
| 用编译后的 `AgentEventBus` 回放：`begin → working`，`text_delta → responding`，静默期保持 `responding`，`tool_execution_start → working` | 现象可由状态机确定性复现 | 修复后的视觉行为 |
| 界面「停止生成」由 `state.thread.isRunning` 驱动 | 两个状态源彼此独立，按钮不能证明等待行正确 | 等待行是否被布局遮挡 |

### Evidence limits

- 没有连接原 Electron 窗口的 DevTools，因此没有读取事故当时的 `AgentEventBus` 快照；`responding` 是由「截图有文本」+ `publish()` 逻辑推出的确定结果，不是现场采样。
- 静默期具体耗在 reasoning 还是 `write` 参数生成无法从截图区分；两者都不会产生可见事件，修复对两者同样生效。
- 曾把「线程键不匹配导致快照为空」列为次因（`mainThreadId` 与 `threadListItem.id` 不同）。assistant-ui 的 `mainThreadId` 是本地 item id，`initialize()` 只填 `remoteId`，adapter 也用同一 `threadListItem.id` 建键，因此未按次因处理；若修复后等待行仍完全缺失，应优先测量这两个键，而不是再调阈值。
- 滚动与布局被排除：等待行紧跟消息列表渲染，截图中消息下方是空白区域。

## Root Cause

**直接根因**：进度反馈被绑定在「是否已有文本」上，而不是「最近是否有可观测进展」。phase 只有 `working`/`responding` 两个活动态，`responding` 没有携带时间信息，因此无法区分「文本正在持续流入」与「文本已停、模型进入长时间静默」。

**促成条件**：

1. 后端的最小暴露原则只转发 `text_delta`，静默期没有任何帧；该过滤是安全上正确的决定，但实现等待行时把过滤后的流当成了完整事实。
2. 「停止生成」与等待行使用两套状态源（assistant-ui `isRunning` 与 `AgentEventBus` phase），验收只看了按钮，没有同时断言回答区的进度行。
3. 既有文档把等待行描述为「首个文本增量到达即移除」，把这一行为写成了预期，而没有覆盖文本之后的静默阶段。

## Fix

| 位置 | 内容 |
|---|---|
| `apps/desktop/src/features/agent/agent-event-bus.ts` | 新增 `lastEventAtByTurn` 与 `getLastEventAt(turnId)`；`begin()` 写入起始时间，`publish()` 对每个被接受的帧更新，包括 phase 已为 `responding` 的重复 text delta。放在快照外，避免每 token 触发 React 订阅者重渲染。 |
| `apps/desktop/src/features/agent/turn-progress.ts` | 新增 `TURN_PROGRESS_SILENCE_MS = 1_000` 与 `shouldShowTurnProgress(phase, lastEventAt, now)`；`working` 恒显示，`responding` 仅在静默阈值后显示，`idle` 永不显示。 |
| `apps/desktop/src/features/agent/AgentChatPage.tsx` | `TurnProgress` 改用该判定；抽出 `useSecondTick()` 每秒重渲染以跨过阈值并刷新耗时；把 `ReturnType<typeof agentEventBus...>` 换成事件总线导出的命名类型。 |
| `apps/desktop/tsconfig.electron.json` | 纳入 `turn-progress.ts`，供 Node 回归测试直接加载编译产物。 |
| `apps/desktop/test/agent-stream.test.cjs` | 新增两条回归：重复 text delta 仍刷新 liveness；`working`/流式/静默/`idle` 四种判定。 |
| `docs/current/platform/agent-runtime.md`、`architecture-and-code-placement.md` | 更新等待行规则与实现位置，删除「首个文本增量即移除」的旧表述。 |

验证：

- `npm run test:agent-stream --workspace @teachforge/desktop`：14/14。
- `npm run test:conversation-history --workspace @teachforge/desktop`：17/17。
- `npm run build:renderer --workspace @teachforge/desktop`：tsc + vite 通过。
- 浏览器回放（vite `5173` + stub `window.teachforge`，事件由真实 adapter/总线消费）：发送后显示「正在思考… 0s」；`text_delta` 后等待行消失且「停止生成」仍在；静默 1.6 秒后「正在思考… 9s」重新出现；下一 delta 后 1.3 秒内隐藏；连续 chunk 期间保持隐藏；`tool_execution_start` 后显示「正在写入 分布式锁、幂等与限流.md 1s」；`done` 后等待行消失并出现「已工作」摘要。

## Insight

**「没有新内容」不等于「没有工作」。** 当后端出于隐私或最小暴露过滤掉部分事件时，前端看到的流不再是运行状态的完整证据；任何由该流驱动的进行中 UI 都必须有独立的「最近进展」信号，而不能用内容类别（有没有文本）代替活性。

**两套状态源必须一起验收。** 「停止生成」可点只证明线程仍在运行；等待提示是否正确属于另一个断言。把它写进验收清单，可以避免同类缺口再次以「按钮还在，所以没问题」的方式通过检查。

**先复现状态机，再改 UI。** 用编译后的总线按真实事件顺序回放，几分钟内就排除了渲染、滚动与「停止按钮失效」等方向；这比反复截图更快，也能留下确定性证据。

## Failure Class And Recurrence

- Failure class id: `IM-003` — 把「已有内容输出」当成「仍在工作」的充分证据，忽略过滤后事件流的静默期。
- Recurrence count: `1`。
- Prior cases in this class: 无。
- Escalation required by count: 至少有可自动执行的判定与 liveness 回归；阶段语义若继续增长，必须落到 [ADR](../decisions/2026-11-15-chat-waiting-progress-signal.md) 的 B 方案，而不是继续堆前端阈值。

## Guardrails

- Test update: `apps/desktop/test/agent-stream.test.cjs` 固定「重复 text delta 刷新 liveness」与四种 phase/静默组合。
- Rule update: 等待行判据只有一个来源 `turn-progress.ts`；新增流事件类型或修改 phase 语义时，必须同时更新该判定与回归。
- Documentation update: current 文档删除「首个文本增量即移除」，ADR 记录 A/B 选择、切换条件与迁移步骤。
- Manifest route update: `agent-runtime` 路由加入本复盘与 ADR，后续改聊天事件流时会被路由到决策记录。
- Visual verification: 长文档请求下确认「前导文本 → 静默 → 等待行出现 → 工具动作 → done 后消失」。本次用 stub 桥接回放；Electron 窗口本身未直接驱动，作为已知验证缺口保留。

## Not Generalized

- 静默不等于故障：等待行出现只表示「当前没有可见进展」，不表示 provider 挂起或工具失败；不要据此自动重试、取消或提示错误。
- 不应把所有回答都常驻 spinner：文本持续流入时保留纯文本阅读，等待行只在静默后出现。
- 本次没有改后端事件契约，也没有把 thinking 或工具参数内容送进 Renderer；B 方案若实施，传输的仍应是不含内容的阶段标记。
- 阈值 1 秒是当前模型与 provider 下的折中，不是普适常数；它的调整不代表根因消除，切换条件见 ADR。
