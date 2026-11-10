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
last_verified: 2026-11-10
---

# 知识掌握接口契约

## Scope

- 覆盖桌面端读取会话知识掌握卡片的 mock API。
- 接口通过 Electron JSON bridge 调用本机 backend；不接受账号、身份或租户参数。
- 每个列表项复用会话事实契约中的 `{ conversationId, fact }` 结构；事实内容当前仍为 mock。

## Conventions

- 当前数据不表示真实演练评估或用户掌握结论，不写入数据库。
- `conversationTitle` 不由此 API 返回；Renderer 按 `conversationId` 与现有会话摘要合并。
- 单会话 fact 字段与可空性以[会话知识掌握事实 API Schema](../../../changes/2026-11-10-conversation-knowledge-facts/api-schema.json)为准。

## Knowledge Cards

### List mock knowledge profile cards

- **方法**：`GET`
- **路径**：`/api/rehearsals/knowledge-cards`
- **功能职责**：桌面端「知识掌握」视图读取会话事实卡片集合，展示掌握状态、摘要和知识点详情。
- **鉴权/归属**：沿用现有本机 JSON bridge 的 token 与 loopback origin 校验；数据属于本地单人应用。

#### Request Summary

该接口没有 path 参数、query 参数或请求体。

#### Response Schema

```json
{
  "items": [
    {
      "conversationId": "11111111-1111-4111-8111-111111111111",
      "fact": {
        "summary": "能结合实际场景说明 Redis 的用途；选择方案时还可以补充适用边界和取舍理由。",
        "knowledgePointDetails": [
          {
            "name": "Redis 应用场景",
            "masteryLevel": "needs_improvement",
            "evidenceStatus": "sufficient",
            "details": "能说明缓存、计数和短期状态保存等用途；方案选择的边界还需加强。",
            "changeDescription": "本次为 mock 评估，没有纵向变化结论。",
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
  ]
}
```

#### Response Fields

| 字段 | 类型 | 必填 | 说明 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|
| `items` | `KnowledgeFactResponse[]` | 是 | 每个会话一项，已按掌握等级与最近有效考察时间排序 | 数组 | 没有会话时为空数组 |
| `items[].conversationId` | `string` | 是 | 对应的真实本机会话 ID | UUIDv4 | 不允许为空 |
| `items[].fact` | `KnowledgeFact \| null` | 是 | 该会话的事实快照 | 对象字段见下表，或 null | null 表示尚无事实记录 |
| `fact.summary` | `string \| null` | 是 | 卡片完整展示的摘要 | 成功发布时非空且最多 200 Unicode code point | 未有成功结果时 null |
| `fact.knowledgePointDetails` | `KnowledgePoint[] \| null` | 是 | 点击详情后展示的知识点说明 | 成功发布后可为空数组 | 未有成功结果时 null |
| `fact.tags` | `string[] \| null` | 是 | 卡片标签 | 成功发布后 0–8 个去重非空字符串 | 未有成功结果时 null |
| `fact.masteryLevel` | `string \| null` | 是 | 卡片关注等级 | `proficient` / `basic` / `needs_improvement` / null | 总体证据不足时 null；当前卡片页不展示无等级事实 |
| `fact.generationStatus` | `string` | 是 | 最近一次事实生成状态 | `pending` / `running` / `completed` / `failed` | 不允许为空 |
| `fact.lastError` | `string \| null` | 是 | 脱敏后的生成失败说明 | failed 时非空且最多 500 字符 | 其他状态为 null |
| `fact.generatedAt` | `string \| null` | 是 | 最近一次成功发布事实的时间 | UTC ISO 8601 | 尚未成功发布时 null |
| `fact.createdAt` | `string` | 是 | 事实行创建时间 | UTC ISO 8601 | 不允许为空 |
| `fact.updatedAt` | `string` | 是 | 事实内容或生成状态最近更新时间 | UTC ISO 8601 | 不允许为空 |

#### Nested Objects

##### `items[].fact.knowledgePointDetails[]`

| 字段 | 类型 | 必填 | 说明 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|
| `name` | `string` | 是 | 知识点名称，必要时带范围限定 | trim 后非空 | 不允许为空 |
| `masteryLevel` | `string \| null` | 是 | 知识点掌握程度 | 三档枚举或 null | evidence 不足或冲突时可空 |
| `evidenceStatus` | `string` | 是 | 当前判断的证据状态 | `sufficient` / `insufficient` / `conflicting` | 不允许为空 |
| `details` | `string` | 是 | 当前掌握范围、薄弱项及未验证范围 | trim 后非空 | 不允许为空 |
| `changeDescription` | `string` | 是 | 变化或当前无纵向证据的说明 | trim 后非空 | 不允许为空 |
| `lastAssessedAt` | `string \| null` | 是 | 最近有效考察时间；卡片同等级排序使用该字段的最大值 | UTC ISO 8601 或 null | 无有效考察时 null |
| `evidenceRefs` | `EvidenceRef[]` | 是 | 可定位的同会话演练知识点引用 | 由 `rehearsalId` + `pointId` 唯一 | 无可定位引用时为空数组 |

##### `items[].fact.knowledgePointDetails[].evidenceRefs[]`

| 字段 | 类型 | 必填 | 说明 | 允许值/格式 | 为空语义 |
|---|---|---|---|---|---|
| `rehearsalId` | `string` | 是 | 来源演练 ID | UUIDv4 | 不允许为空 |
| `pointId` | `string` | 是 | 来源计划知识点 ID | 非空字符串 | 不允许为空 |

#### Error Cases

| 场景 | code | 说明 |
|---|---|---|
| 本机 bridge token 校验失败 | `401` | 返回 `{ "statusCode": 401, "message": "Unauthorized." }` |
| 请求携带 Origin | `403` | 返回 `{ "statusCode": 403, "message": "Origin is not allowed." }` |
| 读取会话摘要失败 | `500` | 返回 Nest 标准 `{ "statusCode", "message" }` 错误信封 |

#### Notes

- 当前后端对每个真实会话绑定一条固定 mock fact；没有会话时返回 `{ "items": [] }`。
- Renderer 使用会话摘要补充卡片标题。若 `fact` 为 null、尚无成功发布时间或总体掌握等级为空，该项不渲染成带等级的卡片。
- 卡片中的详情入口切换到独立详情页面；页面上方的返回操作回到列表。该视图变化不修改 API 响应 schema。
- `masteryLevel` 映射为「熟练掌握 / 基本掌握 / 建议加强」。同组按 `knowledgePointDetails[].lastAssessedAt` 最大值倒序；不使用 `generatedAt` 作为考察时间。
- mock 列表 API 与单会话 `GET /api/conversations/:conversationId/knowledge-facts` 共用每项 `{ conversationId, fact }` 结构；列表本身不读取该接口或事实存储。
