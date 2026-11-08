---
status: current
layer: change
domain: conversations
canonical_for:
  - conversation-tool-activity-history-verification
last_verified: 2026-11-08
version: 1.0
acceptance_review_status: approved
---

# Conversation Tool Activity History Verification

## Test Layer Taxonomy

验证文档应区分三层测试。每个检查点必须明确属于其中一层，不能为了省事把 L1 当 L2 用，也不能把本可自动化的 L2 推到 L3。

- **L1 — Local Logic Verification**：局部逻辑验证，用单元测试 + mock 覆盖单个类/方法的输入输出、分支、异常和状态回写。只证明代码在当前假设下行为正确，不证明真实世界行为。
- **L2 — Automated Real-World Verification**：自动化真实联动验证，用集成/端到端测试覆盖多服务、数据库、缓存、外部 API 的真实交互。大多数真实联动场景应放在这一层。
- **L3 — Human-Aided Verification**：人工协同验证，仅用于自动化成本过高或确实无法自动化的部分。

## Acceptance Criteria（代码级验收规则）

### AC-01 历史接口按 user turn 附带工具摘要

| 要素 | 内容 |
|---|---|
| 代码位置 | `GET /api/conversations/:conversationId/messages`; `ConversationsController.getMessages()`; `ConversationsService.getConversationMessages()` |
| 前置条件 | SQLite 中存在 user 行、assistant 文本行和该 user turn 范围内的 terminal `toolExecution` 行 |
| 预期行为 | 返回的 user DTO 包含与该 turn 关联的 `toolActivities`，并保留原有 user/assistant 文本分页与游标结果 |
| 禁止出现 | 将 `toolExecution` 作为顶层聊天 role 返回，或把工具参数、partial result、result 暴露给 Renderer |
| 判定方式 | SQLite-backed service test 检查活动摘要字段、关联 user ID、页大小和内容字段白名单 |

### AC-02 历史活动按稳定消息 ID 恢复到桌面 UI 状态

| 要素 | 内容 |
|---|---|
| 代码位置 | `AgentChatPage.loadConversation()`; `AgentChatPage.loadEarlierMessages()`; `AgentEventBus` history restoration method; `AgentChatPage` user-message activity lookup |
| 前置条件 | 历史响应中 user message 有 `toolActivities`，其 `id` 为后端持久化 message ID |
| 预期行为 | 页面加载或前置历史页后，`AgentEventBus` 在同一 user message ID 下提供 idle 工具活动，`AgentActivity` 可读取该快照 |
| 禁止出现 | 依赖旧 live renderer ID、把历史活动标为 running，或给未持久化的整轮耗时显示虚假计时 |
| 判定方式 | Desktop history test 用持久消息 ID恢复快照并断言工具状态；代码走查确认加载两种分页路径均调用恢复逻辑 |

### AC-03 新历史活动只持久化和返回安全展示字段

| 要素 | 内容 |
|---|---|
| 代码位置 | `ChatService` tool start projection; `ConversationsService.startToolExecution()`; `parseToolExecution()`; `ConversationMessageDto.toolActivities` |
| 前置条件 | Pi tool start event 包含参数对象，其中 `path` 为字符串 |
| 预期行为 | 工具执行记录可选持久化该路径字符串，历史 API 只返回 call ID、tool name、path、status 和 duration |
| 禁止出现 | 完整 `args`、`partialResult`、`result` 或 `toolResult` 内容进入 `toolActivities` |
| 判定方式 | Backend test 检查输出字段白名单及旧记录没有 path 时仍能投影活动 |

## Required Automated Checks

```bash
# L1：桌面历史活动恢复逻辑
npm run test:conversation-history --workspace @teachforge/desktop

# L2：ConversationsService 使用内存 SQLite 验证行筛选、turn 关联和投影
npm run test:conversation-history --workspace @teachforge/backend
```

- [L1] Desktop test 验证持久 message ID 上的历史 snapshot 及其终态，不启动 Electron 或模型。
- [L2] Backend test 使用临时内存 SQLite 和真实 TypeORM 查询验证 `getConversationMessages()` 的角色、分页和安全投影。
  - 适用场景：该错误发生在 SQLite 查询和 DTO 映射路径。
  - 前提条件：仓库依赖已安装；不需要 Provider、API Key 或外网服务。
  - 预计耗时：数秒。
  - 副作用：只写内存数据库；进程结束自动清理。
  - 清理策略：无需文件清理。

## Required Manual Checks

无。工具活动恢复、路径和状态都由本地数据库及 renderer 状态映射决定，可自动检查。

## Execution Results

- Desktop: `npm run test:conversation-history --workspace @teachforge/desktop` — 5/5 passed, including Electron TypeScript compilation.
- Backend: `npm run test:conversation-history --workspace @teachforge/backend` — isolated TypeScript compilation passed and 3/3 SQLite-backed cases passed.
- The test script uses `.test-dist` so it can run while the desktop app has the normal `dist` output open. No application data was changed.

## Must-Not-Break Checks

- [x] 切换会话后返回，用户消息和助手回答保持原样，并在对应用户消息下恢复工具活动。
- [x] 工具原始参数、结果与 Pi `toolResult` 内容不出现在历史 API 响应或恢复的 UI 状态中。
- [x] “查看更早的消息”仍以前一页文本消息 ID 为游标，并只在对应用户轮次恢复工具活动。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
|---|---|---|---|---|
| Load a conversation with completed tools | User and assistant text plus user-turn tool summaries are returned | L2 | Backend SQLite-backed history test | Reproduces the server side of the reported disappearance |
| Load an earlier page with tool rows between user turns | Each activity is attached to the preceding user in that page | L2 | Cursor case in backend history test | Prevents pagination from losing or cross-linking activity |
| Restore API activities in the desktop bus | Snapshot is idle and found by persisted user message ID | L1 | Desktop history test | Matches the UI lookup key after `thread.reset()` |
| Inspect response privacy | Only safe summary fields are returned | L2 | Backend response field assertions | Prevents tool args/results leaking through history |

## Known Guardrails

- L1 cannot establish the SQLite query behavior; AC-01 requires an L2 SQLite-backed check.
- Keep the in-memory SQLite test isolated from user databases and model credentials.
- Do not include raw tool arguments, partial output, or results in the public history contract.

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
|---|---|---|
| Add `tool` to the visible-message role filter | Persisted executions use `toolExecution`, and execution rows are not chat messages | Project execution rows as nested safe summaries under user turns |
| Reuse only the live event bus snapshot | Live IDs differ from durable history IDs and disappear after app restart | Rehydrate the bus from the backend history response |

## When To Read History

- Read `docs/changes/2026-11-07-conversation-session-persistence/verification.md` when changing the durable conversation row contract.

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
|---|---|---|
| AC-01 | pass | `ConversationsController.getMessages()` and `ConversationsService.getConversationMessages()` exist. `toolActivities` is the additive response field under review. |
| AC-02 | pass | `AgentChatPage.loadConversation()`, `loadEarlierMessages()`, `AgentEventBus`, and `AgentActivity` are current code anchors; no unimplemented method name is relied on. |
| AC-03 | pass | `ChatService.persistPiEvent()`, `ConversationsService.startToolExecution()`, `parseToolExecution()`, and `ConversationMessageDto` exist; `toolActivities` remains the target additive field. |

- 评审结论：AC 已协商一致
- 评审方 / 确认人 / 时间：Codex（同会话独立核对） / 用户已授权定向回归验证 / 2026-11-08

## Version History

- v1.0 (2026-11-08): Initial acceptance criteria and implementation verification.
