---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-10
---

# 开始演练延迟与等待体验 Brief

## Problem

「开始演练」是一条同步长请求：`POST /api/conversations/:id/rehearsals` 在 `planAndCreateFirstTurn` 内完成
历史读取 → 历史演练摘要 → 新建 Pi session（加载 SDK、Provider、资源、cwd、重建历史 entries）→ 计划模型调用
（`thinkingLevel: high`，输出 500–1500 字摘要 + 3–8 个知识点 + 首题）→ 落库 → 再读一遍 detail，全部结束后才返回。

在这段时间里桌面端只做两件事：把按钮文字换成「正在准备演练…」并禁用按钮。用户在开始页上等待，
看不到进度、不能取消、也不能安全切走：切到别的会话后，这个仍未返回的 `start()` 会在完成时把
旧会话的 detail 写进当前 store（`start()` 没有校验 `conversationId`）；如果再回到原会话重试，
活跃行检查会返回 409「已有进行中的演练」。

## Decision / Scope

首要约束是**无副作用**：默认方案不改变持久化行、API 契约、模型可见输入、错误语义或普通对话流程。

1. **零代码测量**：用现有 `llm.session.create.*`、`llm.generate.*`、`rehearsal.start.completed` 日志
   拆分引导 / provider / DB 占比，不新增日志。
2. **独立准备画面**：`isStarting` 时用单独画面替代开始表单，包含按预计时长平滑推进的进度条
   （上限 90%，完成时补满）与进度条下的状态文案（阶段来自后端 `phase`）；不显示百分比数字或任何时长，
   也不提供假取消。
3. **等价微优化**：detail 用内存对象组装（响应逐字段不变）；可选并行读取，无收益则放弃。
4. **条件性方案**（需单独批准）：C session 引导裁剪（附差分证据）、D start 异步化（改 API 与生命周期）、
   E 历史/摘要/thinking level（改模型行为，需评测）。

阶段播报是唯一新增的后端内容：一个只读端点 + 进程内 Map（TTL 清理、不读写 DB、不参与控制流），
既有端点、状态码、模型输入与普通对话流程都不变。

本轮只产出设计，不改代码。

## Out Of Scope

- 修改 15 问限额、追问规则、报告生成流程。
- 为 answer / skip / report 做同样的异步化。
- 改模型供应商、默认模型或 thinking level（仅在批准并评测后作为可选优化）。
- SSE / WebSocket 推送。
- 跨会话预生成计划、预热池、进程级 session 缓存。
- 任何未经批准的持久化、契约或模型输入改动。

## 验收概要

- 既有端点响应与改动前逐字段相同；新增只读端点不改变既有字段；各类路径下行与字段不变。
- 模型可见输入不变：system prompt、history entry 数、工具列表、thinking level。
- 准备中的状态行来自后端真实阶段；轮询只读，不修改行；登记缺失时回退通用文案。
- 独立准备画面：进度条按预计时长平滑推进（上限 90%），完成后补到 100% 并短暂停留再进入 session；phase 只驱动文案。
- 准备中切换会话，旧结果不写入新会话（现有竞态修复）。
- 普通对话 session 创建与工具可用性回归通过。

设计见 [design.md](design.md)。
