---
status: historical
layer: postmortem
domain: artifacts
created_at: 2026-11-10
last_verified: 2026-11-10
canonical_for:
  - chat-artifact-footer-lifecycle-incident
related:
  - docs/postmortems/index.md
  - docs/current/domains/artifacts/index.md
  - docs/changes/2026-11-10-chat-truncation-and-artifact-footer/handoff.md
---

# 2026-11-10 聊天文件卡片在终态丢失

## Summary

用户按“请求生成思维导图 → 立即停止 → 再次要求直接输出”的路径操作后，SVG 已写入会话工作区且 `artifacts` 表已有登记，聊天正文也说明文件已生成；但响应底部没有文件卡片，顶栏也没有“文件”入口。

问题不在文件写入或索引：旧 Renderer 在收到 `artifact` 后再收到 `done` 时，删除了该线程的活动请求映射，导致实时快照不可再读取。应用进程启动早于修复源码写入，用户最初观察到的是仍加载旧事件总线逻辑的窗口。提交 `886810f` 使终态快照按本地线程保留，并要求历史加载后才移交给持久化的 `generatedFiles`。

## Impact

用户无法从当前响应打开已生成的文件，也无法通过顶栏进入会话文件列表；文件虽存在于本地，但产品呈现为“已生成”的文字与不可见文件入口相互矛盾。

没有数据丢失、重复写入或错误删除：该案例中的 SVG 与 `artifacts` 行均可在本地只读检查中确认。影响范围是使用旧 Renderer bundle 的实时文件呈现；重新加载历史时，持久化映射本可显示同一文件。

## Trigger

在会话 `a22ae862-0820-4404-a179-433288f4432f` 中，用户先中止“写一份思维导图”，再发送“直接输出就好”。随后本地工作区存在 `systems-thinking-mindmap.svg`，但当前聊天响应缺少文件卡片和顶栏文件按钮。

## Facts

| 证据 | 可推出 | 不可推出 |
|---|---|---|
| `artifacts` 中有对应 `userMessageId`、文件名和会话工作区路径的记录 | 后端写入后的登记成功 | Renderer 已消费并呈现该记录 |
| 本地存在 `systems-thinking-mindmap.svg` | Agent 工具实际写入成功 | SSE 生命周期或顶栏计数正确 |
| 界面正文显示“已生成”但无卡片、无“文件”按钮 | 文字输出与文件 UI 状态脱节 | 文件不存在或数据库写入失败 |
| 旧事件顺序为 `artifact` 后 `done` | 终态清理会发生在 artifact 到达之后 | `done` 之后仍有活动请求可读取 |
| 运行中的应用早于修复源码启动 | 用户当时未运行修复后的 Renderer | 源码修复在新 bundle 中仍然无效 |

## Root Cause

**直接技术根因**：`agentEventBus.clear(requestId)` 在 `done` 时移除 `activeRequestByThread`；`getSnapshotForThread()` 只从该映射找请求，所以即使 artifact 已存入 request snapshot，也立即返回空。`LiveArtifactFooter` 卸载，依赖同一实时来源的顶栏文件计数也为零。页面不会在每轮完成后自动重取历史，因此 `generatedFiles` 不能即时接管。

**促成条件**：验收先证明了后端落盘、SQLite 登记、单元测试与 Renderer 构建，没有在重启后的实际桌面窗口完整走一次“artifact → done → 可见卡片/文件入口”的路径。该窗口仍使用修复前的 bundle，因而使已知生命周期缺口暴露给用户。

## Fix

- `AgentEventBus` 记录每个本地线程的最后一轮快照；`done` 只结束运行态，不删除该快照的 artifacts 可读性。
- `AgentChatPage` 成功加载该会话历史后，按 `conversationId` 清除对应实时 artifacts，使持久化的 `generatedFiles` 成为唯一渲染来源，避免重复卡片。
- `TurnProgress` 仍只在 `working` 显示；保留终态 artifact 不会遗留“正在思考”。
- 已加入 renderer 回归：`artifact` 后 `done` 仍可按线程读取，历史接管清除后才消失。

## Insight

“文件存在、数据库有行、接口/单测成功”只证明生产链路的一部分；对用户而言，完成条件是同一新鲜运行时中的响应卡片和会话入口可见。任何由 SSE 驱动、又在终态切换持久化来源的 UI，都必须把事件顺序、终态保留和来源交接作为一个可复现的用户路径验证。

## Failure Class And Recurrence

- Failure class id: `IM-001` — 静态类型/API/局部状态成功被误当成 UI 运行时契约正确。
- Recurrence count: `2`。
- Prior cases in this class: [2026-11-07 历史消息转换运行时失败](2026-11-07-conversation-history-runtime.md)。
- Escalation required by count: 必须有可自动执行的回归断言；本案由 renderer 事件总线测试固定 `artifact → done → 历史接管` 的顺序和可见性来源。

## Guardrails

- Documentation update: [Artifact 会话产出文件](../current/domains/artifacts/index.md) 明确终态快照保留和历史接管顺序。
- Rule update: 对由实时事件与历史记录共同驱动的 UI，验收应以“新鲜运行时中用户可见控件存在”为完成条件，不以磁盘或 SQLite 证据替代。
- Test update: `apps/desktop/test/agent-stream.test.cjs` 断言 artifact 在 `done` 后仍可读，并在历史接管后消失。
- Script update: 无；现有 `npm run test:agent-stream --workspace @teachforge/desktop` 覆盖事件顺序，不替代 Electron 视觉验收。
- Manifest route update: 无；既有 `agent-runtime` 路由已覆盖 backend chat 与 desktop agent 生命周期。

## Not Generalized

这不意味着所有完成态 UI 都应永久缓存，也不意味着 `done` 不应清理活动请求。这里保留的是当前线程最后一轮的文件快照，直到该会话历史成功接管；其它实时状态仍应在请求结束后清理。

“立即停止”只是更容易暴露事件时序的操作，不是文件丢失或索引失败的根因。模型输出截断、thinking token 预算和文件展示生命周期属于相邻但独立的问题，不把它们混为同一故障类。
