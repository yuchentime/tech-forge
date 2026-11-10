---
status: draft
layer: change
domain: rehearsals
created_at: 2026-11-10
version: 3.0
---

# 会话知识掌握事实 API 契约

本文件定义单会话与集合只读接口契约；相关代码当前存在于工作树，完整实现状态以本变更的验证记录为准。业务流程见 [设计](design.md)，单会话 200 响应机器可读契约见 [JSON Schema](api-schema.json)。当前 knowledge-cards mock 列表保留原路由与 `{ items }` 外壳，其 `items[]` 复用这里的 `{ conversationId, fact }` 响应结构；列表中的事实仍是 mock，不代表该列表已读取事实存储。

## Endpoint And Access

`GET /api/conversations/:conversationId/knowledge-facts`

- conversationId：必填路径参数，UUIDv4；无请求体、无查询参数、无分页。
- 本机地址绑定和 `x-teachforge-token` 认证沿用 `apps/backend/src/main.ts`；禁止携带 Origin，包括 token 正确的请求。不是账号权限接口。
- 不触发生成、不修复任务状态、不重新计算事实；不设置缓存。存在会话但无事实行返回 200，不返回 404。
- 代码入口为 rehearsals 模块中的 `ConversationKnowledgeFactsController`，注册为独立 conversation 路径；不能误加在已有 `conversations/:conversationId/rehearsals` 前缀下面。该变更的 AC 验收仍待完成，不能仅凭代码存在宣称功能验收通过。

## Collection Endpoint And Access

`GET /api/knowledge-facts`

- 返回全部事实行，无请求体、无查询参数、无分页。
- 按 `updatedAt DESC, conversationId ASC` 排序；会话存在但从未登记事实时不出现，因此空集合返回 `{ "items": [] }`。
- 列表只查询并返回小字段：`conversationId`、`summary`、`tags`、`masteryLevel`、`generationStatus`、`lastError`、`generatedAt`、`createdAt`、`updatedAt`。
- **不读取、不返回 `knowledgePointDetails`**；需要知识点详情时使用单会话接口。消费者用 `generatedAt` 判断是否有已发布事实。
- 认证、Origin 拒绝、无生成副作用和 500 损坏处理与单会话接口相同。

```json
{
  "items": [
    {
      "conversationId": "11111111-1111-4111-8111-111111111111",
      "summary": "已能解释牛顿第二定律，复杂情境尚待验证。",
      "tags": ["力学"],
      "masteryLevel": "basic",
      "generationStatus": "completed",
      "lastError": null,
      "generatedAt": "2026-11-10T08:00:00.000Z",
      "createdAt": "2026-11-10T08:00:00.000Z",
      "updatedAt": "2026-11-10T09:00:00.000Z"
    }
  ]
}
```

## Response Schema

所有响应字段都必须出现，不以省略字段代替 null。时间为 UTC ISO 8601 字符串。summary 按 Unicode code point 计数（与 JSON Schema maxLength 一致），不按 UTF-16 code unit 计数。

知识掌握卡片 mock 列表的集合 schema 为 `#/$defs/KnowledgeCardsView`；每个 `items[]` 元素都必须符合本节的单会话响应 schema。

| 字段 | 类型 | 规则 |
|---|---|---|
| conversationId | UUID string | 请求会话 ID |
| fact | object / null | null 表示从未登记事实任务；对象字段如下 |
| fact.summary | string / null | 成功生成后非空且 ≤200 字符 |
| fact.knowledgePointDetails | array / null | 首次未成功为 null；成功后允许 [] |
| fact.tags | string[] / null | 首次未成功为 null；成功后 0–8 个去重非空标签，建议有依据时 3–8 个 |
| fact.masteryLevel | enum / null | proficient / basic / needs_improvement；总体证据不足可空 |
| fact.generationStatus | enum | pending / running / completed / failed |
| fact.lastError | string / null | failed 时非空且 ≤500 字符；其他状态为 null，不含 provider 正文或凭据 |
| fact.generatedAt | datetime / null | 最近成功发布时间；不表示当前任务开始时间 |
| fact.createdAt | datetime | 行创建时间 |
| fact.updatedAt | datetime | 状态或内容最近更新时间 |

每个 knowledgePointDetails 对象的字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| name | string | trim 后非空，名称包含必要范围 |
| masteryLevel | enum / null | 同总体三档枚举 |
| evidenceStatus | enum | sufficient / insufficient / conflicting |
| details | string | trim 后非空，说明当前判断与范围 |
| changeDescription | string | trim 后非空，说明变化或尚无纵向证据 |
| lastAssessedAt | datetime / null | 最近有效考察时间；不能填 generatedAt |
| evidenceRefs | object[] | 唯一组合 rehearsalId + pointId；两字段均必填；前者 UUID，后者非空字符串 |

业务校验补充：insufficient 必须等级为空且 lastAssessedAt=null；sufficient 必须有等级和有效考察时间；conflicting 允许等级/时间为空。标签 trim 后去重；同名同范围知识点不能重复，语义重复需要模型案例检查，JSON Schema 不能证明语义唯一。

evidenceRefs 只允许本次输入评估中的引用，或旧事实原样携带的引用；还需验证对应计划和评估在同一会话真实存在。旧引用保留不等于模型可以为被截断的评估新编引用。

## State And Nullability

| 条件 | 内容字段 | generatedAt | generationStatus |
|---|---|---|---|
| 会话存在，从未触发 | fact=null | 不适用 | 不适用 |
| 第一次生成尚未成功 | summary/details/tags/masteryLevel 均 null | null | pending/running/failed |
| 曾成功，正在更新或更新失败 | 返回完整上次成功内容，不拼入本次半成品 | 上次成功时间 | pending/running/failed |
| 本次成功 | 所有内容整体替换；总体等级允许 null | 本次成功时间 | completed |

消费者以 generatedAt 是否为空判断是否有已发布事实，以 generationStatus 判断更新状态。completed 且全体知识点证据不足时，允许 masteryLevel=null，不伪造掌握结论。

## Error Schema

错误沿用当前 Nest/Fastify 边界，响应至少含 statusCode:number、message:string|string[]；error:string 为可选字段，不新增全局错误 envelope。

| HTTP | 条件 | 响应约束 |
|---|---|---|
| 400 | conversationId 非 UUIDv4 | statusCode=400，message 为校验信息 |
| 401 | 本机 token 缺失或错误 | `{ "statusCode": 401, "message": "Unauthorized." }` |
| 403 | 任意 Origin 请求头 | `{ "statusCode": 403, "message": "Origin is not allowed." }`，优先于 token 校验 |
| 404 | 会话不存在 | statusCode=404，安全提示，不返回 fact=null |
| 500 | 数据读取失败或持久化 JSON 损坏 | statusCode=500，通用错误信息，不泄露原始 JSON/SQL |

生成失败是 GET 200 + generationStatus=failed，不是 GET 502/504。错误 envelope 为现有代码核对结果；新增接口仍需 HTTP 集成测试验证。

## Examples

首次尚未生成：

```json
{"conversationId":"11111111-1111-4111-8111-111111111111","fact":null}
```

已有内容但更新失败：

```json
{
  "conversationId": "11111111-1111-4111-8111-111111111111",
  "fact": {
    "summary": "已能解释牛顿第二定律，复杂情境尚待验证。",
    "knowledgePointDetails": [{
      "name": "牛顿第二定律",
      "masteryLevel": "basic",
      "evidenceStatus": "sufficient",
      "details": "已能解释概念，复杂情境尚未验证。",
      "changeDescription": "本次为首次有效评估，尚无纵向比较。",
      "lastAssessedAt": "2026-11-10T07:50:00.000Z",
      "evidenceRefs": [{
        "rehearsalId": "22222222-2222-4222-8222-222222222222",
        "pointId": "point-1"
      }]
    }],
    "tags": ["力学"],
    "masteryLevel": "basic",
    "generationStatus": "failed",
    "lastError": "生成超时，已保留上次结果。",
    "generatedAt": "2026-11-10T08:00:00.000Z",
    "createdAt": "2026-11-10T08:00:00.000Z",
    "updatedAt": "2026-11-10T09:00:00.000Z"
  }
}
```

示例 ID 为格式占位；实际引用必须通过同会话数据库证据校验。

## Existing Mock Cards Collection Reuse

当前桌面端仍一次读取全部卡片：

- **方法**：`GET`
- **路径**：`/api/rehearsals/knowledge-cards`
- **响应**：`{ "items": [KnowledgeFactResponse, ...] }`，集合结构见 `#/$defs/KnowledgeCardsView`。
- `items[]` 每项复用单会话 `{ conversationId, fact }` 字段结构；卡片标题由 Renderer 按 `conversationId` 与现有会话摘要合并，不增加额外响应字段。
- 当前 mock 对现有会话提供固定 fact 示例；没有会话时 `items` 为空。该列表接口不读写新事实表，也不触发生成任务。

## Version History

### v3.0 — 2026-11-10

- 触发：用户要求在事实 controller 新增查询全部记录的 list API，并考虑性能忽略详情字段。
- 改动内容：新增 `GET /api/knowledge-facts` 集合契约；列表按 `updatedAt DESC, conversationId ASC` 排序，只选择小字段，不读取/返回 `knowledgePointDetails`。
- 影响范围：只读 HTTP 列表；单会话响应、持久化和生成状态不变。
- 处理状态：已实现并通过 L1/L2 自动化。

### v2.0 — 2026-11-10

- 触发：开发者选择改造现有卡片 API schema。
- 改动内容：保留单会话事实字段 schema，并增加现有 `knowledge-cards` mock 列表复用 `{ conversationId, fact }` 响应结构的约定。
- 影响范围：当前卡片 mock 的 item schema；不新增单会话 endpoint 实现要求，也不改变 facts 持久化设计状态。
- 处理状态：已在当前 cards API 中实施。

### v1.0 — 2026-11-10（历史基线）

- 原契约只定义单会话事实响应；没有描述现有知识卡片列表复用该 schema。
- 由 v2.0 补充关联约定，单会话响应字段本身未改变。
