---
status: draft
layer: change
domain: conversations
created_at: 2026-11-07
version: 2.0
updates_current:
  - docs/current/domains/conversations/index.md
  - docs/current/domains/conversations/backend-behavior.md
  - docs/current/domains/conversations/api-contract.md
  - docs/current/platform/agent-runtime.md
  - docs/current/platform/architecture-and-code-placement.md
---

# Agent Chat Layout and History Pagination Design

## Problem

Agent 对话页外面仍有品牌侧栏、页面标题和服务状态栏；用户在目标聊天区域之外看到重复壳层。页面高度由多层 min-height 和滚动容器共同决定，长消息可能带动整个页面滚动。会话历史 API 当前一次读取全部可见消息，长会话打开时响应和 renderer 消息数会持续增长。

## Goals

- 移除红框聊天工作区之外的应用壳层，只保留会话列表、备课助手标题/说明、消息区和输入区。
- 将应用视口锁定在窗口高度内；会话列表与消息视口是仅有的两个可滚动区域，输入区保持可见。
- 选择或恢复会话时默认读取最近 30 条可见消息，并提供“查看更早的消息”按需读取与前置加载。
- 保持对话消息的本地持久化、安全投影、会话选择与继续提问行为。

## Non-Goals

- 不改变 Agent 流式运行、取消、工具状态、存储格式或 Pi 上下文恢复。
- 不增加分页选项、搜索、列表分页、消息编辑或新的数据库列/索引。
- 不增加全局 query/cache 框架或通用虚拟列表。
- 不修改会话标题、空状态含义或输入快捷键。

## Must-Not-Break Existing Behavior

- 点击会话后，当前线程只显示该会话的 user/assistant 文本；工具参数、结果、pending 行和 Pi 原始块仍不显示。
- localStorage 中的活动会话仍可在启动后恢复，并可继续向原会话发送新问题。
- 会话不存在或历史读取失败时，不得将另一会话的消息显示为当前会话；保留现有刷新与重试语义。
- 运行中的 Agent 请求仍阻止切换会话或新建会话，流式消息与工具活动不受历史分页影响。
- Electron 本地 token、Origin 检查与 renderer 仅经 preload bridge 请求后端的边界保持不变。

## Current Behavior

- App 在 Agent 页面外渲染 TeachForge 品牌侧栏、Agent 对话标题、本地服务状态及带边框的内容卡片；AgentChatPage 再渲染自己的对话标题。
- AgentChatPage 的选中会话读取 GET /api/conversations/:conversationId/messages，后端将所有终态可见消息按 sequenceNo 升序加载并投影。
- ConversationSidebar 已有内部 overflow-y-auto；ThreadPrimitive.Viewport 也可滚动并将 composer 放在 sticky ViewportFooter 中，但应用根与多个 min-height 容器仍允许页面自身滚动。
- 会话历史响应是完整消息数组，当前接口没有 cursor 或页大小。

## Proposed Behavior

- App 只保留 AssistantRuntimeProvider 和一个占满 viewport 的 AgentChatPage 容器；移除外层品牌、标题和服务状态显示及仅供状态栏使用的健康查询。
- AgentChatPage 使用零 min-height 的全高两栏布局。桌面端左侧固定宽度，右侧占满余宽；窄屏将侧栏压到有界高度并让聊天区占据剩余高度。
- ConversationSidebar 的标题/操作固定，只有会话列表本体 overflow-y-auto。右侧标题、历史提示和 composer 不滚动；ThreadPrimitive.Viewport 独自滚动消息内容，composer 作为 ThreadPrimitive.Root 的固定兄弟区域，不进入消息滚动视口。
- 首次读取选中会话时，请求最近 30 条可见消息。响应包装为 messages 与 hasMore；消息仍按 sequenceNo 升序。
- 点击“查看更早的消息”时，以当前已加载最早消息的 id 作为 beforeMessageId。后端读取该消息之前最近 30 条可见消息，返回严格早于锚点的结果；Renderer 将旧消息前置并保持当前阅读位置。hasMore 为 false 时隐藏入口。
- 页大小是后端固定值 30，不接受客户端任意 limit。Cursor 必须指向同一 Conversation 的 Message；不匹配的 cursor 返回 400。会话不存在仍返回 404。
- 后端以 conversationId、role、终态 status、sequenceNo 限定 SQLite 查询，并以小批次从新到旧扫描候选行，直到获得 31 条可见文本或耗尽候选；31 条用于准确计算 hasMore，响应最多 30 条。返回的消息在内存中恢复为升序。
- 不增加 schema。现有 conversation/sequence 唯一索引继续支撑按对话和序号游标读取。

## Alternatives Considered

| 方案 | 结论 | 理由 | 是否升级为 ADR |
|---|---|---|---|
| 一次加载全部消息并在 UI 截断 | 否决 | 仍传输和解析完整历史；不能满足默认只查最近 30 条。 | n/a |
| 使用 offset 分页 | 否决 | 历史新增消息会移动偏移量；稳定消息 ID 锚点更适合会话内容。 | n/a |
| 每条消息增加 sequenceNo 字段作为 cursor | 否决 | 暴露内部序号没有必要；使用已返回消息 ID 可在后端解析同会话序号。 | n/a |
| 新建分页 Service 或通用 query 层 | 否决 | 当前只有一个调用方和一个读取接口；延用 ConversationsService 与 preload bridge 即可。 | n/a |
| 保留完整应用壳并只隐藏部分元素 | 否决 | 用户明确指出红框外层是冗余；满屏对话工作区更直接。 | n/a |

## Business Flow

1. Agent 页面启动后，读取侧栏摘要并恢复最近活动会话。
2. 服务端只返回最近 30 条可见消息；若还有更早内容，消息区顶部显示“查看更早的消息”。
3. 用户点击入口后加载上一页；旧消息追加到当前会话的前面，阅读位置保持稳定。
4. 用户继续提问时，活动 conversationId 不变；composer 始终可见，消息区独立滚动。

## End-to-End Data Interaction Flow

~~~mermaid
sequenceDiagram
    actor User as 教师
    participant UI as AgentChatPage
    participant Bridge as Electron preload/main bridge
    participant Controller as ConversationsController
    participant Service as ConversationsService
    participant DB as SQLite messages

    User->>UI: 选择或恢复 conversationId
    UI->>Bridge: GET /api/conversations/:id/messages
    Bridge->>Controller: 本地认证请求
    Controller->>Service: 查询首批可见消息
    Service->>DB: conversation 校验 + 最近 31 条可见候选
    DB-->>Service: 按 sequenceNo 倒序候选
    Service-->>Controller: 最近 30 条升序 + hasMore
    Controller-->>Bridge: 页面响应
    Bridge-->>UI: messages / hasMore
    UI->>UI: 替换当前 LocalRuntime 线程

    User->>UI: 点击“查看更早的消息”
    UI->>Bridge: GET messages?beforeMessageId=最早已加载消息ID
    Bridge->>Controller: 本地认证请求
    Controller->>Service: 以同会话消息 ID 定位序号
    Service->>DB: 查询锚点之前最近 31 条可见候选
    DB-->>Service: 倒序候选
    Service-->>Controller: 最多 30 条升序 + hasMore
    Controller-->>Bridge: 页面响应
    Bridge-->>UI: 更早 messages / hasMore
    UI->>UI: 前置旧消息并恢复可视锚点

    Note over UI: App 根高度锁定 viewport；会话列表与消息视口是两个滚动区；composer 保持可见
~~~

| 关键节点 | 输入 | 节点职责 | 输出 / 状态变化 | 关键边界 |
|---|---|---|---|---|
| App / AgentChatPage | 窗口尺寸、会话选择 | 提供全高对话布局，协调会话与 runtime 消息 | 两个内部滚动区；composer 固定可见 | 根容器禁止页面级 overflow |
| ConversationSidebar | 会话摘要、选择回调 | 展示列表、创建/刷新/选择动作 | 选中的 conversationId | 只有列表内容可滚动 |
| Electron bridge | method/path | 注入本地 token 并代理 JSON 请求 | 响应 status/data | Renderer 不获得 token |
| ConversationsController | path UUID、可选 beforeMessageId | 校验路由输入并调用查询 Service | 分页 DTO 或安全错误 | 保留 token/Origin 中间件；无隐式创建 |
| ConversationsService | conversationId、cursor ID | 校验会话与锚点，投影本地可见文本 | 最多 30 条升序消息与 hasMore | cursor 必须属于同一会话；只读 SQLite |
| SQLite MessageEntity | conversationId、sequenceNo、role、status | 保存有序消息事实 | 候选消息行 | 复用现有索引，不加 schema |

## Data And API Impact

- 将既有历史响应从数组改为对象：messages 为消息数组，hasMore 为布尔值。
- 在历史 GET 查询中增加可选 beforeMessageId UUIDv4；无 cursor 时读取最新页，有 cursor 时读取其之前一页。
- 请求页固定最多 30 条。消息字段、可见角色/终态、顺序和 404 行为保持现有语义；错误 cursor 返回 400。
- 只读 SQLite；不改实体、迁移、SSE、Electron bridge 的权限或本地认证。

## Frontend Fetching Logic

- App/AgentChatPage 仍通过 window.teachforge.request 读取摘要和消息，不直接访问 HTTP 或 SQLite。
- 首次选中及 localStorage 恢复请求不带 cursor；页面校验成功状态和响应结构后，以 messages 替换 runtime 线程并记下 hasMore。
- 更早页以最早已加载消息 ID 为 cursor。请求期间按钮禁用；成功时将 response.messages 放到已有消息之前，更新 hasMore，并调整消息视口 scrollTop 以保持原先首个可见内容的位置。
- 切换会话、新建会话或运行 Agent 时，取消/忽略旧页响应；失败时保留当前内容并在加载按钮位置提示重试。
- 非 200、格式错误及 404 沿用当前诊断和列表刷新语义，不记录消息正文。

## Frontend Behavior

- 视口高度不随消息增多而扩张；会话列表和消息视口各自滚动。
- 消息加载更多入口位于消息列表顶部，hasMore 为 false 时不存在；加载状态和失败重试均不创建第三个滚动区。
- 桌面端采用固定侧栏与弹性消息区。窄屏为侧栏和消息区分配有界高度；窗口本身不出现滚动条。
- Composer 固定在 ThreadPrimitive.Root 底部的独立兄弟区域，消息 viewport 仅包含历史入口和消息本体。Root 以 overflow-hidden 限制消息内容，viewport 不保留底部 padding，避免长消息滚动到输入框后方或从其下缘露出。

## Backend Fetching Logic

- ConversationEntity 用于确认 conversationId 存在；不存在时维持 404。
- MessageEntity 为唯一历史数据源。候选字段为 conversationId、role=user/assistant、终态 status、sequenceNo；内部 payload 仍经 extractVisibleMessageText 投影。
- ConversationsService 负责历史读取和分页，不新增 Repository、缓存或事务。读取先校验 beforeMessageId 属于同一 conversation，再按 sequenceNo 倒序分批取候选，过滤空文本，最多累积 31 条可见消息。
- 31 条可见消息时返回最近 30 条并标 hasMore=true；耗尽候选且不足 31 条时返回全部结果并标 false。返回之前按 sequenceNo 升序排列。
- 查询是单个请求内的只读快照，不开写事务、不缓存；并发新消息可能使后续首屏更新，但已加载 cursor 始终锚定现存 Message ID，不导致 offset 漂移。
- 分批扫描只在大量不可显示候选时继续查询；若一批不足批大小即可判断数据库候选耗尽。后端异常按现有安全错误/结构化日志路径上抛，Renderer 保留已加载历史。

## Backend Behavior

- ConversationsController 继续拥有 GET /api/conversations/:conversationId/messages，并通过现有 ParseUUIDPipe 校验 conversationId；新增 query DTO 负责可选 UUID cursor。
- ConversationsService.getConversationMessages 扩展为分页读取；ConversationMessageDto 保持字段不变，新增分页响应 DTO。
- 使用现有 MessageEntity conversationId/sequenceNo 唯一索引；不改持久化模型或模型运行时完整历史读取逻辑。Pi 下一轮请求仍从 SQLite 加载完整持久化历史，与 UI 首屏分页相互独立。

## Error Handling

- 非 UUIDv4 conversationId 维持 400，Conversation 不存在维持 404，本地认证失败维持 401，带 Origin 的请求维持 403。
- beforeMessageId 格式错误或不属于目标 conversation 时返回 400，不创建 conversation、不返回其他会话数据。
- 页面请求失败保留当前消息；历史首屏沿用现有错误呈现。更早页失败时在顶部入口附近显示错误与重试动作。
- Renderer 以安全字段记录操作、HTTP 状态及错误类型，不记录消息正文或 token。

## Risks

- 历史 API 响应外层从数组改为对象，所有调用方必须在同一变更中更新；代码搜索表明现有消费者只有 AgentChatPage。
- 加载更多时重置 LocalRuntime 当前线程可能引发滚动跳动；实现需以 DOM 高度差补偿 scrollTop，并检查实际 assistant-ui viewport。
- 31 条可见消息扫描需要解析候选 contentJson；无可见文本的历史行较多时可能增加读取次数，但不会返回或一次载入完整 payload。
- 小屏分栏受最小应用高度限制；窄高窗口仍需保持 root overflow-hidden，并让侧栏/消息区保有 min-h-0。

## Verification

- Desktop renderer 与 backend 均可通过 TypeScript/build 检查。
- 代码走查确认查询用 conversationId + sequenceNo cursor、有序、最多 30 条，并未改变 Pi 恢复的完整历史读取。
- 浏览器/桌面人工验收：检查 1440、768、390 宽度与不同窗口高度；确认只有会话列表和消息视口可滚动，composer 保持可见。
- 人工验收长对话：初次只请求最近 30 条；点击“查看更早的消息”按页前置，重复读取无跳过/重复，位置保持；末页隐藏入口。
- 本任务不新增或运行自动化测试。

## Design Deviations

| 偏差 | 发现于 | 与设计不符之处 | 处理（改设计 / 改现状文档 / 接受） |
|---|---|---|---|
| Composer 不再使用 sticky ViewportFooter | 交付后用户反馈 | v1.0 将输入区放在可滚动 Viewport 内，底部 padding 留出透明区域，滚动中的消息可从输入区下方露出 | v2.0 调整布局：composer 移到 ThreadPrimitive.Root 内但位于消息 viewport 外；消息视口去除底部 padding，固定区与滚动区的边界不再重叠 |

## Version History

| 版本 | 触发 | 变更与影响 | 状态 |
|---|---|---|---|
| 1.0 | 初始实现 | 全屏双栏布局、两个滚动区和 30 条游标分页；composer 最初设计为 sticky ViewportFooter | 已交付 |
| 2.0 | 用户反馈输入框底部露出消息 | 依据浏览器复现结果，调整 composer 与消息 viewport 的布局边界；不改分页、API 或数据模型 | 已实现并完成 renderer 构建与浏览器复测 |

## Current Doc Updates

- [x] docs/current/domains/conversations/index.md
- [x] docs/current/domains/conversations/api-contract.md
- [x] docs/current/domains/conversations/backend-behavior.md
- [x] docs/manifest.yaml
- [x] docs/current/platform/agent-runtime.md
- [x] docs/current/platform/architecture-and-code-placement.md

