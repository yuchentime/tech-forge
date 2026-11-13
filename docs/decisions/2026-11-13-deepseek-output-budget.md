---
status: accepted
layer: decision
domain: agent-runtime
canonical_for:
  - deepseek-model-limits
related:
  - docs/current/platform/agent-runtime.md
  - docs/current/domains/conversations/backend-behavior.md
  - docs/changes/2026-11-10-chat-truncation-and-artifact-footer/handoff.md
  - apps/backend/src/llm/adapters/llm-adapter.ts
decided_at: 2026-11-13
---

# DeepSeek 模型的输出预算与上下文窗口

## Context

`llm-adapter.ts` 里的模型描述符长期硬编码 `contextWindow: 128_000`、`maxTokens: 8_192`，两者都没有来源，且与 DeepSeek 官方文档不符。2026-11-13 一次「画图」请求暴露了后果：

- 该轮 assistant 消息 `usage.output = 8192`、其中 `reasoning = 5754`，`stopReason = length`；thinking 占掉 70% 预算，`write` 工具参数在 2,438 token 内被截断。
- Pi 按设计拒绝执行截断的工具调用，文件从未写入；模型下一轮自行改成「先写骨架再 edit」并成功，整轮以 completed 结束。
- 同一会话总 token 已达 97,951，接近当时声称的 128K 窗口，长对话会进一步把可用输出压到几 K。

官方文档（[Chat Completions](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)、[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）当前声明：

| 事实 | 值 |
|---|---|
| `deepseek-flash` / `deepseek-v4-pro` 上下文长度 | 1M |
| 输出长度上限 | 384K |
| `max_tokens` | 可空；取值范围 1–384K；未设置时非思考模式默认 8K、思考模式默认 64K（`reasoning_effort=max` 时 128K） |
| 思考模式 | 省略 `thinking` 与 `reasoning_effort` 时默认开启，强度 high |

同时 Pi SDK 让「不设置」不可达：`pi-ai` 的 `simple-options.buildBaseOptions()` 总是计算 `options.maxTokens ?? model.maxTokens`，`openai-completions` 的 `buildParams()` 据此写入请求的 `max_tokens`；模型定义缺省 `maxTokens` 时，`provider-composer.modelFromJson()` 会填 16,384。

## Decision

1. `contextWindow = 1_000_000`。取文档「1M」的十进制值；若实际是 1,048,576，本值只会让 Pi 略早压缩，不会发出 provider 会拒绝的请求。
2. `maxTokens = 65_536`。这是文档中「未设置 `max_tokens` 时的思考模式默认值」，也就是 provider 自己会选的输出上限。应用既不发送 `thinking` 也不发送 `reasoning_effort`（描述符仍 `reasoning: false`），DeepSeek 实际按 thinking + high 运行，因此 64K 与厂商默认一致。
3. 不新增 `before_provider_request` 扩展去删除 `max_tokens` 字段。那会绕过 Pi 的 `clampMaxTokensToContext()`（它按 `contextWindow - 估算输入 - 4096` 收缩输出预算），长上下文请求会把整个窗口交给输出，更容易换来 provider 400；`isRecoverableLength()` 也依赖描述符里的输出上限。
4. `reasoning: false` 维持现状。把它改成 `true` 会让 Pi 开始发送 `reasoning_effort` 并参与 thinking 预算/压缩判断，需要独立评估，不在本次取值修正内。

## Alternatives

| 方案 | 未采用原因 |
|---|---|
| 干脆不写 `maxTokens` | SDK 会补 16,384 并照样发送，比厂商默认 64K 更小，等于把事故阈值从 8K 抬到 16K |
| 取文档最大值 384K | 那只是允许范围；未设置时厂商只给 64K。单响应成本上限放大 6 倍，收益不明 |
| 取 128K（`reasoning_effort=max` 的默认） | 应用不发送 `reasoning_effort`，provider 走 high；128K 只在 max 强度下才是默认 |
| 保留 128K 上下文窗口，只改 `maxTokens` | 长会话仍会被 128K 夹取：本事故会话已用 97,951 token，再几轮就会把输出压回几 K，同一故障会复发 |
| 通过扩展删掉请求里的 `max_tokens` | 绕过上下文夹取与恢复判断，长上下文请求更容易被 provider 拒绝，且丢失 Pi 的 `isRecoverableLength()` 依据 |

## Consequences

- 思考 + 工具调用不再被 8K 截断：本事故的 5,754 thinking 与随后的工具参数都有各自余量；`write` 一次写不完的大文件仍可能触发截断，但阈值回到厂商默认。
- 压缩阈值从约 128K（默认 reserve 16,384 时约 112K）抬到约 984K。长对话不再过早压缩，代价是单次请求可能携带更多历史。
- 会话知识事实的 prompt 预算 `getAvailableFactPromptTokens(contextWindow)` 随窗口变大（`contextWindow - 8192 - 10%`），长会话的事实生成请求会显著变大；输出预留与安全余量不变。
- 长上下文时 `max_tokens` 仍会被 `clampMaxTokensToContext()` 收缩；这不是固定预算，而是随输入缩放的余量。
- `verify-compaction` 不再写死 128000/126000：`reserveTokens` 由描述符 `contextWindow - 2000` 推导，并断言两次 provider 请求都携带 `max_tokens = 65,536`。
- 遗留：描述符声明 `reasoning: false` 与 provider「默认开启思考」不一致；Pi 因此不发送 `reasoning_effort`，强度与预算完全由 DeepSeek 决定。若要显式控制强度，需要单独决策。
