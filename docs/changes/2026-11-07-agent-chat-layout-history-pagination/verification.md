---
status: draft
layer: change
domain: conversations
canonical_for:
  - agent-chat-layout-history-pagination-verification
related:
  - docs/changes/2026-11-07-agent-chat-layout-history-pagination/design.md
  - docs/current/domains/conversations/api-contract.md
last_verified: 2026-11-07
version: 2.0
acceptance_review_status: approved
---

# Conversation Chat Layout and History Pagination Verification

## Test Layer Taxonomy

验证文档区分局部逻辑、真实联动和人工验收；本次不新增或运行自动化测试，按任务约束只执行构建/类型检查及必要的视觉验收。

- **L1 — Local Logic Verification**：局部输入输出和分支检查。
- **L2 — Automated Real-World Verification**：自动化覆盖服务、数据库和真实运行时联动。
- **L3 — Human-Aided Verification**：无法由自动检查充分说明的视觉与交互验收。

## Acceptance Criteria（代码级验收规则）

### AC-01 默认最近消息页

| 要素 | 内容 |
| --- | --- |
| 代码位置 | GET /api/conversations/:conversationId/messages；ConversationsController.getMessages；ConversationsService.getConversationMessages |
| 前置条件 | conversationId 是现有 Conversation，且请求未带历史游标。 |
| 预期行为 | 响应只含最近最多 30 条有可见文本的 user/assistant 终态消息，数组按 sequenceNo 升序；分页元数据准确表示是否仍有更早的可见消息。 |
| 禁止出现 | 返回 31 条或完整历史；包含 toolExecution、toolResult、assistantTurn、pending、thinking 或工具参数/结果。 |
| 判定方式 | 对照实现检查查询上限、可见内容投影、升序输出和 hasMore 分支；构建检查 response 类型一致。 |

### AC-02 按需读取更早页

| 要素 | 内容 |
| --- | --- |
| 代码位置 | GET /api/conversations/:conversationId/messages；ConversationsController.getMessages；ConversationsService.getConversationMessages；MessageEntity.id / sequenceNo |
| 前置条件 | 请求带有一条已存在且属于该 conversation 的消息 ID 作为 cursor。 |
| 预期行为 | 仅返回 cursor 序号之前最近最多 30 条可见消息，结果升序；若还有更早可见消息则分页元数据为 true。 |
| 禁止出现 | 返回锚点或更新消息、跳过/重复已加载消息、接受另一 conversation 的锚点或隐式创建数据。 |
| 判定方式 | 检查同会话锚点约束、严格小于 cursor 的 sequenceNo 条件、倒序取数后反转及 hasMore 计算。 |

### AC-03 页面滚动边界

| 要素 | 内容 |
| --- | --- |
| 代码位置 | App；AgentChatPage；ConversationSidebar；ThreadPrimitive.Viewport |
| 前置条件 | 消息内容高度超过窗口可用高度，或会话摘要数量超过侧栏可用高度。 |
| 预期行为 | 文档/root 不滚动；侧栏列表和消息视口分别滚动；composer 与页面标题在各自区域固定可见。 |
| 禁止出现 | 第三个滚动容器、窗口整体随消息滚动、composer 被消息推出可视区域。 |
| 判定方式 | 在浏览器/桌面端检查 1440、768、390 宽度及多个窗口高度下的实际滚动条和 composer 位置。 |

### AC-04 前端按需加载与恢复

| 要素 | 内容 |
| --- | --- |
| 代码位置 | AgentChatPage.loadConversation；ConversationStore.setActiveConversationId；window.teachforge.request |
| 前置条件 | 用户选择会话或启动时恢复活动会话，分页元数据表示有更早消息。 |
| 预期行为 | 初始请求不带 cursor；入口出现；点击后请求比当前最早消息更旧的一页，将结果前置并保持可视阅读位置；完成后使用返回元数据决定是否继续展示入口。 |
| 禁止出现 | 加载中切换到另一会话后旧响应覆盖新线程；重复点击并发加载；错误时清空已加载历史；更新 LocalRuntime 的完整模型上下文读取规则。 |
| 判定方式 | 对照 AgentChatPage 的请求版本、忙碌状态、history 合并和 viewport 高度差补偿；检查 LocalRuntime 对话流保持不变。 |

## Required Automated Checks

~~~bash
# Desktop renderer TypeScript 和 Vite production build
npm run build:renderer --workspace @teachforge/desktop

# Backend TypeScript / Nest build
npm run build --workspace @teachforge/backend
~~~

- [L1] 两个 build 命令检查类型、DTO、调用方与生产打包的一致性；它们不声称覆盖 SQLite 运行时分页。
- [L2] 本次不增加或运行自动化联动测试；SQLite 分页行为通过 AC 代码走查和人工操作验收。
- 执行结果：`npm run build:renderer --workspace @teachforge/desktop` 通过；backend 的 `npm run build --workspace @teachforge/backend` 在清理已有 `apps/backend/dist` 时因 Windows `EBUSY` 未完成。替代检查 `npx tsc --project apps/backend/tsconfig.json --noEmit --incremental false` 通过。未添加或运行测试。

## Required Manual Checks

- [L3] 视口布局与滚动边界
  - 原因：视觉和真实滚动条位置需在浏览器/桌面端观察。
  - 执行人：实现者。
  - 结果：原布局在 1280×720 浏览器中用 LocalRuntime 注入 18 条长消息，并将消息 viewport 滚至最大 scrollTop 减 250px，复现一行消息文字延伸到 composer 底边以下 4px；viewport 与 sticky footer 之间有 12px 底部留白。当前布局下同一操作显示消息 viewport 底边 494px、composer 顶边 515px，消息文本被 viewport 裁切且没有绘制在 composer 下方。此前已在 production preview 检查 1440、768、390 宽度的双滚动区和固定 composer。探针只在浏览器内运行，未写入代码或测试文件。
- [L3] 分页历史阅读
  - 原因：阅读位置保持与实际消息顺序需要长会话交互确认。
  - 执行人：实现者。
  - 结果：未在真实 Electron bridge 上执行长历史交互；通过 renderer/backend 构建及代码走查核对默认页、同会话游标、前置合并、阅读位置补偿和失败重试分支。普通浏览器 preview 不含 Electron preload bridge。

## Must-Not-Break Checks

- [ ] Agent 活动会话仍能在启动时恢复并继续提问。
- [ ] 读取历史只显示可见 user/assistant 文本，不暴露工具活动和原始 Pi 内容。
- [ ] 历史失败和会话不存在时仍保留当前线程并提供安全恢复入口。
- [ ] Agent 流式运行、取消和会话内存档行为不被 UI 分页改变。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| 少于 30 条可见消息 | 返回全部并报告没有更早页 | L1 / L3 | 查询分支走查与人工页面检查 | 确认短会话无需虚假加载入口 |
| 超过 30 条可见消息 | 首屏为最近 30 条，旧页可前置 | L1 / L3 | 查询分支与长对话人工检查 | 限制启动响应体并允许完整浏览 |
| 游标指向其他会话 | 返回 400 且不泄漏其他会话消息 | L1 | Controller/Service 分支走查 | 保持 Conversation 数据边界 |
| 长消息与长会话 | 仅内部两区滚动，输入区可见 | L3 | 多视口人工检查 | 防止整个页面失去输入控件 |
| 已有会话恢复并继续提问 | 活动 ID 与完整 backend 上下文保持不变 | L1 / L3 | adapter/ConversationStore 走查及人工验收 | 确保 UI 分页不裁剪模型上下文 |

## Known Guardrails

- UI 分页只限制 renderer 历史视图，不限制 Agent 请求恢复的 SQLite 完整历史。
- 安全投影仍只返回 user/assistant 纯文本终态消息。
- 不以 offset 分页替代稳定消息 ID 游标。
- 不把编译成功当作 SQLite 运行时行为的完整证明。

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
| --- | --- | --- |
| 首屏在前端加载完整历史后只隐藏旧消息 | 网络、解析和 runtime 负担仍随历史增长 | 后端固定读取最近 30 条 |
| 用 offset 跳过旧消息 | 新消息插入会使页边界移动 | 使用同会话消息 ID 定位序号 |
| 把消息页大小用于 Pi 上下文恢复 | 会意外截断 Agent 的后端上下文 | 分离 Renderer 可见历史和模型完整历史 |
| 仅凭编译通过宣称分页端到端正确 | Build 不验证数据库边界和消息顺序 | 如需证明完整运行时行为，增加 L2 真实 SQLite 验证并执行人工视觉验收 |

## When To Read History

- 阅读当前 Agent Runtime 与 Conversation 当前事实；避免将新 UI 分页误应用到 Pi 的完整上下文恢复。

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | 当前 endpoint、Controller.getMessages、Service.getConversationMessages 和可见文本投影均存在；messages/hasMore 是本次明确新增的响应契约。 |
| AC-02 | pass | MessageEntity.id、conversationId、sequenceNo 与现有排序/索引均存在，可用于同会话稳定锚点；beforeMessageId 是新增查询契约。 |
| AC-03 | pass | App、AgentChatPage、ConversationSidebar、ThreadPrimitive.Viewport 均为现有代码入口，判定目标是可直接观察的滚动区域。 |
| AC-04 | pass | loadConversation、setActiveConversationId、window.teachforge.request、requestVersion 和 runtime.thread.reset 均存在；历史分页仅扩展该已存在读路径。 |

- 评审结论：AC 已协商一致
- 评审方 / 确认人 / 时间：实现者独立复核；Design Review PASS 无需额外确认；2026-11-07

## Version History

| 版本 | 触发 | 变更与影响 | 状态 |
|---|---|---|---|
| 1.0 | 初始实现 | 核对默认 30 条分页、游标读取及全屏滚动边界；完整历史分页未在真实 Electron bridge 上手动验收 | 已交付 |
| 2.0 | 用户反馈输入框底部露出消息 | 增加可重现消息露出的浏览器边界测量，并确认当前布局下无消息绘制在 composer 下方；renderer 构建通过 | 已完成 |

