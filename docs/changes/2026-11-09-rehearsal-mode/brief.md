---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-09
---

# 演练模式（Rehearsal）Brief

## Problem

桌面端已经有「普通对话 / 演练模式」分段控件，但演练页仍是 `这是测试页面` 占位。产品要解决的是：教师在普通对话里学习一个主题后，切换到演练模式，由 AI 扮演一名学生，用费曼学习法的问答方式检验教师是否能独立解释，并根据回答决定继续追问还是换题。

这不是给普通对话换一个 system prompt。当前实现有三个硬约束：

- `pi_session_snapshots` 以 `conversationId` 为主键，`LlmService.stream()` 每轮结束都会 upsert 当前 Pi entries。演练若复用父会话 ID，会覆盖普通对话的模型上下文。
- `ChatService.beginTurn()` 和 Pi 持久化钩子按普通消息模型写 `messages`。演练的题、答、评估不是普通消息，塞进同一张表会让历史投影、附件、工具活动、删除都多一套分支。
- `LlmService` 当前只有 `stream()`；演练需要非流式的 JSON 决策调用，必须先补 `generate()`。

同时还有一个跨模式沟通问题：演练结束后，普通对话的下一次请求必须知道演练的问答和评估；用户可能先切回普通对话再继续，也可能在报告底部直接点「新的演练」。同步不能依赖用户走了哪条 UI 路径，必须在评估生成后立即落库。

## Decision / Scope

1. **演练是独立领域状态机。** 使用现有 `rehearsals` / `rehearsal_turns`，不写 `messages`；每次「开始演练」或「新的演练」创建新的 Rehearsal。
2. **限额口径。** 一次演练最多 15 次提问，包含追问和跳过；同一基础题最多 2 次追问。跳过消耗 1 个名额且不返还。第 15 问回答并评估后、或被跳过时，直接出报告，不再生成第 16 问。
3. **模型不决定提前结束。** 每题决策只允许 `follow_up` 或 `next_question`；结束只由用户手动触发或总提问数达到 15 触发。
4. **上下文注入。** 开场规划调用复用父会话的 Pi 快照（含 compaction），但只读不写；后续答题、跳过、报告调用只带 `learningSummary + plan + 已有问答 + 当前状态`，不重复注入完整普通历史。
5. **结果同步。** 演练报告落 `rehearsals.overallEvaluationJson` 与各 turn 的 `evaluationJson`；普通对话每轮通过 `promptContext` 注入最近 3 次演练的摘要，Pi 快照保存前由 `replaceInjectedUserText` 剥离。普通对话用独立「演练评估」卡片展示，不追加 assistant 消息。
6. **学生画像。** 可选文本框，命名「学生画像」。它只影响提问视角，不覆盖演练规则和 JSON 输出要求。
7. **演练 Agent 边界。** 代码写死的 system prompt；不加载 SOULS/style preference、不加载 pi-memory、不给文件工具；v1 不流式输出，使用 JSON 请求/响应。
8. **历史记录。** 演练模式内可查看当前 conversation 的历史演练列表；列表只返回摘要并分页，点击后按需读取该次的完整问答与评估。进行中演练与历史分开呈现，浏览历史不中止当前演练。

## Out Of Scope

- 语音演练、实时字幕、口语评分。
- 演练计划的人工编辑、知识点合并/排序。
- 跨会话或跨应用的演练恢复；v1 只恢复同一 SQLite 中未完成的 Rehearsal。
- 跨 conversation 的全局演练历史；历史范围限定在当前 conversation。
- 演练报告导出 DOCX/PDF、报告版本历史、人工重评。
- 让普通对话 Agent 通过检索工具主动查演练记录；v1 通过摘要注入 + transcript 文件路径。
- 新增账号、租户、多用户隔离。

## Acceptance 概要

- 有普通对话历史时可以开始演练；空会话禁用并给出提示。
- 开场生成主题、知识点计划和第一题；父会话 Pi 快照与 `messages` 均不被演练写入。
- 回答后先给本题评估，再按规则追问或换题；单题最多 2 次追问；总提问数不超过 15。
- 跳过不追问，消耗 1 个名额；跳过第 15 问直接出报告。
- 手动结束能中止进行中的模型调用，迟到的结果不写入。
- 报告包含逐题评估和总体评估；未作答、跳过、未验证内容有明确标注。
- 报告完成后，普通对话下一轮模型输入包含演练摘要，且 `contextRefsJson` 记录实际使用的 Rehearsal ID。
- 报告底部「新的演练」新建一批演练；是否先切回普通对话不影响结果。
- 演练模式内可以查看历史演练列表，并打开任意一次的完整问答与评估；进行中演练可随时回到当前题。
- 重复提交、并发提交、模型 JSON 非法、进程中断都有确定行为。

## 验证

见 [verification.md](verification.md)。
