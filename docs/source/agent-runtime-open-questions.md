# Agent Runtime 待办问题

- 状态：待评估，尚无工程决策
- 更新日期：2026-11-07
- 责任单元：Agent Runtime / LLM 上下文管理
- 关联：[Agent Runtime 当前实现](../current/platform/agent-runtime.md)

## 问题：是否仍需由 TeachForge 工程层负责上下文压缩？

Pi session 当前加载 `billion-context-pi` 扩展，并配置 `autoUpdate: false`、`delegate: false`。与此同时，TeachForge 每次请求仍从 SQLite 读取并发送全部可恢复历史，当前没有应用层的上下文裁剪或压缩。

待确认：在当前扩展及配置下，Pi SDK / `billion-context-pi` 是否已经负责上下文压缩；如果没有，TeachForge 是否需要实现自己的 token 预算、压缩触发与摘要持久化。

在此问题关闭前，不要假设扩展会自动压缩历史，也不要在应用层悄悄丢弃历史消息。

## 关闭问题前需要确认

- 查明该扩展在 `autoUpdate: false`、`delegate: false` 下实际执行的上下文管理行为，以及是否会改写发给模型的消息。
- 明确压缩由扩展负责、由 TeachForge 负责，还是保持当前不压缩；记录选择依据和长对话行为。
- 若新增应用层压缩，定义摘要/保留消息如何持久化并在后续请求恢复；保证 tool call 与对应 toolResult 不会被拆散或重复执行。
- 用长对话验证压缩触发点、恢复结果和中断后的状态，再更新 [Agent Runtime 当前实现](../current/platform/agent-runtime.md) 与相关验收标准。
