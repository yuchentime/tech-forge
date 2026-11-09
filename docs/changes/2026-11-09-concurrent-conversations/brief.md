---
status: draft
layer: change
domain: agent-runtime
created_at: 2026-11-09
---

# 多会话并行（后台生成）Brief

## Problem

Agent 页面全局只有一个 `useLocalRuntime`（`apps/desktop/src/App.tsx:10`），一个线程、一个 `isRunning`。一旦某轮回复在生成，侧栏「新建课题」和所有会话行都被置灰（`AgentChatPage.tsx:408` → `ConversationSidebar.tsx:50,117,184`），页面还主动拒绝切换、新建和翻页（`AgentChatPage.tsx:117,208,342`）。

这不是多余的 UI 限制。底层三处状态是单例，直接放开会串流：

- 发送时用全局 `activeConversationId` 作 `conversationId`，后端 `conversation` 事件又回写该全局值（`agent-chat-adapter.ts:76,90`）。
- `AgentEventBus` 只有一个 `activeRequestId`，第二个 run 会覆盖第一个的活动状态（`agent-event-bus.ts`）。
- `thread.reset()` 不中止正在执行的 run（assistant-ui 自身测试覆盖），迟到增量会落进新视图。
- 附件与斜杠命令是全局 store，切会话会串。

后端本身已经支持跨会话并行：`ChatService` 按 `conversationId` 串行、不同会话互不阻塞（`chat.service.ts:46,743-760`）；`LlmService` 每次请求独立 Pi session；Electron Main 用 `Map<requestId, stream>` 承载多条 SSE（`main.ts:59`）。缺的只是桌面侧的每会话运行态，以及「先创建会话」的接口。

## Decision / Scope

采用 assistant-ui 的多线程运行时：`useRemoteThreadListRuntime` + 每个线程一个 `useLocalRuntime`。已安装版本 `@assistant-ui/react@0.15.32` 的 client 模式固定开启 `backgroundThreads`，访问过的线程常驻，切走后 run 继续，每项 `isRunning` 实时可见。

| 能力 | 实现路径 |
|---|---|
| 会话列表/选择 | 新增 `ThreadListAdapter` 映射现有 `GET /api/conversations`；选择状态交给 `runtime.threads` |
| 新建会话 | 后端新增 `POST /api/conversations`；`initialize` 在首次发送时调用并拿到 `remoteId` |
| 每会话运行 | `runtimeHook` 内 `useLocalRuntime`；`run({ unstable_threadId })` 作为后端 `conversationId` |
| 历史加载/翻页 | 线程体挂载时加载最近 30 条并 `reset`；翻页逻辑保留，按活动线程执行 |
| 删除保护 | 后端集中会话锁并暴露 `isBusy`，运行中的会话删除返回 409；侧栏按行禁用 |
| 活动状态 | `AgentEventBus` 由单活动槽改为 `Map<requestId, turnId>`；页面只展示可见线程的 turn |

## Out Of Scope

- 跨应用重载 / 后端重启的「持久后台任务」与断线重连（本轮只保证同一 renderer 生命周期内的并行）。
- 同一会话内并行多轮（后端仍按 conversationId 串行）。
- 会话重命名 UI、归档、置顶、自定义分组。
- 运行队列面板、并发上限配置（可在后续增加只读保护）。
- 工具审批 / 人工介入流程；若将来引入，后台线程的 `requires-action` 需要单独设计。
- 修改模型上下文、历史裁剪或 Pi 快照策略。

## Acceptance 概要

- 会话 A 生成中，可切换会话 B、新建会话并继续对话；A 的回复在后台继续，切回 A 看到完整文本、工具记录与产物。
- 侧栏不再整列置灰；生成中的会话行显示运行指示；非运行行始终可点击。
- 同一会话重复发送仍被后端串行排队，UI 只锁该会话的发送按钮。
- 停止生成只作用于当前可见会话。
- 删除运行中的会话被拒绝（侧栏禁用 + 后端 409）；停止后可删除。
- A、B 的附件草稿、斜杠命令、产物标签互不串。
- 重启应用恢复上次活动会话；不同会话的 `chat.turn.*` 日志时间区间可重叠，同会话出现 `chat.conversation.queue.waiting`。
- 现有回归 `test:agent-stream`、`test:conversation-history`、`test:backend-request` 通过。

详细设计见 [设计文档](design.md)。
