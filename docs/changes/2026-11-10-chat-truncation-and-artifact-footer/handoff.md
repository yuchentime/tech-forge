---
status: current
layer: change
domain: conversations
canonical_for:
  - chat-truncation-and-artifact-footer-handoff
created_at: 2026-11-10
review_status: pending
related:
  - docs/current/domains/conversations/backend-behavior.md
  - docs/current/domains/artifacts/index.md
  - docs/changes/2026-11-09-artifact-sidebar/design.md
last_verified: 2026-11-10
---

# Chat 截断语义与实时文件卡片 — 交接（待评审）

## 评审入口

- 状态：实现完成，等待技术评审；未提交、未推送。
- 工作区同时存在其他未提交改动（rehearsals、knowledge-profile 等）。**不要 reset/checkout**；评审请只看下面 10 个路径的 diff：

```bash
git diff -- \
  apps/backend/src/chat/chat.controller.ts \
  apps/backend/src/chat/chat.service.ts \
  apps/backend/src/llm/llm.service.ts \
  apps/backend/test/agent-stream.test.cjs \
  apps/desktop/src/features/agent/AgentChatPage.tsx \
  apps/desktop/src/features/agent/agent-event-bus.ts \
  apps/desktop/test/agent-stream.test.cjs \
  apps/desktop/test/conversation-history.test.cjs \
  docs/current/domains/conversations/backend-behavior.md \
  docs/current/domains/artifacts/index.md
```

- 范围内：后端聊天终态与错误语义；前端实时文件卡片的生命周期；对应测试与 current 文档同步。
- 范围外：模型 `maxTokens` / `reasoning` 配置（见“待评审决策点 3”）；Pi 快照中 thinking 残片的清理；UI 视觉改版。

## 问题一：中止后再发消息报错（后端）

### 现象

用户在会话 `7f67b4c3-…` 中发送 `确认` 后立刻中止，再发送 `A`，约 48 秒后收到通用错误：

```text
llm.stream.failed → chat.turn.failed → chat.http.stream.failed
errorType: Error
stack: LlmService.readAssistantText (llm.service.ts:1180)   # 修复前 dist 构建的行号
```

### 证据（只读检查本地 SQLite）

| 序号 | 角色 | 状态 / stopReason | content 块 | output tokens |
|---|---|---|---|---|
| 12 | user | completed | `确认` | — |
| 14 | assistant | cancelled / aborted | 仅 thinking（1073 字） | 0 |
| 15 | user | completed | `A` | — |
| 16 | assistantTurn | failed | — | — |
| 17 | assistant | completed / **length** | 仅 thinking（19501 字） | **8192**（reasoning 也是 8192） |

快照 `pi_session_snapshots` 同样保留 seq 17 的 thinking-only、`stopReason=length` 条目。

### 根因

1. 第二次请求的 Pi run 正常结束，但 provider 的 `finish_reason=length`：8192 个 output token 全部消耗在 reasoning，没有 text block。
2. `getLastAssistantText()` 只拼接 `type:text`；thinking-only 返回 `undefined`。
3. 旧 `readAssistantText()` 把“无可见文本”一律当成 `Error("Pi SDK completed without returning assistant text.")`，于是日志表现为 provider 故障。
4. 中止本身没有泄漏：锁已释放、快照已保存、abort 已 await。中止的副作用是 seq 14 只留下 thinking；OpenAI-completions 转换会丢弃“无 text 且无 toolCall”的 assistant 消息，所以第二轮重新从零规划 SVG，把输出预算耗在 reasoning 上。

### 修改

| 位置 | 内容 |
|---|---|
| `apps/backend/src/llm/llm.service.ts:104` | 新增导出错误 `LlmResponseTruncatedError` |
| `llm.service.ts:1240` | `classifyAssistantCompletion()`：先读最后一条 assistant 的 `stopReason`（`aborted→cancelled`、`length→truncated`），再判断文本是否为空 |
| `llm.service.ts:496` | `stream()` 遇到 `cancelled` 时以 cancelled 结束，不抛“空回复”；`length` 抛 `LlmResponseTruncatedError`（即使已有部分文本，本轮仍视为截断失败） |
| `llm.service.ts:728` | `generate()` 复用同一分类；`length` 同样抛 truncation，`aborted` 抛含 `cancelled` 的既有文案 |
| `apps/backend/src/chat/chat.service.ts:97,390,413` | 没有客户端断开信号但 assistant `message_end` 为 `aborted` 时，assistantTurn 记为 cancelled |
| `chat.service.ts:841` | 导出 `getPiMessageStatus()`：`error/length → failed`、`aborted → cancelled`，替换 `message_end` 的内联三元式 |
| `apps/backend/src/chat/chat.controller.ts:217` | SSE error 文案改为“模型输出达到长度上限，本次回答被截断。请重试，或把问题拆小后再发送。” |

### 契约变化

- DB schema、迁移、历史 DTO、状态枚举（`completed` / `failed` / `cancelled`）均不变。
- 行为变化：`stopReason=length` 的 assistant 行由 `completed` 改为 `failed`，与 assistantTurn 对齐；省略号截断的部分文本仍会保留在行内并进入可恢复历史。
- 行为变化：Pi 内部 abort（非客户端断开）不再以完成状态结束。
- 新增导出符号：`LlmResponseTruncatedError`、`getPiMessageStatus`。

### 明确取舍

没有新增 `truncated` 状态。前端 `isConversationHistoryMessage`、`buildRestorableHistory`、历史 DTO 都只接受 `completed/failed/cancelled`；新增状态会让整页历史校验失败。用 `failed` 是当前契约内让消息行与轮次状态一致的最小改动。

## 问题二：实时 SVG 文件卡片不显示（前端）

### 现象

本轮生成了 `逻辑思考知识地图.svg`，回答和 SVG 预览正常，但响应底部没有“已更改 1 个文件”卡片。该会话此前手动截图的会话（`research-new-domain.svg`）在历史里能正常显示同一卡片。

### 证据

- `artifacts` 行存在：`conversationId=7f67b4c3-…`、`fileName=逻辑思考知识地图.svg`、`contentFormat=svg`、`byteSize=11183`、`userMessageId` 对应用户的 `A` 消息。后端登记与映射没有丢失。
- 历史映射逻辑会选该轮最后一条 assistant（seq 26，有 856 字正文），重新加载会话时应显示历史卡片。

### 根因

1. SSE 顺序是 `artifact` → `done`。
2. `artifact` 事件把文件写进当前轮的 live 快照。
3. `done` 调 `agentEventBus.clear(requestId)`，同时删除 `activeRequestByThread` 映射。
4. `getSnapshotForThread()` 只按 `activeRequestByThread` 查找，映射没了直接返回空快照 → `LiveArtifactFooter` 卸载。
5. 发完消息不会自动重载历史，历史 `generatedFiles` 没有机会接管，所以本次会话一直看不到卡片。

### 修改

| 位置 | 内容 |
|---|---|
| `apps/desktop/src/features/agent/agent-event-bus.ts:36,59,106` | 新增 `lastTurnByThread`；`begin()` 记录线程与轮次；`done` 清空请求后，`getSnapshotForThread()` 回退到该线程最后一轮快照 |
| `agent-event-bus.ts:203` | `clearArtifacts(localThreadId?)` 支持按线程清除；历史接管时只清当前会话的实时卡片 |
| `apps/desktop/src/features/agent/AgentChatPage.tsx:222` | 历史加载成功后调用 `clearArtifacts(conversationId)`，避免同一响应出现两份卡片 |

`TurnProgress` 在 `phase !== 'working'` 时返回 `null`，保留最后一轮快照不会让加载动画残留。

## 测试

| 位置 | 新增内容 |
|---|---|
| `apps/backend/test/agent-stream.test.cjs:420` | `length` 抛 `LlmResponseTruncatedError`，不再报“空回复” |
| `agent-stream.test.cjs:451` | aborted thinking-only 一轮不抛错；下一轮正常完成 |
| `agent-stream.test.cjs:501` | ChatService 把 aborted assistant 记为 cancelled turn |
| `agent-stream.test.cjs:557` | `getPiMessageStatus()` 的四种映射 |
| `apps/desktop/test/agent-stream.test.cjs:223` | `artifact`→`done` 后文件仍按线程可读；其他线程为空；历史清空后消失 |
| `apps/desktop/test/conversation-history.test.cjs:93` | 修正仓库中已存在的失败断言：`restoreHistoryActivity()` 返回值包含 `artifacts: []`，旧断言未同步（与本 bug 无关，但挡住套件） |

## 验证记录

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端 Agent 流 | `npm run test:agent-stream`（apps/backend） | 14/14 通过 |
| 后端真实 SDK 正常路径 | `npm run verify:compaction`（apps/backend） | 通过（mock provider、compaction 正常） |
| 后端会话恢复 | `npm run test:session-entries` | 5/5 通过 |
| 后端历史 / 附件 | `test:conversation-history`、`test:chat-attachments` | 5/5、5/5 通过 |
| 渲染进程事件总线 | `npm run test:agent-stream`（apps/desktop） | 11/11 通过 |
| 渲染进程历史 | `npm run test:conversation-history`（apps/desktop） | 修正前 9/10（既有失败），修正后 10/10 |
| 渲染构建 | `npm run build:renderer`（apps/desktop） | tsc + Vite 通过 |
| 后端模块加载 | `node -e "require('./dist/chat/chat.controller.js')"` | 通过，无循环依赖 |
| 真实 SDK 截断烟测 | 临时脚本：本地 mock OpenAI provider 返回 `reasoning_content` + `finish_reason:"length"` | 抛出 `LlmResponseTruncatedError`；脚本已删除 |

**未覆盖**：Electron 窗口内的视觉复核。renderer 构建与状态单测通过，但“重启应用后卡片出现”仍需人工看一眼。

## 复现与人工验收

1. 重启 desktop dev 进程，加载新 renderer / backend。
2. 打开 `7f67b4c3-…` 会话：历史中应出现 `逻辑思考知识地图.svg` 卡片（历史路径）。
3. 新开一轮让其写出任意文件：流结束后卡片应保留在响应底部；不要出现两份。
4. 再发一条消息：上一轮实时卡片让位给新轮（设计如此）；切换会话再切回，历史卡片应接管。
5. 复现截断：让模型长推理耗尽输出预算，应收到“回答被截断”，且历史行状态为 failed。

## 待评审决策点

1. `length` 映射为 `failed` 而不是新增 `truncated`：接受当前契约限制，还是允许前端契约一起扩展？
2. `length` 即使已有部分文本也判为失败：是否应改成“保留文本 + 截断提示但不失败”？
3. **根因未修**：`llm-adapter.ts` 仍是 `reasoning: false`、`maxTokens: 8192`。同一提示词仍可能耗尽预算；本次只把误报变成明确提示。是否本变更内调整 output 预算/关闭 thinking？（输出预算已由 [ADR 2026-11-13](../../decisions/2026-11-13-deepseek-output-budget.md) 处理：`maxTokens = 65_536`、`contextWindow = 1M`；`reasoning: false` 仍保留待评估）
4. `generate()` 现在对 `length` 抛 truncation；排练侧最终落到通用 `BadGatewayException`。这是否符合排练的错误映射预期？
5. 实时卡片保留策略是“每线程最后一轮”。`lastTurnByThread` 不随历史加载删除；其规模受线程数约束，且 `snapshot` 本来就按轮次常驻。是否接受该内存取舍？
6. `AgentChatPage` 用 `conversationId` 作为本地线程 id 清除实时卡片，依赖 `switchToThread(conversationId)` 的既有约定。请确认 draft → 已保存会话的切换路径。
7. 截断文案与测试放置位置（继续放 `agent-stream.test.cjs`，还是拆独立套件）是否符合项目习惯。

## 后续（不在本次范围）

- 调大 reasoning 模型的 output 预算或显式关闭 thinking，从源头减少截断。
- 截断时自动续写一次，而不是直接失败。
- 中止/截断产生的 thinking-only 消息是否应排除在快照与历史之外。
