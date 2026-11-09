# Agent Runtime 待办问题

- 状态：已结论（2026-11-09），保留来源与结论差异
- 更新日期：2026-11-09
- 责任单元：Agent Runtime / LLM 上下文管理
- 关联：[Agent Runtime 当前实现](../current/platform/agent-runtime.md)

## 问题：是否仍需由 TeachForge 工程层负责上下文压缩？

Pi session 当前加载 `billion-context-pi` 扩展，并配置 `autoUpdate: false`、`delegate: false`。与此同时，TeachForge 每次请求仍从 SQLite 读取并发送全部可恢复历史，当前没有应用层的上下文裁剪或压缩。

待确认：在当前扩展及配置下，Pi SDK / `billion-context-pi` 是否已经负责上下文压缩；如果没有，TeachForge 是否需要实现自己的 token 预算、压缩触发与摘要持久化。

在此问题关闭前，不要假设扩展会自动压缩历史，也不要在应用层悄悄丢弃历史消息。

## 结论

不需要额外的应用层压缩，也不需要接入 `billion-context-pi`：

- `billion-context-pi` 只有遗留类型别名，`DefaultResourceLoader` 未装载，未参与任何消息改写或压缩。
- Pi SDK 1.5.0 自带自动 compaction：当 `contextTokens > contextWindow - reserveTokens` 时，在发送新 prompt 前、工具批次结束后和运行结束后检查并压缩；provider 上下文溢出或可恢复的 `length` 结束会压缩后重试一次。手动 `/compact` 不是本应用的入口。
- 应用通过 `SettingsManager.applyOverrides()` 在内存中强制 `compaction.enabled = true`，不写全局 Pi 设置；即使全局设置显式关闭，该 session 仍会压缩，原设置文件保持不变。摘要以 `CompactionEntry` 进入 Pi 快照，下次请求随快照恢复，SQLite `messages` 保留完整历史。
- 离线验证见 `npm run verify:compaction --workspace @teachforge/backend`：全局设置 `enabled: false`、`reserveTokens = 126000` 时，恢复 40 条历史后，Pi 仍在发送本轮 prompt 前自动触发 `reason: "threshold"` 的压缩，`tokensBefore = 12000`、`estimatedTokensAfter = 604`，快照包含 compaction 条目，`llm.compaction.started/completed` 日志出现，且设置文件中的 `enabled` 仍为 `false`。

## 遗留限制

- 无 provider usage 时 Pi 按 `字符数 / 4` 估算 token，中文内容会被低估，可能晚于真实阈值才压缩。
- 本轮新注入的附件/知识块在发送前不计入阈值；因此溢出时依赖 overflow 恢复压缩并重试一次，仍可能失败。
- 压缩摘要是额外 provider 请求；失败会记录 `llm.compaction.failed`（只含 `errorMessageChars`），不中断本轮回答，也不向 UI/SSE 暴露摘要内容。
- 若未来需要应用层预算、按对话定制阈值或摘要审计，仍需另行设计和持久化契约；当前不预置这些能力。
