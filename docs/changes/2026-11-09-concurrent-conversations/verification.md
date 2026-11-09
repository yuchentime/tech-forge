---
status: current
layer: change
domain: agent-runtime
last_verified: 2026-11-09
version: 1.0
acceptance_review_status: approved
---

# 多会话并行（后台生成）Verification

## Test Layer Taxonomy

- **L1 — Local Logic Verification**：注册表、按线程输入/活动状态和历史提交保护的单元测试。
- **L2 — Automated Real-World Verification**：Nest + SQLite 的创建、删除与运行互斥，以及 Electron bridge 真实流的既有回归。
- **L3 — Human-Aided Verification**：两个真实 Provider 流并行时的侧栏、焦点和视觉状态。

## Acceptance Criteria（代码级验收规则）

### AC-01 会话创建与删除互斥

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `ConversationsController`、`ConversationsService.createConversation()`、`ConversationsService.deleteConversation()`、`ConversationRunRegistry` |
| 前置条件 | 创建空会话，或目标会话已有 run/排队/删除占位 |
| 预期行为 | POST 创建 UUIDv4 空 Conversation；delete 在任何数据库 await 前取得同步占位，忙碌抛 HTTP 409，成功持有占位到事务和目录清理完成 |
| 禁止出现 | 运行中删除、失败路径遗留锁、删除失败后静默丢失会话 |
| 判定方式 | L1 注册表测试、L2 conversation-delete 测试与 Controller HTTP 断言 |

### AC-02 同会话串行、跨会话并行

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `ChatService.stream()` 和 `ConversationRunRegistry.acquire()` |
| 前置条件 | 两个相同或不同的 conversationId 同时请求 stream |
| 预期行为 | 同 ID 排队且最终释放；不同 ID 不等待对方；取消排队请求仍释放其运行权 |
| 禁止出现 | ChatService 私有尾链与删除使用不同锁，或一个 request 覆盖另一个 request 的锁状态 |
| 判定方式 | L1 注册表并发断言、既有 agent-stream 回归与结构走查 |

### AC-03 每线程的远端 ID 与输入草稿

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `thread-list-adapter.ts`、`conversation-runtime.ts`、`agent-chat-adapter.ts`、`attachment-store.ts`、`composer-command-store.ts` |
| 前置条件 | 草稿线程选择附件/命令后首次发送，或 A/B 分别编辑草稿 |
| 预期行为 | `initialize` 只创建一次远端会话；stream 使用该线程 remoteId；附件/命令以稳定 localThreadId 读取、冻结并仅在 stream 已建立后清理 |
| 禁止出现 | 读取全局活动会话、后台 `conversation` SSE 改变当前选择、A 草稿发送到 B |
| 判定方式 | L1 store/adapter 测试、L3 双会话附件和命令检查 |

### AC-04 后台运行、活动和历史隔离

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `App.tsx`、`conversation-runtime.ts`、`conversation-history-store.ts`、`agent-event-bus.ts`、`AgentChatPage.tsx` |
| 前置条件 | A 流运行时切 B，B 首次加载或翻页，A 的历史请求迟到或返回 404 |
| 预期行为 | A/B 各自有 LocalRuntime；活动映射按 requestId；历史提交校验线程实例、版本和 runEpoch；非源线程选择不变 |
| 禁止出现 | 全局 `thread.reset()` 覆盖另一个线程、后台响应改变当前选择、迟到历史覆盖新 run |
| 判定方式 | L1 纯历史状态机测试、L3 双会话并行检查 |

### AC-05 侧栏和摘要刷新

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `ConversationSidebar.tsx`、`thread-list-adapter.ts`、`AgentChatPage.tsx` |
| 前置条件 | 一项运行、另一项选择/新建/删除或 run 结束 |
| 预期行为 | 侧栏仅禁用运行/初始化/删除目标的删除；其他行与新建可用；run 结束的摘要刷新保留已访问线程和草稿 |
| 禁止出现 | 用全局 isRunning 置灰整列，删除 409 时乐观卸载本地线程 |
| 判定方式 | L1 组件测试、L3 人工可访问性与双流检查 |

## Required Automated Checks

```bash
npm run test:conversation-delete --workspace @teachforge/backend
npm run test:agent-stream --workspace @teachforge/backend
npm run test:agent-stream --workspace @teachforge/desktop
npm run test:conversation-history --workspace @teachforge/desktop
npm run build --workspace @teachforge/desktop
```

- [L1] 注册表、线程草稿/活动和历史提交保护的定向测试。
- [L2] SQLite 会话创建/删除与既有 Electron 流测试。

## Required Manual Checks

- [L3] 在真实桌面应用中让 A、B 分别生成，切换、新建、停止 A、删除已停止 A，并确认 A/B 附件、`/查询资料库` 命令及产物标签不串。
  - 原因：依赖真实 Provider 流、Electron 和 assistant-ui 的渲染生命周期。
  - 执行人：开发者。
  - 判断标准：符合 design.md §10.1–10.2。

## Must-Not-Break Checks

- [ ] 同一会话仍由后端串行；取消一个会话不取消其他会话。
- [ ] 历史仍按 30 条、稳定 Message ID 游标读取，且不暴露未允许的内容。
- [ ] 删除的事务顺序、目录 partial 语义和错误映射保持不变。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| run 与 delete 竞争 | run 先到返回 409；delete 先到则后到 run 安全失败 | L2 | conversation-delete | 防止数据库与目录竞态 |
| A/B 同时运行 | 事件和 UI 独立，切换不取消 | L3 | 双会话手工检查 | 核心用户路径 |
| 草稿首次发送 | 一次创建、输入不串 | L1/L3 | adapter/store tests | 最容易发生 ID 迁移错误 |
| 后台历史迟到 | 仅影响源线程 | L1 | history state tests | 防止 `reset` 覆盖实时消息 |

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | 已核验当前 Controller/Service 删除路径、TypeORM 事务和模块 DI；新注册表只替换现有私有尾链职责。 |
| AC-02 | pass | 已核验 `ChatService.stream()` 在 `beginTurn` 前取得现有 private lock；迁移为共享 registry 不改变日志边界。 |
| AC-03 | pass | 已核验当前 adapter 读取全局 `conversationStore` 和两个全局草稿 store；该 AC 直接约束其替换点。 |
| AC-04 | pass | 已核验页面当前 history `reset`/版本守卫及 EventBus 单活动槽；AC 覆盖必须迁移的状态边界。 |
| AC-05 | pass | 已核验侧栏全局 `isBusy` 禁用逻辑与摘要刷新入口。 |

- 评审结论：AC 已协商一致。
- 评审方 / 确认人 / 时间：Codex / 用户已通过“开始实施”授权 / 2026-11-09
