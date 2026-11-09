---
status: current
layer: change
domain: agent-runtime
canonical_for:
  - rehearsal-digest-delivery-verification
last_verified: 2026-11-09
version: 1.0
---

# 演练评估入普通对话：验收

- 日期：2026-11-09

## 自动检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端类型 | `npx tsc --project tsconfig.build.json --outDir .test-dist` | 通过 |
| 后端构建 | `npm run build` | 通过 |
| 演练域回归 | `node --test test/rehearsal.test.cjs` | 10/10 通过 |
| 快照清洗回归 | `node --test test/session-entries.test.cjs` | 5/5 通过 |
| Chat/LLM 装配 | `node --test test/agent-stream.test.cjs` | 7/7 通过 |
| 相邻域回归 | `node --test test/conversation-history.test.cjs test/conversation-delete.test.cjs test/chat-attachments.test.cjs test/knowledge-context.test.cjs` | 23/23 通过 |

## AC

| AC | 断言 | 证据 |
|---|---|---|
| AC1 只取未投递 | 首次构建返回摘要与 `rehearsalIds`，置位后再构建返回空文本、`refsJson = null` | `test/rehearsal.test.cjs` · `the 15th question completes with a report and powers the normal-chat digest` |
| AC2 置位落库 | `rehearsals.loadedContext` 在投递后为 `1` | 同上 |
| AC3 装配正确 | `ChatService` 调用 `llm.stream()` 时 `contextMessage = { type: 'rehearsal_digest', text }`，且 `promptContext` 不含摘要；同时写入 `contextRefsJson.rehearsals` 并调用 `markDigestDelivered` | `test/agent-stream.test.cjs` · `ChatService hands the rehearsal digest over once and marks it delivered` |
| AC4 进入 Pi 上下文 | `appendCustomMessageEntry(type, text, false)` 在 `prompt()` 之前调用；无 `contextMessage` 时不追加 | 同上 · `durable context is appended as its own Pi message entry before prompting` |
| AC5 不被快照清洗 | `replaceInjectedUserText()` 对 `custom_message` 条目原样返回，同时清理同批的附件块 | `test/session-entries.test.cjs` · `durable custom message entries survive the snapshot cleanup` |
| AC6 迁移与回填 | 新列 `loadedContext boolean NOT NULL DEFAULT (0)`，既有 completed 演练升级后仍投递一次 | `test/rehearsal.test.cjs` 在临时目录执行真实迁移 |

## SDK 契约实测

用真实 SDK 复现"追加 → 序列化 → 恢复 → 转 LLM 消息"：

```text
entry: {"type":"custom_message","customType":"rehearsal_digest","content":"## 此前的演练记录\n薄弱点：MECE 的互斥性","display":false,...}
roles: user
text: "## 此前的演练记录\n薄弱点：MECE 的互斥性"
```

结论：条目经 JSON 往返后仍在 `getEntries()` 中，`buildContextEntries()` + `sessionEntryToContextMessages()` + `convertToLlm()` 将其转成 `role: user` 的消息，文本原样到达模型。

## 未覆盖

- 真实模型的连续多轮对话（需要 Provider 凭据）；本轮只验证到"摘要作为 user 消息进入上下文"的 SDK 契约与装配层。
- Pi 压缩发生后摘要是否保留：未做验收，设计上接受被压缩。
- 快照丢失后用 `messages` 重建时摘要不会恢复：已知后果，未做补偿。
