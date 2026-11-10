---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-10
---

# 开始演练延迟与等待体验验收

## 实施范围

- Phase A：独立准备画面、真实阶段播报（只读端点 + 轮询）、A2 陈旧 start 竞态守卫。
- Phase B1：`start()` 用事务中写出的实体组装 detail，省掉 `getById()` 的三次读取。
- 未实施：B2（并行读取，无可测收益）、C（session 引导裁剪）、D（异步 start）、E（模型输入/输出调整）。

## 验证命令与结果

| 项 | 命令 | 结果 |
|---|---|---|
| 后端演练回归 | `npm --prefix apps/backend run test:rehearsal` | 19/19 通过 |
| 桌面 store 回归 | `npm --prefix apps/desktop run test:rehearsal` | 12/12 通过 |
| 渲染层类型 | `npx tsc --noEmit --project tsconfig.app.json`（`apps/desktop`） | 无错误 |
| 渲染层构建 | `npm --prefix apps/desktop run build:renderer` | vite 构建成功 |
| 后端编译 | `npx tsc --project tsconfig.build.json --outDir .build-check` | 通过（临时目录已删除） |
| 后端正式构建 | `npm --prefix apps/backend run build` | 未执行成功：`dist` 被运行中的进程占用（EBUSY）；以临时 outDir 编译代替 |

### 新增/调整的测试

- `the preparing registry maps phases to fixed steps and isolates tokens`：`step/total` 映射、`repair` 不前进、外来 token 不能改写/清除。
- `the preparing phase reports real stages and clears when start settles`：用阻塞的 fake model 观察到 `session` → `plan`，start 成功后登记为 `null`。
- `a failed start clears its preparing phase`：失败路径清理。
- `the preparing screen state follows the polled backend phase`：store 轮询把真实阶段写入快照；start 返回后先置 `preparingComplete`（进度条补满），约 450ms 后才写入 detail 并切到 session。
- `a start that settles after a switch does not write the new conversation`：A2 竞态守卫。
- `start is idempotent...` 内新增 `assert.deepEqual(detail, getById(...))`：固定「start 响应与重新读取逐字段相同」。

### 准备画面渲染核对

用临时脚本把 `RehearsalPreparing` 经 `react-dom/server` 渲染为静态标记（脚本已删除）。挂载时
`elapsed=0`，因此进度条都为 0；推进曲线由单元测试覆盖。

| 输入 | 状态文案 | 进度 |
|---|---|---|
| `null` | 正在准备第一道题… | 宽度 0，`aria-valuenow=0` |
| `plan` | 正在生成演练计划和第一道题 | 宽度 0 |
| `repair` | 模型输出格式不对，正在重试 | 宽度 0 |
| `saving` | 正在保存演练计划 | 宽度 0 |
| `plan` + `complete` | 准备完成，正在进入演练… | 宽度 100，`aria-valuenow=100` |

同时断言存在 `role="progressbar"`，且输出不含「已用」「通常需要」。完成态不再显示慢响应提示。

`estimatePreparingPercent` 的单元测试（桌面套件）覆盖：0 → 0；0–180s 单调不减；永远 ≤ 90；
5s < 45%；20s > 80%；60s > 88%。

## 无副作用核对

- 既有端点：`POST /rehearsals` 的响应由 `deepEqual(detail, getById)` 锁定；`GET latest`、`GET /api/rehearsals/:id` 的组装逻辑未改。
- 新端点：`GET .../rehearsals/preparing` 只读进程内 Map，不访问数据库、不做 reconciliation、不写行。
- 轮询：失败只保留通用文案；切换会话后不再写入新会话快照。
- 模型输入：未改 prompt、tools、thinking level；`onPhase` 只有 rehearsal 传入，chat 调用保持 `undefined`。
- 错误语义：422/502/504/409 的既有断言全部保持通过。

## 已知限制

- 未在 Electron 窗口中人工检查准备画面：渲染核对使用服务端静态标记 + 生产构建，动效、真实布局与 45s 慢响应提示未做窗口级验证。
- `start()` 仍是同步请求，总耗时不变；准备画面只降低等待焦虑，不减少首题时间。
- 进程重启会丢失阶段登记，画面回退到通用文案；这不影响状态机（`preparing` 的 reconcile 规则未改）。
