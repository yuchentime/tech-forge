---
status: current
layer: change
domain: conversations
canonical_for:
  - conversation-history-load-failure-handoff
related:
  - docs/changes/2026-11-07-conversation-history-sidebar/design.md
  - docs/changes/2026-11-07-conversation-history-sidebar/verification.md
  - docs/current/domains/conversations/api-contract.md
  - docs/current/platform/agent-runtime.md
last_verified: 2026-11-07
---

# Conversation 历史加载失败交接

## 接手状态

原交接时用户反馈：验收仍失败，希望由其他模型继续处理。以下原始观察保留用于追溯；2026-11-07 L003 已在独立 SQLite 数据目录的真实 Electron 中复现并修复历史加载失败，结论见下一节。

目标行为是选中一个已有会话后显示其历史消息。验收环境必须先确认：普通浏览器打开 Vite 地址和 Electron 桌面窗口不是同一个运行环境。

## L003 修复结论（2026-11-07）

- 实际复现：两个含 user/assistant 文本的会话；点选后 UI 显示“历史消息加载失败”，bridge 返回 HTTP 200 和正确 DTO。
- Debugger 捕获 `status is only supported for assistant messages`，调用栈为 `fromThreadMessageLike → ExportedMessageRepository.fromArray → LocalThreadRuntimeCore.reset → AgentChatPage`。
- 根因：原 `toThreadMessage()` 给 user 和 assistant 都附加 `status`。API 的存储状态与 assistant-ui 的角色专属状态契约不同；静态类型允许该组合，但运行时拒绝。
- 修复：提取 `conversation-history.ts`，仅 assistant 附加完成/失败/取消状态；user 不附加状态。HTTP、数据库和认证契约不变。
- `npm run test:conversation-history --workspace @teachforge/desktop`：修复前 2/4 失败，修复后 4/4 通过；现有 desktop Agent stream 9/9 通过，renderer 构建通过。
- 真实 Electron：历史读取、A/B 切换、进程重启恢复、新建清空、failed/cancelled 部分文本、404 刷新且保留旧线程、过期活动 ID 清理全部通过。独立测试数据库，无模型调用，无用户数据变更。
- 原文的“用户数据库为空”“旧摘要来源”仅属当时观察，未证明与本次缺陷有关；本轮没有恢复或迁移旧会话数据。
- 详细验收见 [verification.md](verification.md)，复盘见 [运行时契约复盘](../../postmortems/2026-11-07-conversation-history-runtime.md)。

## 原交接已确认事实（保留历史）

| 观察 | 证据 | 含义 |
|---|---|---|
| 普通 Chrome 打开 `http://127.0.0.1:5173/` 时没有 `window.teachforge`。 | 在该页面执行 `typeof window.teachforge` 得到 `undefined`。 | Electron preload bridge 未加载。 |
| 普通 Chrome 页面没有会话 API 请求。 | DevTools Network 的 Fetch/XHR 列表为空；只有 Vite 静态资源请求。 | 后端没有收到请求，因此不会产生对应 backend HTTP 日志。 |
| 之前的前端 catch 没有输出 Renderer 错误。 | `ConversationStore.refresh()` 将异常转成通用 UI 状态，没有 console 记录。 | “没有错误日志”与失败发生在 Renderer bridge 调用处相符。 |
| 普通 Chrome 页面现在显示桌面端提示，并记录安全错误分类。 | 热更新和页面重载后观察到“请通过 TeachForge 桌面应用打开”，Console 有 `desktop_bridge_unavailable`。 | 浏览器模式失败原因现在可见；这没有让普通浏览器获得会话能力。 |
| 之前观察到的 Electron 窗口显示本地服务已连接，但仍有历史加载错误。 | Electron 窗口 UI 状态。 | 不能用普通 Chrome 的 bridge 缺失解释该 Electron 错误。 |
| 当前 Electron userData 数据库没有会话或消息行。 | 对 `%APPDATA%\@teachforge\desktop\teachforge.db` 做只读 SQLite 查询，`conversations` 和 `messages` 均为 0。 | 当前数据库无法提供历史消息。 |

### 原交接未确认事项

- Electron 中历史接口的实际 HTTP 状态和响应体尚未捕获。先前关于 404/过期列表的判断只是根据空数据库和服务代码作出的推断，不是已观察到的网络结果。
- Electron 的旧会话摘要为何仍出现在界面中尚未查明，可能与 HMR 保留的 Renderer 状态或数据目录变化有关。
- 用户的验收是否要求普通 Chrome 直接运行该功能尚未明确。当前设计将 renderer 的本地访问限定在 Electron preload/Main bridge。
- 当前数据库没有可恢复的会话数据。除非找到含该会话的数据库备份，否则不能通过前端改动恢复消息正文。

## 本工作区改动

### 本轮诊断与恢复处理

- `apps/desktop/src/types/desktop-bridge.ts` 增加 `hasDesktopBridge()` 运行环境检查。
- `apps/desktop/src/App.tsx`、`apps/desktop/src/features/agent/conversation-store.ts`、`AgentChatPage.tsx` 对缺少 preload bridge 显示明确提示，并输出不含正文或凭据的 Renderer console 错误分类。
- `AgentChatPage.tsx` 收到历史接口 404 时刷新摘要列表；若会话已不存在，清除过期活动 ID。其他状态显示 HTTP 状态码。
- 当前事实同步到了 `docs/current/platform/agent-runtime.md`、`architecture-and-code-placement.md` 和 `docs/current/domains/conversations/api-contract.md`。

### 此前已存在的未提交工作

开始修复前，工作区已经有 Agent Flow Structured Logging 的未提交改动，包括 backend Agent/Conversation/LLM 文件、`apps/backend/src/logging/` 和 `docs/changes/2026-11-07-agent-flow-logging/`。接手时不要重置或覆盖这些改动。

## 原交接已执行的核验

- `npm run build:renderer --workspace @teachforge/desktop`：通过。Vite 报告 bundle 超过 500 kB 的警告，与本问题无关。
- 普通 Chrome 重载后：页面显示桌面端提示；Console 记录 `desktop_bridge_unavailable`；Fetch/XHR 列表为空。
- 未运行测试套件。未在 Electron 中重新捕获历史请求的实际 HTTP 状态。

## 原交接建议下一步（保留历史）

1. 先确认验收目标。若目标是当前桌面产品，应运行 `npm run dev` 后在启动的 TeachForge Electron 窗口验收，而不是普通 Chrome 的 Vite 地址。
2. 原建议是在 Electron DevTools Network 中查看历史请求。复盘纠正：该 HTTP fetch 在 Main 进程执行，Renderer Network 不足以覆盖它；应获取 `window.teachforge.request()` 返回的状态、响应结构和 `conversationId`，再关联 Main/backend 日志及 Renderer 消费阶段异常。
3. 在同一 Electron 进程确认 `TEACHFORGE_DATA_DIR` 和数据库路径，再检查会话实体及消息行是否存在。当前 userData 数据库为空，不能以旧 UI 摘要当作数据库记录。
4. 若状态为 404，先核实所选 ID 是否存在于该进程实际连接的数据库；若为 500，再依据 backend 安全日志定位解析或查询阶段。不要在未拿到状态码前假定根因为 404 或 JSON 损坏。
5. 若产品验收确实要求普通浏览器运行，需要单独设计开发态请求代理和来源校验；不要把 backend token 暴露给 Renderer，也不要移除 backend 的 token/Origin 检查来让验收通过。
