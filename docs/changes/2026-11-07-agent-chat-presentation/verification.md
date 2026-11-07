---
status: implemented
layer: change
domain: agent
canonical_for:
  - agent-chat-presentation-verification
last_verified: 2026-11-07
version: 1.0
acceptance_review_status: approved
---

# Agent Chat Presentation Verification

## Test Layer Taxonomy

- **L1 — Local Logic Verification**：TypeScript renderer build，验证依赖、组件类型与 bundle。
- **L2 — Automated Real-World Verification**：本次不增加自动化测试或服务联动检查；stream bridge 契约保持原样。
- **L3 — Human-Aided Verification**：桌面实际窗口截图对照，验证布局、工具状态 disclosure 与 markdown 流式呈现。

## Verification Results

| Layer | Result | Evidence / limitation |
| --- | --- | --- |
| L1 | pass | `npm run build:renderer --workspace @teachforge/desktop` passed TypeScript and Vite production build. Vite reports the minified JavaScript bundle exceeds 500 kB. |
| L2 | not run | Automated tests were not run. |
| L3 | partial | A local Vite preview using temporary synthetic events confirmed running/completed tool rows, per-turn elapsed time, safe path-only display, and borderless Markdown with headings, lists, and inline code. The preview branch was removed afterward. This preview did not exercise Electron preload or the real backend bridge. |

Electron visual verification could not be completed: the existing Electron window was minimized, and starting the development process failed with `EBUSY` while trying to remove the locked `apps/backend/dist` directory. The local preview was 1280×720 and the supplied reference was 1880×1150, so the overall shell width and responsive layout have not been compared at the same viewport. The changed-files diff card remains out of scope because current stream events do not provide diff counts or review/undo operations.

## Acceptance Criteria（代码级验收规则）

### AC-01 助手最终回答无边框

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/desktop/src/features/agent/AgentChatPage.tsx` 的 `AssistantMessage()` |
| 前置条件 | Runtime 显示 assistant message |
| 预期行为 | 助手正文容器不绘制卡片外框、白色卡片底色或卡片内边距；错误仍由 `MessagePrimitive.Error` 呈现 |
| 禁止出现 | 用户消息失去右对齐气泡；回答内容被裁切或被空白占位遮住 |
| 判定方式 | 代码检查与桌面截图对照 |

### AC-02 助手 Markdown 通过 assistant-ui 消息部分渲染

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AssistantMessage()` 中的 `MessagePrimitive.Parts` |
| 前置条件 | assistant message 的 text part 包含标题、列表、链接、表格或代码块 |
| 预期行为 | Text part 交由 assistant-ui MarkdownText renderer 处理；user message 保持普通文本 |
| 禁止出现 | 使用 `dangerouslySetInnerHTML` 将模型 Markdown 直接注入页面 |
| 判定方式 | 依赖/组件代码检查及桌面渲染检查 |

### AC-03 工具活动与各自用户消息关联并跨后续轮次保留

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `agent-chat-adapter.ts` 的 `agentChatAdapter.run()`；`AgentEventBus.begin()`、`publish()`、`clear()`、`getTurnSnapshots()`；`AgentChatPage.tsx` 的 `ThreadPrimitive.Messages` |
| 前置条件 | 第一轮至少出现一个工具事件，用户随后提交第二轮 |
| 预期行为 | 第一轮活动仍显示在第一轮 user message 下；第二轮事件只更新第二轮快照 |
| 禁止出现 | 新轮 `begin()` 清除历史轮，或迟到的旧 request 事件更改新轮状态 |
| 判定方式 | 状态流代码走查及桌面多轮交互检查 |

### AC-04 工具状态与总耗时准确

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `agent-event-bus.ts` 对 `tool_execution_start/end`、终态与 `clear()` 的处理；`AgentActivity()` 的时间显示 |
| 前置条件 | 工具开始、成功结束、失败、或请求取消 |
| 预期行为 | 展示 running/completed/failed/cancelled；运行时总耗时递增，结束后冻结；未结束的工具在取消时标成 cancelled |
| 禁止出现 | 总耗时在新轮开始后继续变化，或失败/取消显示为成功 |
| 判定方式 | 状态转换代码走查及实际交互检查 |

### AC-05 工具展示仅呈现安全摘要

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentActivity()`、工具摘要格式化函数、`AgentToolActivity` |
| 前置条件 | `tool_execution_start.args` 含 `path`、`content` 等字段 |
| 预期行为 | 展示工具动作、字符串路径和状态；完整工具参数及结果不进入 UI |
| 禁止出现 | JSON 参数面板、`content`、工具 result、完整 Pi event payload |
| 判定方式 | Renderer 代码走查；以带 path/content 的实际安全事件检查可见内容 |

### AC-06 工具区可折叠且不伪造文件差异操作

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentActivity()` 的 disclosure 和各工具行 |
| 前置条件 | 当前轮存在一个或多个工具记录 |
| 预期行为 | 工具摘要/耗时可见，详情默认展开且可用键盘折叠；路径长时换行；显示状态文字与图标 |
| 禁止出现 | 无事件来源的文件增删行统计、Review、Undo 控件或本地路径链接 |
| 判定方式 | 代码走查、键盘检查与同视口截图对照 |

## Required Automated Checks

```bash
cd apps/desktop
npm run build:renderer
```

- [L1] `npm run build:renderer`：运行 renderer TypeScript 编译并生成 Vite bundle；不运行测试脚本。

## Required Manual Checks

- [L3] 在桌面 Electron renderer 中检查至少两轮对话：
  - 原因：截图视觉匹配、Electron shell 样式和 native disclosure/滚动行为需要实际窗口确认。
  - 执行人：实现者。
  - 判断标准：助手回答无卡片外框；GFM 内容可读；工具过程位于对应 user message 后并保留历史；running/complete/failed/cancelled 与耗时正确；键盘可折叠；窄窗口无水平溢出。

## Must-Not-Break Checks

- [ ] 发送文本、增量回答、停止生成与错误提示继续可用。
- [ ] 新一轮开始不清除历史消息和对应工具摘要。
- [ ] 工具结果、文件内容和未筛选的 Agent payload 不显示给 Renderer 用户。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| 首轮包含 write/edit/read 工具调用 | 工具区显示动作、路径、状态和总耗时；回答无卡片框 | L3 | Electron 对照截图 | 覆盖参考图主要结构 |
| 连续两轮都调用工具 | 两轮工具活动分别保留并关联正确用户消息 | L1/L3 | EventBus 走查 + Electron 操作 | 防止全局快照错配 |
| 工具失败或请求取消 | 失败/取消状态明确且总耗时冻结 | L1/L3 | 状态走查 + Electron 操作 | 避免误报成功 |
| Markdown 链接/图片使用外部 URL | 只遵循 renderer URL policy，不打开本地文件路径 | L1/L3 | 组件配置走查 + 页面操作 | 不扩大 Renderer 本地权限 |
| 窄窗口和长路径 | 文本换行、无水平滚动溢出 | L3 | 调整窗口宽度 | 覆盖桌面布局适配 |

## Known Guardrails

- 不将 L1 build 当作真实桌面交互或视觉验收的充分证据。
- 按项目要求，本次不新增或运行自动化测试。
- 不因视觉相似而向 Renderer 传递原始工具结果或增加文件系统操作。

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
| --- | --- | --- |
| 在 MessagePrimitive 外部另建第二套消息/工具状态 | 与 Runtime 消息生命周期失配 | EventBus 仅扩展当前 bridge 活动元数据，并按 user message id 索引 |
| 用“+N/−N”装饰模拟文件差异 | 后端没有可靠差异数据 | 本次不显示；另立数据契约和评审/撤销实现 |
| 将 Markdown 字符串转为原始 HTML 注入 DOM | 允许模型输出扩大页面注入面 | 使用 assistant-ui MarkdownText renderer |

## When To Read History

- `docs/changes/2026-11-06-agent-streaming-loop/design.md`：仅当调整 adapter 或 desktop stream bridge 契约时。

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | `AssistantMessage()` 与 `MessagePrimitive.Error` 均已存在；样式判定可直接检查。 |
| AC-02 | pass | `MessagePrimitive.Parts` 已用于助手文本；用户消息有独立 `UserMessage()`。 |
| AC-03 | pass | `run()`、消息 `id`、`AgentEventBus.begin/publish/clear` 与 request id 校验均为真实代码实体；本次仅扩展 Renderer 映射。 |
| AC-04 | pass | `AgentEventBus` 已处理工具 start/end、done/error 与取消清理，工具状态 union 已存在。 |
| AC-05 | pass | `tool_execution_start.args` 在现有格式化逻辑中仅读取 `path`，安全字段边界真实存在。 |
| AC-06 | pass | 当前 `AgentActivity()` 使用 native `details/summary`，没有 file diff 操作；验收只约束现有 UI 区域。 |

- 评审结论：AC 已协商一致。
- 评审方 / 确认人 / 时间：Codex / 用户已授权开始实施 / 2026-11-07。

### Design Review 通过后的代码定位复核

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | `AssistantMessage()` 当前包裹 `MessagePrimitive.Parts` 与 `MessagePrimitive.Error`；两者可分别保留正文排版与错误提示。 |
| AC-02 | pass | assistant-ui `MessagePrimitive.Parts` 支持 children part renderer；官方 MarkdownText 必须放在 text part 上下文中，实施时按官方组合方式接入。 |
| AC-03 | pass | 已核实安装版本的 `ThreadMessage` 基础消息有稳定 `id`；Adapter 可从最新 user message 取 id，EventBus 现有 request id 守卫可扩为按轮状态。 |
| AC-04 | pass | 当前 `AgentToolActivity.status` 已含 running/completed/failed/cancelled，`tool_execution_end.durationMs` 为可选单工具耗时；总耗时需由 Renderer 开始/终态本地测量。 |
| AC-05 | pass | 当前页面只读取 `args.path`，EventBus 保存 args 但不必将其整体渲染；后端结果仍不在 `AgentStreamEvent` 类型中。 |
| AC-06 | pass | 原生 `details/summary` 是现有 React 结构且与 assistant-ui Thread viewport 的 disclosure scrolling 兼容；不增加 file action API。 |

- 复核结论：AC 已逐条对照当前代码与已安装 assistant-ui 类型，并保持可判定。
- 复核方 / 确认人 / 时间：Codex / 用户已授权开始实施 / 2026-11-07。

## Version History
