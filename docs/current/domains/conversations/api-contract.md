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
last_verified: 2026-11-07
---

# Conversation 查询接口契约

## Scope

- 覆盖本地个人工作台中 Agent 会话摘要列表与选中会话历史读取。
- 不包含会话创建、重命名、删除、分页、工具活动或 Pi 原始消息格式。
- 两个端点通过现有 Electron JSON bridge 调用，并受本地随机 token 和 loopback origin 检查保护；当前产品为单人 Personal Agent，没有用户或租户参数。
- 当前没有单独的跨领域 API conventions 页面；响应遵循本项目现有 JSON bridge 的 `{ status, data }` 包装。

## Conventions

- JSON 字段使用 camelCase。
- 时间以 ISO 8601 字符串返回。
- Conversation 与 Message ID 使用 UUIDv4。
- 接口只读 SQLite；列表与消息历史均返回完整数组，目前不分页。

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
- **功能职责**：用户选中侧栏会话时，加载完整可见文本历史并替换 Agent LocalRuntime 当前线程。
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

##### Query Params / Request Body

无。

#### Response Schema

HTTP 200 的响应体为按 `sequenceNo ASC` 排列的可见消息数组；无可见消息时为空数组。Electron JSON bridge 会将 HTTP 状态和响应体包装为 `{ "status": 200, "data": [...] }`。

```json
[
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
```

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `[]` | `ConversationMessage[]` | 是 | ConversationsService 消息投影 | 当前 Conversation 的可见消息 | JSON 数组，按消息序号升序 | 无可见文本消息时为 `[]` |

#### Nested Objects

##### `[]` (`ConversationMessage`)

| 字段 | 类型 | 必填 | 来源 | 含义 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|---|
| `id` | `String` | 是 | `MessageEntity.id` | 消息稳定 ID | UUIDv4 | 不为空 |
| `role` | `String` | 是 | `MessageEntity.role` | 用户或助手消息 | `user`、`assistant` | 不为空 |
| `content` | `String` | 是 | `contentJson` 中的 text block 投影 | Renderer 展示的纯文本内容 | UTF-8 文本 | 空文本消息不返回 |
| `status` | `String` | 是 | `MessageEntity.status` | 本条消息的完成状态 | `completed`、`failed`、`cancelled` | 不为空；pending 行不返回 |
| `createdAt` | `String` | 是 | `MessageEntity.createdAt` | 消息创建时间 | ISO 8601 | 不为空 |

#### Error Cases

| 场景 | code | 说明 |
|---|---|---|
| `conversationId` 不是 UUIDv4 | `400` | `ParseUUIDPipe` 在 Service 查询前拒绝该路径参数。 |
| ID 格式正确但 Conversation 不存在 | `404` | 返回 not found；不会创建 Conversation 或消息。 |
| 本地 token 缺失或错误 | `401` | 后端拒绝未认证的本地请求。 |
| 请求带有 Origin header | `403` | 后端拒绝来自浏览器跨域路径的请求。 |

#### Notes

- 返回 `user` 与 `assistant` 的 `completed`、`failed`、`cancelled` 终态文本，按 `sequenceNo ASC` 排列。
- 不返回 `toolExecution`、`toolResult`、`assistantTurn`、pending 行、thinking、工具调用参数、原始 `contentJson` 或非文本 Pi blocks。
- 当前不分页，响应历史完整文本；工具活动只显示当前运行时事件，恢复历史时不重建工具活动 UI。
- 若 Renderer 读取历史时收到 `404`，会刷新摘要列表；若该 ID 已不在列表中，则清除过期活动 ID并显示会话已不存在。其他失败保留当前线程并提供重试。
