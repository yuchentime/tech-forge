---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-09
---

# 演练评估入普通对话：一次性投递 Brief

## Problem

演练报告已经能进普通对话的模型上下文，但方式是每轮重新渲染并拼进本轮 user message：

- 每个普通回合都从 SQLite 重查最近 3 次 completed 演练，渲染 ≤6000 字符的摘要；
- 摘要与本轮问题无关也照样发送，token 成本随回合数线性增长；
- 摘要存在时长短于一回合——保存 Pi 快照前由 `replaceInjectedUserText()` 清除，所以下一轮必须重新拼。

结果是"评估结果在上下文里"这件事只对紧随其后的那一回合成立，而它的代价却按每轮支付。

## Decision / Scope

改为一次性投递，并把投递结果变成 Pi session 里的持久上下文：

1. `rehearsals` 增加 `loadedContext` 布尔列；普通对话只取未投递的 completed 演练。
2. 摘要不再进入 `promptContext`，改由 `LlmService.stream()` 在 `session.prompt()` 之前调用
   `sessionManager.appendCustomMessageEntry('rehearsal_digest', text, false, ...)`：
   一条参与 LLM 上下文、界面不展示的独立消息，角色经 Pi 转为 `user`。
3. 投递当轮立即置 `loadedContext = 1`；之后轮次查不到该演练，不再拼接。
4. digest 不进入 system prompt、不进入 `messages`、不进入 SSE 与历史接口。

## Out Of Scope

- 压缩（compaction）后重新投递；由 Pi 决定其保留方式。
- 把 digest 文本落库作为权威副本（当前权威是 Pi 快照）。
- 把演练记录改成可检索工具或按需读取。
- 界面展示这条上下文消息。

## Acceptance 概要

- 演练完成后切回普通对话，模型能看到该次演练的总体评估、薄弱点与逐题评估。
- 随后的普通回合不再重新发送同一份摘要（查询为空、`contextMessage` 为 `undefined`）。
- 该 digest 存在于 Pi 快照条目中，保存在下一轮恢复的上下文里。
- `messages` 表、SSE、历史接口无新增内容。

## 验证

见 [verification.md](verification.md)。
