---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-10
updates_current:
  - docs/current/domains/rehearsals/index.md
  - docs/current/domains/rehearsals/api-contract.md
---

# 开始演练延迟与等待体验设计（无副作用优先）

## 1. 约束：无副作用优先

本设计的首要约束不是「最快」，而是**不改变任何既有观察面**：

- 持久化：`rehearsals` / `rehearsal_turns` 的行数、字段、状态迁移、写入时机不变。
- API：既有端点（`POST /rehearsals`、`GET latest` 等）的请求/响应形状、状态码、幂等语义不变；
  唯一新增是 §4.2 的只读阶段端点，不修改任何既有响应。
- 模型可见输入：system prompt、history entries、tool 暴露、thinking level、prompt 文本不变。
- 其他流程：普通对话的 session 创建、工具可用性、快照写入不变。
- 生命周期：不新增后台任务或定时器；唯一允许的跨请求状态是 §4.2 的只读阶段登记
  （进程内、TTL 清理、不参与任何状态判断、不落库）。

越界项一律单独列出、单独批准、可回退，并附差分证据（同输入下新旧路径的输出逐字段比较）。
默认只改 renderer；唯一例外是 §4.2 的 additive 只读阶段字段，不改变既有字段、状态码或控制流。

## 2. 现状与测量（零代码）

调用链与成本分布见 [brief.md](brief.md)。测量不需要新增日志，用现有事件即可还原：

| 指标 | 来源 |
|---|---|
| 端到端 | `rehearsal.start.completed.elapsedMs`、`rehearsal.http.start.completed.elapsedMs` |
| session 引导 | `llm.session.create.completed.elapsedMs`，细分看 `llm.session.create.phase` 时间戳 |
| provider | `llm.generate.completed.elapsedMs − llm.session.create.completed.elapsedMs` |
| 剩余（DB/落库/detail） | 端到端 − 引导 − provider |

决策门：

- provider 占比 > 70% → 真实延迟只能靠模型输入/输出或异步，属于 §7/§8，默认不做。
- 引导占比 > 30% → 评估 §6。
- 剩余占比 > 20% → 才考虑补一条临时 phase 日志；否则本地 SQLite 的毫秒级差异不值得为它加代码。
- 目标基线（开发机、DeepSeek、1–3k tokens 历史）：点击→首题 p50 ≤ 10s、p95 ≤ 25s，用作回归红线。

## 3. 候选与副作用矩阵

| 候选 | 改变的观察面 | 副作用 | 默认 |
|---|---|---|---|
| A 准备画面（进度条、阶段文案） | renderer | 无；不涉及后端 | **做** |
| A2 陈旧 start 结果防护 | renderer | 仅影响现有竞态（切走后旧结果串写） | **做**（修 bug） |
| A3 准备阶段播报 | 新增只读 `preparing` 端点 + 客户端轮询 | 进程内只读 Map，TTL 清理，不读写 DB、不参与控制流 | **做** |
| B 详情用内存对象组装 | 仅 DB 读取次数 | 响应 payload 必须逐字段相同 | 做，附等价测试 |
| B2 历史与摘要并行读取 | 仅查询顺序 | 无 | 可选，收益 < 10ms 则放弃 |
| C session 引导裁剪 | Pi session 构建过程 | Pi 内部行为可能变化（工具注册、reload 副作用） | 需批准 + 差分 |
| D start 异步化 | API 契约、状态机、生命周期 | 最大：后台任务、轮询、reconcile 规则、取消 | 需批准 |
| E 历史/摘要/thinking level | 模型输入与输出质量 | 计划/评估质量变化 | 需评测 + 产品确认 |

## 4. Phase A：等待体验与真实阶段（默认方案）

### 4.1 点击前：按钮状态

请求发出后开始表单立即被准备画面（§4.3）替换，因此不需要额外的防重复点击提示；
`RehearsalStore.start()` 另外忽略 `isStarting` 期间的重复调用。按钮文案改为「正在准备…」，
保持禁用与 `aria-busy`。

### 4.2 后端：真实准备阶段（只读、不落库）

新增 `RehearsalPreparingRegistry`（`apps/backend/src/rehearsals/rehearsal-preparing-registry.ts`）：

- `Map<conversationId, { rehearsalId; phase }>`；同一 conversation 至多一个活跃演练，键足够。
- TTL 10 分钟（覆盖最长「3 × 90s 模型调用 + 重试」）。
- 只在真实边界写入；只被新端点读取，不参与 reconcile、状态迁移或错误映射。
- 登记时机：通过活跃行检查之后、读取历史之前；失败行原地重试的分支同样登记；
  同 `startRequestId` 命中已有行时直接返回状态，不覆盖正在进行的登记（避免 409/重放请求改写进度）。
- 清理：`start()` 的 `finally` 删除；TTL 只是进程异常时的兜底。

只读端点：`GET /api/conversations/:conversationId/rehearsals/preparing`
返回 `{ rehearsalId, phase } | null`。它**不读数据库、不做 reconcile、不写任何行**，
因此准备期间的轮询不会碰 `updatedAt`，也不会和 `preparing` 的 120s reconcile 宽限互相影响
（`GET latest` 每轮都 reconcile，用它轮询会带来这个风险，所以不复用）。纯诊断端点：未知会话或
未登记时一律返回 `null`，不产生 404。

| phase | 写入点 | UI 文案 |
|---|---|---|
| `history` | `getRestorableHistory()` 前 | 正在读取这次对话的学习内容 |
| `prior_summaries` | `loadDigestItems()` 前 | 正在回顾之前的演练记录 |
| `session` | `llm.generate` 的 session 引导开始 | 正在加载模型和对话上下文 |
| `plan` | provider 调用开始 | 正在生成演练计划和第一道题 |
| `repair` | JSON 非法、进入修复重试 | 模型输出格式不对，正在重试 |
| `saving` | 写 plan + 首题的事务前 | 正在保存演练计划 |

阶段只用于文案；进度条由前端按预计时长推进（§4.3）。

- `session` / `plan` 的区分需要一个 additive 可选回调：`LlmGenerateOptions.onPhase?: (phase: 'session' | 'provider') => void`，
  仅 rehearsal 传入；chat 不传，行为不变。回调只做 Map 写入，不抛错、不阻塞。
  退化实现（不提供回调）时 `session` 不出现，文案会从「正在回顾之前的演练记录」直接跳到
  「正在生成演练计划和第一道题」，进度条不受影响。
- 客户端轮询：start 未返回期间每 1s 拉一次该端点；start resolve/reject 后立即停止。
  页面不可见时降到 5s，重新可见立即拉一次。端点返回 `null`（尚未登记 / 进程重启）时显示通用文案。
- 轮询与请求同生命周期，不设额外上限；请求本身由每次模型调用的 90s 超时约束。

副作用清单：一个进程内只读 Map、一个新只读端点、客户端轮询；无 DB 读取、无 DB 写入、无迁移、
无后台任务、无既有响应变化。进程重启后 Map 丢失，UI 回退通用文案，不影响任何状态。

### 4.3 独立准备画面：进度条 + 状态文案

`isStarting` 时整个演练视图渲染独立的 `RehearsalPreparing`，替换开始表单（「开始演练」与
「开始新的演练」共用）。不进入 session 壳层（那会展示后端尚未确认的状态）。

版式（垂直居中卡片，与开始页同宽）：

1. 标题：`正在准备这次演练`
2. 进度条：圆角、emerald 填充；`role="progressbar"`，`aria-valuemin=0`，`aria-valuemax=100`，
   `aria-valuenow=<预计进度>`，`aria-valuetext=<状态文案>`。
3. 状态文案（进度条正下方，`role="status" aria-live="polite"`，1s 节流）：§4.2 的真实 phase 文案；
   端点返回 `null`（请求刚发出 / 进程重启）时显示 `正在准备第一道题…`。
4. 说明：`演练不会修改对话模式消息`。

不显示已用时间或预计时长。等待较久（> 45s）时，只在状态文案下方追加一行
「模型响应较慢，请继续等待；如果一直失败，可以检查设置里的模型服务。」，同样不带任何时间数字。

进度语义（用户确认的假进度条）：

- 进度条位置由前端按预计时长平滑推进：`estimate = 90 × (1 − e^(−elapsed/8000))`，
  约 8s 到 57%、20s 到 83%、45s 到约 89%，上限 90%。
- 只有后端真正返回首题（`start` resolve）后，进度条才补到 100%；未完成时永远不会看起来已经完成。
- `phase` 只驱动文案，不再驱动填充；阶段切换不改变进度条位置，避免「一步跳到 60% 又开始等」。
- 不显示百分比数字；前缘流光表示仍在进行。
- 失败时不补满：直接离开准备画面并显示错误，避免把失败显示成完成。

完成：start resolve 后先停止轮询、把进度条补到 100% 并显示「准备完成，正在进入演练…」，
约 450ms 后切到 session。补齐期间保持当前画面，避免进度条停在半途就跳走。
失败：离开准备画面，回到开始页并显示既有错误横幅与可执行文案，按钮恢复可点；
90s 超时的 504 文案指向设置里的模型服务与网络，不新增重试按钮。

不提供「取消」：同步请求没有服务端 abort 入口，前端取消只会让按钮复原而请求继续，
随后用户再点会得到 409——比没有取消更有副作用。取消属于 §7 的范围。

### 4.4 A2：陈旧结果防护（现有竞态修复）

`rehearsal-store.start()` 在 await 返回后不校验 `conversationId`：等待期间切换会话，旧会话的 detail 会写进
新会话的 store。修复为：apply 前校验当前 `snapshot.conversationId` 与本次请求一致，不一致则丢弃结果
（不写 detail、不写 error、不改 view）。只在竞态下改变行为，正常路径逐字段不变。

### 4.5 无障碍与动效

- 状态行 `aria-live="polite"`，1 秒节流，避免读屏器刷屏。
- 进度条用 `role="progressbar"` + `aria-valuetext`，读屏器读到的是阶段文案而不是裸数字。
- 尊重 `prefers-reduced-motion`：去掉进度条前缘流光，只保留静态填充。
- 按钮禁用时保留 `aria-busy`，完成后移除。

## 5. Phase B：等价微优化

只做「输出完全相同、少做几次本地读取」的改动：

1. `start()` 成功后不再调用 `getById()`（reconcile + 行 + turns 三次读取），直接用事务里的
   `plan` 与首题组装 detail。前置：确认 `toDetailView` 依赖的字段（含 `createdAt`）在内存实体中已就绪；
   用现有响应做逐字段对比测试。
2. `getRestorableHistory()` 与 `loadDigestItems()` 并行：两者互不依赖。若无可测收益则放弃，
   避免为几毫秒引入并发读取。

这两项不改变任何持久化行、不改变模型输入、不改变错误语义。

## 6. Phase C：结构化调用引导裁剪（需批准）

只对 `tools: []` + `loadMemory: false` 的调用生效；普通对话路径不动。候选按测量取舍：

| 项 | 改动 | 需要的差分证据 |
|---|---|---|
| 跳过 workspace 文件工具构建 | allowlist 为空时不 `createWorkspaceFileTools`，`customTools: []` | 新旧 session 的 system prompt 相同；模型调用 `write` 仍被拒绝；无文件写入 |
| 跳过 `resourceLoader.reload()` | 无 extension/skill/prompt 可加载时不 reload | appendSystemPromptOverride 仍生效；工具列表仍为空；无扩展副作用 |
| 缓存 `ModelRuntime` | — | **不做**：跨请求共享可变实例，设置变更/并发难以证明等价 |

明确不做：改 cwd（SessionManager 与资源解析基准会变）、共享 Pi session、跨请求缓存。

落地方式：给 `LlmService.generate()` 一个默认关闭的 `lightSession` 选项，仅 rehearsal 显式开启；
差分测试不通过就整体回退，不保留半套逻辑。

## 7. Phase D：start 异步化（需批准，默认不做）

这是唯一能真正消除感知等待的方案，但也是副作用最大的：

- API：`POST` 从「首题已就绪」变为「`preparing` 已创建」；桌面端类型、store、文档、测试全部跟随。
- 生命周期：新增后台任务与 lease；`preparing` 的行可能在没有客户端请求时完成或失败。
- reconcile：`preparing` 需要从「等 120s」改为「无活跃 run 立即 `failed`」，否则重启后卡死；
  该规则变化会影响所有读取路径。
- 取消：只有异步化后 `discard` 才能真正中止准备，前端「取消」才成立。
- 轮询：`GET latest` 1s 一次，页面不可见降频。

若批准，实施必须带上：

1. lease 在行插入后同步登记，中间不得 await，避免 GET 误判死行。
2. 失败/重启/重放/取消/切会话各有测试；同 `startRequestId` 重放准备中的行直接返回，不启动第二个任务。
3. 回退路径：删除后台调度、恢复同步 await 即可；进程重启会清掉后台任务，无残留状态。

收益是感知延迟与可取消，不是总耗时；总耗时仍由 §6/§8 决定。

## 8. Phase E：模型输入/输出（需评测，默认关闭）

| 项 | 变化 | 门禁 |
|---|---|---|
| 历史窗口 | 快照缺失时只重建最近窗口（如 40 条 / ~8k tokens） | 计划知识点仍有对话依据；首题可回答 |
| `learningSummary` 缩到 300–600 字 | 计划输出更短 | 后续评估与报告质量对照不下降 |
| `plan` 用 `medium` thinking | 计划更快 | 同历史对照：知识点覆盖与首题质量不下降 |

任一项不达标就保持现状；不为了速度牺牲演练的核心质量。

## 9. 验收

无副作用部分（A/B）必须全部满足：

1. 既有端点（`POST /rehearsals`、`GET latest`、`GET /api/rehearsals/:id`）的成功/失败响应与改动前逐字段相同
   （含 `createdAt`、`progress`、`turns`）；新增端点只返回阶段，不改变任何既有字段。
2. `rehearsals` / `rehearsal_turns` 的行数与字段在成功、失败、重放、取消路径下与基线一致。
3. 模型可见输入无变化：system prompt 文本、history entry 数、工具列表、thinking level 相同。
4. 普通对话的 session 创建与工具可用性回归通过；rehearsal 仍无文件/命令工具。
5. 错误语义不变：422 / 502 / 504 / 409 的触发条件与文案与上一版一致。
6. 阶段来自真实边界：用阻塞的 fake model 在 start 未返回期间轮询 `GET .../rehearsals/preparing`，按顺序观察到
   `history` → `prior_summaries` → `session` → `plan`（或退化后的单一 `plan`），成功后登记已清理；
   端点返回 `null` 时 UI 回退通用文案，不触发任何状态迁移。
7. 轮询只读：准备期间 `rehearsals` / `rehearsal_turns` 的行内容与 `updatedAt` 不被修改；
   该端点不读数据库、不做 reconcile。
8. A2：准备中切换会话，旧结果不写入新会话；回到原会话仍能正常加载。
9. 桌面端：独立准备画面（标题、进度条、状态文案）、状态行节流、失败回退横幅在真实界面验证；
   进度条按预计时长推进且上限 90%，phase 只驱动文案；完成后补到 100% 并停留约 450ms 再切到 session；
   画面不出现已用时间或预计时长，也不显示百分比数字。

C/D/E 各自另立验收，未批准不进入实施。

## 10. 实施顺序

| Phase | 内容 | 是否改后端 | 批准 |
|---|---|---|---|
| 0 | 用现有日志取 5 次基线，确认占比 | 否 | 不需要 |
| A | 独立准备画面、真实阶段播报（additive 只读端点 + 轮询）、A2 竞态修复 | 是（additive） | 不需要 |
| B | detail 内存组装、（可选）并行读取 | 是（等价） | 不需要 |
| C | session 引导裁剪 + 差分 | 是 | 需要 |
| D | 异步 start + 壳层 + 取消 | 是（契约） | 需要 |
| E | 历史/摘要/thinking | 是（质量） | 需要评测 |
