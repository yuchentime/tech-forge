---
status: current
layer: domain
domain: conversations
canonical_for:
  - conversation-query-api-contract
related:
  - docs/current/domains/conversations/index.md
  - docs/current/domains/conversations/backend-behavior.md
  - docs/current/platform/architecture-and-code-placement.md
last_verified: 2026-11-13
---

# Conversation 查询接口契约

## Scope

- 覆盖本地个人工作台中 Agent 会话摘要列表、选中会话历史读取、会话重命名与删除，以及“学习笔记”摘录的保存、列表和删除。
- 不包含摘要列表分页、工具活动或 Pi 原始消息格式；可见消息历史一次完整读取。
- 所有端点通过现有 Electron JSON bridge 调用，并受本地随机 token 和 loopback origin 检查保护；当前产品为单人 Personal Agent，没有用户或租户参数。
- 当前没有单独的跨领域 API conventions 页面；响应遵循本项目现有 JSON bridge 的 `{ status, data }` 包装。

## Conventions

- JSON 字段使用 camelCase。
- 时间以 ISO 8601 字符串返回。
- Conversation 与 Message ID 使用 UUIDv4。
- 接口读写 SQLite；摘要列表与消息历史都完整返回，不再分页。消息历史完整加载是为了让“学习笔记”能定位到较早的消息。

## Conversation Query API

### Create an empty conversation

- **方法**：`POST`
- **路径**：`/api/conversations`
- **功能职责**：为桌面端草稿线程首次发送前创建一个空 Conversation，使后续 stream 始终携带已确认的 UUIDv4。
- **请求体**：无。
- **响应**：HTTP 201，`{ "conversationId": "<uuid-v4>" }`。创建成功不表示已有消息行；标题在首条用户消息前仍为“新对话”。
- **错误**：本地认证失败为 401，内部持久化失败为 500。

### List conversation summaries

- **方法**：`GET`
- **路径**：`/api/conversations`
- **功能职责**：为桌面 Agent 左侧栏返回本地 Conversation 摘要，避免启动时读取所有消息正文。
- **鉴权/归属**：经 Electron 本地认证桥接调用；不接受账号、身份或租户参数，读取当前本机全部会话。

#### Request Summary

| 位置 | 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| Header | `x-teachforge-token` | `String` | 是 | Electron Main 注入的本地随机 token；Renderer 不直接接触 token。 |

#### Request Schema

##### Query Params

无。

##### Request Body

无。

#### Response Schema

HTTP 200 的响应体为 Conversation 摘要数组；无记录时为空数组。Electron JSON bridge 会将 HTTP 状态和响应体包装为 `{ "status": 200, "data": [...] }`。

```json
[
  {
    "id": "a6ef77cc-2431-4f97-98ee-f12b2bc81c78",
    "title": "帮我设计一节关于缓存的课",
    "createdAt": "2026-11-07T02:30:00.000Z",
    "updatedAt": "2026-11-07T02:35:12.000Z"
  }
]
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `[]` | `ConversationSummary[]` | 是 | ConversationsService 查询结果 | 按 `updatedAt DESC`、再按 `createdAt DESC` 排序的摘要列表 | JSON 数组 | 无会话时为 `[]` |

#### Nested Objects

##### `[]` (`ConversationSummary`)

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `id` | `String` | 是 | `ConversationEntity.id` | 会话稳定 ID | UUIDv4 | 不为空 |
| `title` | `String` | 是 | entity 标题或首条 user 消息文本投影 | 侧栏显示名称 | 非空文本，最多 80 个 Unicode 字符；空白折叠 | entity 和用户文本均为空时为 `新对话` |
| `createdAt` | `String` | 是 | `ConversationEntity.createdAt` | 创建时间 | ISO 8601 | 不为空 |
| `updatedAt` | `String` | 是 | `ConversationEntity.updatedAt` | 最近更新时间和列表排序字段 | ISO 8601 | 不为空 |

#### Error Cases

| 场景 | code | 说明 |
|---|---|---|
| 本地 token 缺失或错误 | `401` | 后端拒绝未认证的本地请求。 |
| 请求带有 Origin header | `403` | 后端拒绝来自浏览器跨域路径的请求。 |

#### Notes

- 非空 `ConversationEntity.title` 优先；否则读取最早 `sequenceNo` 的 user 消息文本，折叠空白并限制显示长度。读取不会写回 title。
- 列表不返回 Message 内容、工具参数、工具结果、Pi payload 或消息计数。
- 若单会话历史增长到需要虚拟列表或分页，再单独评估按 `messageId` 定位的锚点读取方式。

### Get visible messages for one conversation

- **方法**：`GET`
- **路径**：`/api/conversations/:conversationId/messages`
- **功能职责**：用户选中侧栏会话时，一次加载该会话的全部可见文本，供阅读和“学习笔记”定位旧消息。
- **鉴权/归属**：经 Electron 本地认证桥接调用；只读取给定 ID 的本地 Conversation。

#### Request Summary

| 位置 | 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| Path | `conversationId` | `String` | 是 | 要读取的 Conversation UUIDv4。 |
| Header | `x-teachforge-token` | `String` | 是 | Electron Main 注入的本地随机 token；Renderer 不直接接触 token。 |

#### Request Schema

##### Path Params

```json
{
  "conversationId": "a6ef77cc-2431-4f97-98ee-f12b2bc81c78"
}
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `conversationId` | `String` | 是 | URL path | 要读取的 Conversation ID | UUIDv4 | 缺失或格式错误返回 400 |

##### Request Body

无。

#### Response Schema

HTTP 200 的响应体为完整历史对象。`messages` 按 `sequenceNo ASC` 排列，包含全部可见文本消息。Electron JSON bridge 会将 HTTP 状态和响应体包装为 `{ "status": 200, "data": { "messages": [...] } }`。

```json
{
  "messages": [
    {
      "id": "4b4f9b9b-1789-45c6-9afd-54f4ca881cf5",
      "role": "user",
      "content": "帮我设计一节关于缓存的课",
      "status": "completed",
      "createdAt": "2026-11-07T02:30:00.000Z"
    },
    {
      "id": "a9efeaeb-8bfd-43dc-a311-461f18f9dadb",
      "role": "assistant",
      "content": "可以从缓存击穿、雪崩和穿透三个概念展开。",
      "status": "completed",
      "createdAt": "2026-11-07T02:30:05.000Z"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `messages` | `ConversationMessage[]` | 是 | ConversationsService 消息投影 | 全部可见消息 | 按消息序号升序 | 无可见文本消息时为 `[]` |

#### Nested Objects

##### `messages[]` (`ConversationMessage`)

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `id` | `String` | 是 | `MessageEntity.id` | 消息稳定 ID | UUIDv4 | 不为空 |
| `role` | `String` | 是 | `MessageEntity.role` | 用户或助手消息 | `user`、`assistant` | 不为空 |
| `content` | `String` | 是 | `contentJson` 中的 text block 投影 | Renderer 展示的纯文本内容 | UTF-8 文本 | 空文本消息不返回 |
| `status` | `String` | 是 | `MessageEntity.status` | 本条消息的完成状态 | `completed`、`failed`、`cancelled` | 不为空；pending 行不返回 |
| `createdAt` | `String` | 是 | `MessageEntity.createdAt` | 消息创建时间 | ISO 8601 | 不为空 |
| `toolActivities` | `ConversationToolActivity[]` | user 行是；assistant 行否 | user turn 中的 `toolExecution` 行 | 安全工具执行摘要 | 字段见下表 | 没有工具时 user 行返回 `[]` |
| `attachments` | `ConversationAttachment[]` | user 行是；assistant 行否 | user 行 `contextRefsJson.attachments` | 该消息附加的文件引用 | 字段见下表 | 没有附件时 user 行返回 `[]` |
| `commands` | `String[]` | 仅当 user 行有命令时 | user 行 `contextRefsJson.commands` | 该消息携带的斜杠指令，供气泡标签还原 | `knowledge`、`research`，按 knowledge → research 顺序、去重 | 没有命令时省略该字段 |
| `generatedFiles` | `ConversationGeneratedFile[]` | assistant 行是；user 行否 | `artifacts` 行（按该轮 `userMessageId`） | 本轮产出文件，用于响应底部文件列表 | `{id, fileName, contentFormat, missing, external}` | 没有产出时返回 `[]`；见 [Artifact 会话产出文件](../artifacts/index.md) |

##### `attachments[]` (`ConversationAttachment`)

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `attachmentId` | `String` | 是 | `~/.tech-forge/sessions/<conversationId>/attachments/<attachmentId>/` 的目录名 |
| `name` | `String` | 是 | 原文件名，用于气泡标签 |

##### `toolActivities[]` (`ConversationToolActivity`)

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `toolCallId` | `String` | 是 | 对应 Pi 工具调用 ID |
| `toolName` | `String` | 是 | 工具名 |
| `path` | `String` | 否 | 仅当新持久记录含字符串 `args.path` 时返回 |
| `pattern` | `String` | 否 | 仅当工具为 `grep` 且新持久记录含字符串 `args.pattern` 时返回；供历史行显示搜索词 |
| `offset` | `Number` | 否 | 仅当工具为 `read` 且调用给了合法 `args.offset` 时返回；1-based 起始行，供历史行区分分段读取 |
| `limit` | `Number` | 否 | 仅当工具为 `read` 且调用给了合法 `args.limit` 时返回；请求行数 |
| `status` | `String` | 是 | `completed` 或 `failed`；中断执行按失败展示 |
| `durationMs` | `Number` | 否 | 工具自身耗时（毫秒） |

#### Error Cases

| 场景 | code | 说明 |
|---|---|---|
| `conversationId` 不是 UUIDv4 | `400` | `ParseUUIDPipe` 在 Service 查询前拒绝该路径参数。 |
| ID 格式正确但 Conversation 不存在 | `404` | 返回 not found；不会创建 Conversation 或消息。 |
| 本地 token 缺失或错误 | `401` | 后端拒绝未认证的本地请求。 |
| 请求带有 Origin header | `403` | 后端拒绝来自浏览器跨域路径的请求。 |

#### Notes

- 返回 `user` 与 `assistant` 的 `completed`、`failed`、`cancelled` 终态文本，按 `sequenceNo ASC` 排列。
- `toolExecution` 不作为顶层消息返回；仅在 user 行下投影 `toolActivities`。不返回原始工具参数、partial/final result、`toolResult`、`assistantTurn`、pending 行、thinking、原始 `contentJson` 或非文本 Pi blocks。
- `attachments` 只投影 `{attachmentId, name}`。附件内容保存在 `~/.tech-forge/sessions/<conversationId>/attachments/<attachmentId>/`：PDF/DOCX 为同名 `.md` 解析结果，Markdown/TXT 与图片为原文件；图片只作为本轮视觉输入发送，正文与字节从不写入消息行，因此不出现在历史接口；`characters` / `injectedCharacters` 只供服务端 prompt 使用。
- 一次返回全部可见消息；Renderer 打开会话后不再显示“查看更早的消息”。加载时按持久 user message ID 恢复活动摘要；整轮耗时未持久化，历史 UI 不显示该计时。
- “学习笔记”进入会话时，Renderer 按保存的 `messageId` 在已加载消息中查找目标并滚动到视口中央，短暂闪烁后恢复；目标不存在时提示消息可能已删除。
- 若 Renderer 读取历史时收到 `404`，会刷新摘要列表；若该 ID 已不在列表中，则清除过期活动 ID并显示会话已不存在。其他失败保留当前线程并提供重试。

### Rename one conversation

- **方法**：`PATCH`
- **路径**：`/api/conversations/:conversationId`
- **功能职责**：把用户输入的会话名称写入 `conversations.title`，使侧栏与页头使用该名称而不是首条用户消息的投影。
- **鉴权/归属**：经 Electron 本地认证桥接调用；只改名给定 ID 的本地 Conversation。

#### Request Summary

| 位置 | 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| Path | `conversationId` | `String` | 是 | 要重命名的 Conversation UUIDv4。 |
| Header | `x-teachforge-token` | `String` | 是 | Electron Main 注入的本地随机 token；Renderer 不直接接触 token。 |

#### Request Schema

##### Path Params

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `conversationId` | `String` | 是 | URL path | 要重命名的 Conversation ID | UUIDv4 | 缺失或格式错误返回 400 |

##### Request Body

```json
{ "title": "期末复习：缓存三件套" }
```

| 字段 | 类型 | 必填 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|
| `title` | `String` | 是 | 新会话名称 | 折叠空白后 1–20 个 Unicode 码点；非字符串返回 400 | 空或纯空白返回 400；不截断 |

#### Response Schema

HTTP 200 返回持久化后的名称。

```json
{ "id": "a6ef77cc-2431-4f97-98ee-f12b2bc81c78", "title": "期末复习：缓存三件套" }
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `id` | `String` | 是 | 请求路径 | 被重命名的会话 ID | UUIDv4 | 不为空 |
| `title` | `String` | 是 | 写入后的 `ConversationEntity.title` | 折叠空白后的名称 | 1–20 个 Unicode 码点 | 不为空 |

#### Error Cases

| 场景 | code | 说明 |
|---|---|---|
| `conversationId` 不是 UUIDv4 | `400` | `ParseUUIDPipe` 在 Service 操作前拒绝该路径参数。 |
| `title` 不是字符串 | `400` | Body DTO 校验失败，不写库。 |
| `title` 折叠空白后为空或超过 20 个码点 | `400` | 不写库，也不截断为合法长度。 |
| ID 格式正确但 Conversation 不存在 | `404` | 不创建会话。 |
| 本地 token 缺失或错误 | `401` | 后端拒绝未认证的本地请求。 |
| 请求带有 Origin header | `403` | 后端拒绝来自浏览器跨域路径的请求。 |

#### Notes

- 长度按 Unicode 码点计数，一个 emoji 计 1 个；与 Renderer 输入框上限一致。
- 写入后 `listConversations()` 优先使用该标题，首条用户消息不再参与显示，后续轮次不会覆盖。
- 重命名会更新 `updatedAt`，因此该会话移动到侧栏顶部。
- 生成中的会话允许重命名：改名只写 `conversations.title`，不影响运行中的流。

### Delete one conversation

- **方法**：`DELETE`
- **路径**：`/api/conversations/:conversationId`
- **功能职责**：物理删除一个会话及其全部派生数据（消息、Pi 快照、演练/物料/资料关联），并同步删除该会话的本地 session 目录。
- **鉴权/归属**：经 Electron 本地认证桥接调用；只删除给定 ID 的本地 Conversation。没有回收站，不可恢复。

#### Request Summary

| 位置 | 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| Path | `conversationId` | `String` | 是 | 要删除的 Conversation UUIDv4。 |
| Header | `x-teachforge-token` | `String` | 是 | Electron Main 注入的本地随机 token；Renderer 不直接接触 token。 |

#### Request Schema

##### Path Params

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `conversationId` | `String` | 是 | URL path | 要删除的 Conversation ID | UUIDv4 | 缺失或格式错误返回 400 |

##### Request Body

无。

#### Response Schema

HTTP 200 返回被删除的会话 ID 与本地文件清理结果。

```json
{ "conversationId": "a6ef77cc-2431-4f97-98ee-f12b2bc81c78", "sessionCleanup": "complete" }
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `conversationId` | `String` | 是 | 请求路径 | 已删除的会话 ID | UUIDv4 | 不为空 |
| `sessionCleanup` | `String` | 是 | 文件清理结果 | `~/.tech-forge/sessions/<conversationId>/` 是否已删除 | `complete` / `partial` | 不为空；`partial` 表示行已删除但目录未能移除 |

#### Error Cases

| 场景 | code | 说明 |
|---|---|---|
| `conversationId` 不是 UUIDv4 | `400` | `ParseUUIDPipe` 在 Service 操作前拒绝该路径参数。 |
| ID 格式正确但 Conversation 不存在 | `404` | 不会创建会话，也不触碰文件系统。 |
| 会话正在运行、排队或已被另一删除请求占位 | `409` | 保留所有行、缓存和本地目录；停止或完成后可重试删除。 |
| 数据库删除失败 | `500` | 事务回滚，会话与行保持原样。 |
| 本地 token 缺失或错误 | `401` | 后端拒绝未认证的本地请求。 |
| 请求带有 Origin header | `403` | 后端拒绝来自浏览器跨域路径的请求。 |

#### Notes

- 删除在一个事务内完成，子表优先：`rehearsal_turns` → `rehearsals` → `artifacts` → `conversation_documents` → `focus_items` → `messages` → `pi_session_snapshots` → `conversations`（全部外键为 `NO ACTION`，顺序不可调换）。
- `study_notes` 不随会话删除：同事务把其 `conversationId` 置为 `NULL`，笔记正文保留，只是失去「进入会话」入口。
- 本地 session 目录在事务提交后删除：文件清理失败不会回滚数据库结论，只返回 `sessionCleanup: "partial"` 并记录结构化日志。
- 桌面端在会话行悬停时显示「…」，菜单包含「重命名」和「删除会话」；重命名打开输入弹窗（下方为「取消」「保存」），删除点击即执行，没有二次确认；被删除的正是当前会话时，Renderer 同时清空线程与输入区状态。

## Focus Item API

“学习笔记”保存用户在**助手回复**中选中的一段文本。`messageId` 是进入会话时的定位锚点；`messageIndex` 是该消息在可见消息中的 1-based 序号，仅用于列表展示。

### List focus items

- **方法**：`GET`
- **路径**：`/api/focus-items`
- **功能职责**：按添加时间倒序返回全部摘录，并带上当前会话标题。
- **鉴权/归属**：经 Electron 本地认证桥接调用；读取当前本机全部摘录。

#### Response Schema

HTTP 200 返回 `{ "items": FocusItem[] }`。

```json
{
  "items": [
    {
      "id": "5f0f8d38-3c22-4f2c-9f44-6f3a1c7d15aa",
      "conversationId": "a6ef77cc-2431-4f97-98ee-f12b2bc81c78",
      "conversationTitle": "RabbitMQ",
      "messageId": "a9efeaeb-8bfd-43dc-a311-461f18f9dadb",
      "messageIndex": 12,
      "quote": "CAS + 唯一键",
      "note": "幂等键要覆盖重试与重复投递",
      "createdAt": "2026-11-13T10:30:00.000Z"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 |
|---|---|---|---|---|---|
| `id` | `String` | 是 | `FocusItemEntity.id` | 摘录 ID | UUIDv4 |
| `conversationId` | `String` | 是 | `FocusItemEntity.conversationId` | 所属会话 | UUIDv4 |
| `conversationTitle` | `String` | 是 | 会话标题或首条 user 消息投影 | 列表显示的会话名 | 非空文本 |
| `messageId` | `String` | 是 | `FocusItemEntity.messageId` | 定位锚点 | UUIDv4 |
| `messageIndex` | `Number` | 是 | 创建时客户端传入的可见消息序号 | “第 N 条” | ≥ 1 的整数 |
| `quote` | `String` | 是 | 用户选中的纯文本 | 高亮文本 | 1–1000 个 Unicode 码点 |
| `note` | `String \| null` | 是 | `FocusItemEntity.note` | 用户为该摘录单独写的课堂笔记 | 1–2000 个码点；未写时为 `null` |
| `createdAt` | `String` | 是 | `FocusItemEntity.createdAt` | 添加时间 | ISO 8601 |

### Create a focus item

- **方法**：`POST`
- **路径**：`/api/focus-items`
- **功能职责**：保存一段选中的助手回复文本；同一消息的同一段文本只保存一条。
- **请求体**：`{ conversationId, messageId, quote, messageIndex, note? }`。`messageId` 必须属于 `conversationId` 且 `role = assistant`；`quote` 会统一换行并 trim 外侧，最多 1000 个码点；`note` 可选，同样统一换行并 trim 外侧，空字符串等同于不传并保存为 `null`，最多 2000 个 Unicode 码点。
- **响应**：HTTP 201，`FocusItem`。重复提交返回已有行，仍为 201；若这次带了非空 `note` 且与已有值不同，先更新该行的备注再返回。空 `note` 永远不会清除已有备注。
- **错误**：消息不存在或不属于该会话为 404；目标不是助手回复、`quote` 为空或过长、`messageIndex` 非法、`note` 不是字符串或超过 2000 个码点为 400。

### Update a focus item's note

- **方法**：`PATCH`
- **路径**：`/api/focus-items/:id`
- **功能职责**：为一条已保存的摘录写或修改课堂笔记；备注和摘录分开保存，清空备注不会删除摘录。
- **请求体**：`{ "note": "..." }`。服务端统一换行并 trim 外侧；空字符串保存为 `null`；最多 2000 个 Unicode 码点。
- **响应**：HTTP 200，更新后的 `FocusItem`（带当前会话标题）。
- **错误**：摘录不存在为 404；`note` 不是字符串或超过 2000 个码点为 400。

#### Notes

- `messageSequenceNo` 由服务端从 `messages` 读取，不接受客户端传入。
- 定位锚点必须是持久化的 assistant 行 ID：历史消息的 DOM 锚点本身就是该 ID；流式回复的 DOM 锚点由 assistant-ui 生成，不能直接入库。因此每轮结束时后端在 SSE 流中广播 `assistant_messages`（`{ messageIds }`，本轮写入的 assistant 行按顺序排列，不含 `toolResult`），Renderer 记录“气泡 ID → 行列表”，保存时取最后一行（该轮最终回答）作为 `messageId`。
- 客户端断开（用户取消或退出）的轮次收不到 `assistant_messages`；此时选区不显示浮动按钮，并提示该回复尚未保存完成。
- 会话标题在读取时派生，不存快照；重命名后列表立即显示新名称。
- `note` 属于摘录自身，不写回原消息；一条摘录可以有多行备注。清空备注只把 `note` 置为 `null`，摘录仍保留在列表中。
- 删除会话时在同一事务内删除其 `focus_items`；摘录没有独立于会话的回收站。
- 桌面端只在单条助手消息内显示“添加到学习笔记”浮动按钮；跨消息选区、流式生成中的选区、超过 1000 码点的选区不触发保存。点击浮动按钮不会立即写库，而是先打开备注弹窗：备注可选，输入框初始单行、按 Enter 换行并随内容增高到上限后内部滚动；点「保存备注」或按 Ctrl/⌘+Enter 才提交（空备注也提交，保存为无备注），「取消」、Esc 或点击遮罩放弃且不写库。保存失败时弹窗保持打开、就地显示错误并保留已输入的备注；成功后提示「已添加到学习笔记」。

## Study Note API

“学习笔记”页同时接受用户自己写的笔记（`study_notes` 表）。与摘录不同，笔记没有引用文本、没有 `messageId`/`messageIndex`；会话只是可选上下文：关联了会话时列表显示会话名与「进入会话」，否则只显示正文和添加时间。

### List study notes

- **方法**：`GET`
- **路径**：`/api/study-notes`
- **功能职责**：按添加时间倒序返回全部自写笔记，关联会话的笔记带上当前会话标题。
- **鉴权/归属**：经 Electron 本地认证桥接调用；读取当前本机全部笔记。

#### Response Schema

HTTP 200 返回 `{ "items": StudyNote[] }`。

```json
{
  "items": [
    {
      "id": "2efd30b5-6e6f-487e-a3ea-1594a8012ddc",
      "conversationId": "8e8fc70f-6035-4376-86ad-c06c94d05670",
      "conversationTitle": "RabbitMQ",
      "content": "幂等键要覆盖重试与重复投递",
      "createdAt": "2026-11-14T05:10:00.000Z"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 |
|---|---|---|---|---|---|
| `id` | `String` | 是 | `StudyNoteEntity.id` | 笔记 ID | UUIDv4 |
| `conversationId` | `String \| null` | 是 | `StudyNoteEntity.conversationId` | 关联会话；未关联为 `null` | UUIDv4 |
| `conversationTitle` | `String \| null` | 是 | 会话标题或首条 user 消息投影 | 列表显示的会话名 | 有会话时为非空文本 |
| `content` | `String` | 是 | `StudyNoteEntity.content` | 笔记正文 | 1–2000 个码点 |
| `createdAt` | `String` | 是 | `StudyNoteEntity.createdAt` | 添加时间 | ISO 8601 |

### Create a study note

- **方法**：`POST`
- **路径**：`/api/study-notes`
- **功能职责**：保存一条自写笔记；会话可选。
- **请求体**：`{ content, conversationId? }`。`content` 统一换行并 trim 外侧，最大 2000 个 Unicode 码点；省略 `conversationId` 表示不关联会话，给定时必须指向存在的会话。
- **响应**：HTTP 201，`StudyNote`。
- **错误**：`content` 为空或过长、`content` 不是字符串、出现未声明字段为 400；`conversationId` 不是 UUIDv4 为 400；会话不存在为 404。

### Delete a study note

- **方法**：`DELETE`
- **路径**：`/api/study-notes/:id`
- **功能职责**：删除一条笔记。
- **响应**：HTTP 200，`{ "id": "..." }`。
- **错误**：笔记不存在为 404；`id` 不是 UUIDv4 为 400。

#### Notes

- 笔记正文按纯文本渲染，不做 Markdown；因为没有消息锚点，列表不显示「第 N 条」，也没有摘录的引用竖线样式。
- 摘录与自写笔记的正文最多显示 4 行，超出部分折叠并显示「查看」，展开后可「收起」；折叠判定基于渲染后的实际行高，窗口变窄重新换行仍会重新判断。
- 桌面端「学习笔记」页把 `focus_items` 与 `study_notes` 合并成一条按 `createdAt` 倒序的时间线：摘录卡片保留引用样式、「第 N 条」与「编辑备注」，自写笔记卡片只显示正文与时间，有会话时额外显示会话名和「进入会话」。
- 点右上角「添加笔记」打开弹窗：会话下拉默认「不关联会话」，正文框初始 3 行、空白内容不能保存；「保存笔记」或 Ctrl/⌘+Enter 提交（成功后提示「笔记已保存」），「取消」、Esc 或点击遮罩放弃且不写库。保存失败时弹窗保持打开、就地显示错误并保留已输入内容。
