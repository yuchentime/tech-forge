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
last_verified: 2026-11-09
---

# Conversation 查询接口契约

## Scope

- 覆盖本地个人工作台中 Agent 会话摘要列表与选中会话历史读取。
- 不包含会话创建、重命名、删除、摘要列表分页、工具活动或 Pi 原始消息格式；可见消息历史按固定页大小读取。
- 两个端点通过现有 Electron JSON bridge 调用，并受本地随机 token 和 loopback origin 检查保护；当前产品为单人 Personal Agent，没有用户或租户参数。
- 当前没有单独的跨领域 API conventions 页面；响应遵循本项目现有 JSON bridge 的 `{ status, data }` 包装。

## Conventions

- JSON 字段使用 camelCase。
- 时间以 ISO 8601 字符串返回。
- Conversation 与 Message ID 使用 UUIDv4。
- 接口只读 SQLite；摘要列表完整返回，消息历史每页最多返回 30 条并提供 hasMore。

## Conversation Query API

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
- 若增加重命名、搜索或大规模历史管理，再单独评估写 API 与分页。

### Get visible messages for one conversation

- **方法**：`GET`
- **路径**：`/api/conversations/:conversationId/messages`
- **功能职责**：用户选中侧栏会话时，加载最近一页可见文本；用户可按需继续读取更早内容。
- **鉴权/归属**：经 Electron 本地认证桥接调用；只读取给定 ID 的本地 Conversation。

#### Request Summary

| 位置 | 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| Path | `conversationId` | `String` | 是 | 要读取的 Conversation UUIDv4。 |
| Query | `beforeMessageId` | `String` | 否 | 同一 Conversation 中的消息 ID；读取其之前最近一页。缺省时读取最新一页。 |
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

##### Query Params

| 字段 | 类型 | 必填 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|
| `beforeMessageId` | `String` | 否 | 查询此消息之前更早的一页 | 属于目标 Conversation 的 Message UUIDv4 | 缺省时读取最近一页 |

##### Request Body

无。

#### Response Schema

HTTP 200 的响应体为分页对象。`messages` 按 `sequenceNo ASC` 排列，最多 30 条；`hasMore` 表示是否还有更早的可见消息。Electron JSON bridge 会将 HTTP 状态和响应体包装为 `{ "status": 200, "data": { "messages": [...], "hasMore": true } }`。

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
  ],
  "hasMore": true
}
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `messages` | `ConversationMessage[]` | 是 | ConversationsService 消息投影 | 当前页的可见消息 | 最多 30 条，按消息序号升序 | 无可见文本消息时为 `[]` |
| `hasMore` | `Boolean` | 是 | ConversationsService 分页查询 | 是否还有更早的可见消息 | `true` / `false` | 不为空 |

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
| `status` | `String` | 是 | `completed` 或 `failed`；中断执行按失败展示 |
| `durationMs` | `Number` | 否 | 工具自身耗时（毫秒） |

#### Error Cases

| 场景 | code | 说明 |
|---|---|---|
| `conversationId` 不是 UUIDv4 | `400` | `ParseUUIDPipe` 在 Service 查询前拒绝该路径参数。 |
| `beforeMessageId` 不是 UUIDv4 | `400` | Query DTO 校验在 Service 查询前拒绝游标。 |
| 游标不存在或属于其他会话 | `400` | 不接受不存在或跨 Conversation 的锚点，避免错误分页或跨会话数据访问。 |
| ID 格式正确但 Conversation 不存在 | `404` | 返回 not found；不会创建 Conversation 或消息。 |
| 本地 token 缺失或错误 | `401` | 后端拒绝未认证的本地请求。 |
| 请求带有 Origin header | `403` | 后端拒绝来自浏览器跨域路径的请求。 |

#### Notes

- 返回 `user` 与 `assistant` 的 `completed`、`failed`、`cancelled` 终态文本，按 `sequenceNo ASC` 排列。
- `toolExecution` 不作为顶层消息返回；仅在 user 行下投影 `toolActivities`。不返回原始工具参数、partial/final result、`toolResult`、`assistantTurn`、pending 行、thinking、原始 `contentJson` 或非文本 Pi blocks。
- `attachments` 只投影 `{attachmentId, name}`。附件正文保存在 `~/.tech-forge/sessions/<conversationId>/attachments/<attachmentId>/text.md`，从不写入消息行，因此不出现在历史接口；`characters` / `injectedCharacters` 只供服务端 prompt 使用。
- 每页最多返回 30 条；后续请求携带当前最早消息 ID 到 `beforeMessageId`，按稳定锚点读取更早页。加载最近页或更早页时，Renderer 按持久 user message ID 恢复活动摘要；整轮耗时未持久化，历史 UI 不显示该计时。
- 若 Renderer 读取历史时收到 `404`，会刷新摘要列表；若该 ID 已不在列表中，则清除过期活动 ID并显示会话已不存在。其他失败保留当前线程并提供重试。

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
| 数据库删除失败 | `500` | 事务回滚，会话与行保持原样。 |
| 本地 token 缺失或错误 | `401` | 后端拒绝未认证的本地请求。 |
| 请求带有 Origin header | `403` | 后端拒绝来自浏览器跨域路径的请求。 |

#### Notes

- 删除在一个事务内完成，子表优先：`rehearsal_turns` → `rehearsals` → `artifacts` → `conversation_documents` → `messages` → `pi_session_snapshots` → `conversations`（全部外键为 `NO ACTION`，顺序不可调换）。
- 本地 session 目录在事务提交后删除：文件清理失败不会回滚数据库结论，只返回 `sessionCleanup: "partial"` 并记录结构化日志。
- 桌面端在会话行悬停时显示「…」，点击后出现「删除会话」，点击即删除，没有二次确认；被删除的正是当前会话时，Renderer 同时清空线程与输入区状态。
