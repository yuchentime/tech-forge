---
status: current
layer: domain
domain: knowledge-profile
canonical_for:
  - knowledge-profile-api-contract
related:
  - docs/current/domains/knowledge-profile/index.md
  - docs/current/domains/rehearsals/api-contract.md
  - docs/current/domains/conversations/api-contract.md
  - docs/changes/2026-11-10-conversation-knowledge-facts/api-contract.md
last_verified: 2026-11-10
---

# 知识掌握接口契约

## Scope

- 桌面端先读取轻量 facts 列表，再在用户进入详情页时按会话读取完整事实。
- 两个接口都通过 Electron JSON bridge 调用本机 backend；不接受账号、身份或租户参数。
- 会话标题由 Renderer 按 `conversationId` 与已有会话摘要合并，不重复由 API 返回。

## List knowledge facts

- **方法**：`GET`
- **路径**：`/api/knowledge-facts`
- **请求参数**：无。
- **职责**：返回卡片列表所需的小字段；不读取、不返回可能较大的 `knowledgePointDetails`。

```json
{
  "items": [
    {
      "conversationId": "11111111-1111-4111-8111-111111111111",
      "summary": "能结合实际场景说明 Redis 的用途；选择方案时还可以补充适用边界和取舍理由。",
      "tags": ["Redis", "应用场景"],
      "masteryLevel": "needs_improvement",
      "generationStatus": "completed",
      "lastError": null,
      "generatedAt": "2026-11-09T10:05:00.000Z",
      "createdAt": "2026-11-09T10:05:00.000Z",
      "updatedAt": "2026-11-09T10:05:00.000Z"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `items` | `KnowledgeFactListItem[]` | 所有已有事实行；无事实时为空数组 |
| `items[].conversationId` | UUID string | 对应会话 ID |
| `items[].summary` | string / null | 已发布事实的完整摘要，最多 200 个 Unicode code point；首次生成成功前为空 |
| `items[].tags` | string[] / null | 已发布事实的标签；首次生成成功前为空 |
| `items[].masteryLevel` | enum / null | `proficient` / `basic` / `needs_improvement`；证据不足时可以为空 |
| `items[].generationStatus` | enum | `pending` / `running` / `completed` / `failed` |
| `items[].lastError` | string / null | 失败时的安全错误摘要；其他状态为空 |
| `items[].generatedAt` | datetime / null | 最近成功发布时间；为空表示还没有已发布内容 |
| `items[].createdAt` | datetime | 事实行创建时间 |
| `items[].updatedAt` | datetime | 状态或事实内容最近更新时间 |

列表 API 按 `updatedAt DESC, conversationId ASC` 返回。卡片页展示 `generatedAt` 非空、摘要非空且 `tags` 非空的事实；总体 `masteryLevel` 为 `null` 时仍展示为「证据不足」，不视为缺少事实。展示排序为「建议加强 → 证据不足 → 基本掌握 → 熟练掌握」，同组按列表字段 `updatedAt` 倒序。列表不为排序提前请求详情。

## Read one conversation's full fact

- **方法**：`GET`
- **路径**：`/api/conversations/:conversationId/knowledge-facts`
- **请求参数**：`conversationId` 为 UUIDv4；无请求体或查询参数。
- **职责**：读取单会话完整事实。Renderer 只在点击「查看详情」并进入详情页时调用。
- **响应结构与字段约束**：见[会话知识掌握事实 API 契约](../../../changes/2026-11-10-conversation-knowledge-facts/api-contract.md#response-schema)。响应为 `{ conversationId, fact }`；`fact` 可为空，完整事实包含 `knowledgePointDetails`。

```json
{
  "conversationId": "11111111-1111-4111-8111-111111111111",
  "fact": {
    "summary": "能结合实际场景说明 Redis 的用途。",
    "knowledgePointDetails": [
      {
        "name": "Redis 应用场景",
        "masteryLevel": "needs_improvement",
        "evidenceStatus": "sufficient",
        "details": "能说明缓存和计数等用途；方案选择的边界还需加强。",
        "changeDescription": "本次为首次有效评估，尚无纵向比较。",
        "lastAssessedAt": "2026-11-09T10:00:00.000Z",
        "evidenceRefs": []
      }
    ],
    "tags": ["Redis", "应用场景"],
    "masteryLevel": "needs_improvement",
    "generationStatus": "completed",
    "lastError": null,
    "generatedAt": "2026-11-09T10:05:00.000Z",
    "createdAt": "2026-11-09T10:05:00.000Z",
    "updatedAt": "2026-11-09T10:05:00.000Z"
  }
}
```

## Error and loading behavior

- 本机 bridge token 校验失败返回 401；请求携带 Origin 返回 403；具体错误 envelope 遵循本机 API 约定。
- 列表读取失败时保留可重试入口；详情读取失败时留在独立详情页显示错误和重试按钮，页顶返回按钮仍可回到列表原位置。
- 详情加载期间展示明确的加载状态；`fact` 为空或没有知识点时显示空详情文案，不伪造掌握状态。
