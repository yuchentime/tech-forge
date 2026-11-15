---
status: current
layer: domain
domain: rehearsals
canonical_for:
  - rehearsal-api-contract
related:
  - docs/current/domains/rehearsals/index.md
  - docs/current/domains/knowledge-profile/api-contract.md
  - docs/current/domains/conversations/api-contract.md
  - docs/current/platform/agent-runtime.md
  - docs/changes/2026-11-09-rehearsal-mode/design.md
last_verified: 2026-11-15
---

# 演练 API 契约

## Scope

- 覆盖演练开始、状态读取、回答、跳过、结束、历史列表及会话知识掌握事实只读查询。
- 知识掌握的 mock 卡片读取路由定义在同一 controller 下，但归知识掌握域所有，契约见[知识掌握接口](../knowledge-profile/api-contract.md)。
- 会话知识事实的生成规则、持久化和失败恢复见[演练模式](index.md#会话知识掌握事实)；本文件只定义 HTTP 契约。
- 所有接口通过现有 Electron JSON bridge 调用，受本地 token 与 loopback origin 检查保护；不接受账号、身份或租户参数。
- v1 使用 JSON 请求/响应，不使用 SSE。
- 字段使用 camelCase；时间使用 ISO 8601；ID 使用 UUIDv4。

## Conventions

- 开始请求使用 `startRequestId` 幂等；回答使用 `answerRequestId` 幂等；跳过以当前 `turnId` 为幂等锚点。
- 同一 Rehearsal 的 answer/skip/report 在 backend 进程内串行；并发请求返回 409。
- 状态转移使用条件更新；迟到结果在状态/run token 检查后丢弃。
- 错误响应沿用 Nest 的 `{ statusCode, message }`；不返回 prompt、回答、评估或报告原文。

## API

### Start a rehearsal

- **方法**：`POST`
- **路径**：`/api/conversations/:conversationId/rehearsals`
- **请求体**：

```json
{
  "persona": "可选，≤1000 字符",
  "startRequestId": "uuid-v4"
}
```

- **响应**：HTTP 201（首次与同一 `startRequestId` 重放）。返回完整 `RehearsalDetail`：
  - `rehearsalId`、`conversationId`、`status`、`topic`、`persona`、`plan`、`progress`、`currentQuestion`、`turns`、`report`、`endReason`、`startedAt`、`endedAt`、`createdAt`。
  - 首次成功时 `status = awaiting_answer`，`currentQuestion` 是第一条基础题。
  - 同一 `startRequestId` 重放返回已有状态；失败且无 turn 的旧行会原地重试规划。
- **错误**：400 画像超长；404 conversation 不存在；409 已有进行中演练或普通对话仍有 pending turn；422 没有足够普通历史/模型输出非法；502 Provider 失败；504 超时（供应方暂不可用）。provider 重试由 Pi SDK 配置管理，结构无效的输出不会额外发起修复请求。

### Read the in-flight preparing phase

- **方法**：`GET`
- **路径**：`/api/conversations/:conversationId/rehearsals/preparing`
- **响应**：`{ "rehearsalId": "uuid", "phase": "plan" }`，或 `null`。
- **语义**：
  - 只读诊断端点：不读数据库、不执行 reconciliation、不写任何行；轮询不会更新 `updatedAt`。
  - `phase` 取 `history` / `prior_summaries` / `session` / `plan` / `saving`，只用于准备画面的状态文案；进度条本身按预计时长推进，不使用这些阶段。
  - 没有进行中的 start、未知 conversation、进程重启导致内存态丢失时返回 `null`，不返回 404。
  - 响应只用于准备画面；不改变任何状态或错误映射。

### Get latest rehearsal

- **方法**：`GET`
- **路径**：`/api/conversations/:conversationId/rehearsals/latest`
- **响应**：最近一次 `RehearsalDetail`，或 `null`。用于切回演练模式时恢复当前题或最近报告。

### List rehearsal history

- **方法**：`GET`
- **路径**：`/api/conversations/:conversationId/rehearsals`
- **查询参数**：
  - `limit`：默认 20，最大 50。
  - `cursor`：上一页最后一条的 `rehearsalId`，必须属于当前 conversation。
  - `status`：`all`（默认）/ `active` / `completed` / `failed`。
- **响应**：

```json
{
  "items": [
    {
      "rehearsalId": "uuid",
      "status": "completed",
      "topic": "金字塔原理",
      "persona": "初二学生",
      "createdAt": "2026-11-09T12:29:00.000Z",
      "startedAt": "2026-11-09T12:30:00.000Z",
      "endedAt": "2026-11-09T12:52:00.000Z",
      "endReason": "limit",
      "progress": {
        "asked": 15,
        "limit": 15,
        "remaining": 0,
        "baseQuestions": 8,
        "skipped": 1,
        "currentFollowUpDepth": 0
      },
      "overallSummary": "结论先行掌握较好，MECE 分组仍不完整。",
      "hasReport": true
    }
  ],
  "counts": { "completed": 3, "active": 1, "failed": 0 },
  "nextCursor": "uuid-or-null"
}
```

- `items` 按 `createdAt DESC, id DESC` 排序；不返回 `turns`、`plan` 或完整报告。
- `counts` 是当前 conversation 的全量计数，不受 `status`/`limit`/`cursor` 影响。
- `overallSummary` 取报告 summary 的前 200 字符；报告失败时为 `null`。
- 读取时对“无活跃 run 且超过 120 秒”的遗留行执行 reconciliation。
- **错误**：404 conversation 不存在；400 limit/cursor 非法。

### Get one rehearsal

- **方法**：`GET`
- **路径**：`/api/rehearsals/:rehearsalId`
- **响应**：完整 `RehearsalDetail`，包含按 `sequenceNo ASC` 的 turns、逐题评估、报告、画像与计划。历史详情与当前会话共用该接口。
- **错误**：404 不存在。

### Submit an answer

- **方法**：`POST`
- **路径**：`/api/rehearsals/:rehearsalId/answers`
- **请求体**：

```json
{
  "turnId": "uuid-v4",
  "answer": "≤5000 字符",
  "answerRequestId": "uuid-v4"
}
```

- **响应**：HTTP 200：

```json
{
  "turnId": "uuid",
  "assessment": {
    "level": "correct | partial | incorrect | uncertain",
    "issues": ["..."],
    "evidence": ["..."],
    "missingPoints": ["..."]
  },
  "action": "follow_up | next_question",
  "question": { "turnId": "uuid", "sequenceNo": 2, "baseSequenceNo": 1, "followUpDepth": 1, "kind": "follow_up", "text": "..." },
  "completed": false,
  "report": null,
  "progress": { "...": "..." }
}
```

- 完成时 `completed=true`、`question=null`、`report` 非空。模型判断计划知识点已覆盖时提前完成，`endReason='coverage'`；达到 15 次上限时为 `limit`。
- 模型动作可为 `follow_up` / `next_question` / `finish`，但 `finish` 只用于提前结束，不会作为响应中的下一动作返回；完成响应的 `action=null`。
- `(rehearsalId, answerRequestId)` 唯一；重放返回首次结果。`turnId` 必须是当前可回答 turn。
- 进程重启后，若 turn 已是 `answer_saved`/`failed` 且保留了回答，客户端可用同一回答和新 `answerRequestId` 重新提交；后端会采纳新请求键并继续评估，不重复创建 turn。
- **错误**：400 空回答或超长；404；409 状态/题目已变化或并发；422 模型输出非法；502 Provider 失败；504 超时。

### Skip the current question

- **方法**：`POST`
- **路径**：`/api/rehearsals/:rehearsalId/skip`
- **请求体**：`{ "turnId": "uuid-v4" }`
- **响应**：与回答相同，但 `assessment=null`、`action="next_question"`。
- 跳过不评估、不追问，消耗 1 个名额；第 15 问被跳过时 `completed=true`。
- 重复跳过已 skipped 的 turn 且已有后续题时返回当前状态；下一题生成失败时可用同一 `turnId` 重试。
- **错误**：404；409 状态不允许；502/504 模型失败。

### End the rehearsal

- **方法**：`POST`
- **路径**：`/api/rehearsals/:rehearsalId/end`
- **请求体**：无。
- **行为**：abort 进行中的模型调用并等待退出；把 `awaiting_answer` 题标为 `unanswered`，保留 `answer_saved`/`failed` 题；转 `reporting`，生成总体报告，成功后 `completed`，失败 `failed` 且保留逐题数据。**没有任何已提交回答时返回 409**，需要改用丢弃接口。
- **响应**：HTTP 200 完整 `RehearsalDetail`（`status=completed`）。重复调用已完成演练返回已有报告。
- **错误**：404；409 报告正在生成或还没有任何回答；502/504 报告模型失败（可重试 end）。

### Discard a rehearsal

- **方法**：`DELETE`
- **路径**：`/api/rehearsals/:rehearsalId`
- **用途**：用户一题未答就结束演练，确认后直接丢弃本次演练。
- **行为**：abort 并等待进行中的调用；若任一 turn 已有非空回答则返回 409，要求结束并生成评估；否则删除该 Rehearsal 及其 turns、删除已有 transcript。记录已不存在时幂等返回成功。
- **响应**：HTTP 200 `{ "rehearsalId": "uuid", "discarded": true }`。
- **错误**：409 已有回答或正在处理。

### Delete a finished report

- **方法**：`DELETE`
- **路径**：`/api/rehearsals/:rehearsalId/report`
- **用途**：用户在演练历史的「已完成 / 报告未完成」行删除一份不再需要的报告。
- **行为**：只接受终态（`completed` / `failed`），进行中的演练返回 409（必须先结束或丢弃，避免丢掉正在作答的题）。同一事务删除该 Rehearsal 与全部 turns，并重置派生的知识事实：仍剩 `completed` 演练时把 `conversation_knowledge_facts` 置为 `pending` 并在提交后唤醒 worker 重算；一份都不剩时直接删除该事实行，使知识掌握回到空状态，而不是把已删报告的内容留在失败状态里。transcript 文件在事务提交后删除。
- **响应**：HTTP 200 `{ "rehearsalId": "uuid", "deleted": true }`。
- **错误**：404；409 演练还在进行中。

### List conversation knowledge facts

- **方法**：`GET`
- **路径**：`/api/knowledge-facts`
- **请求体 / 查询参数**：无；不返回分页。
- **行为**：只读 SQLite，返回全部事实行，按 `updatedAt DESC, conversationId ASC` 排序；不触发生成、不修复状态、不设置缓存。
- **性能边界**：列表项**不读取、不返回** `knowledgePointDetails`；需要知识点详情时使用单会话接口。
- **响应**：HTTP 200：

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

- 无记录返回 `{ "items": [] }`。
- 每项字段可空性与单会话 `fact` 相同：`generatedAt=null` 时 `summary`、`tags`、`masteryLevel` 均为 `null`；`failed` 时 `lastError` 非空，其他状态为 `null`。
- 时间为 UTC ISO 8601。列表项没有 `knowledgePointDetails` 字段，因此不能用它判断是否有已发布内容；使用 `generatedAt`。
- **错误**：401 本机 token 缺失或错误；403 任意 Origin（优先于 token）；500 读取失败或持久化 JSON 损坏，不泄露原始 JSON/SQL。

### Get conversation knowledge facts

- **方法**：`GET`
- **路径**：`/api/conversations/:conversationId/knowledge-facts`
- **请求体 / 查询参数**：无。
- **行为**：只读 SQLite，不触发生成、不修复任务状态、不重算事实、不设置缓存。会话与事实从同一读取视图确认；生成失败不改变 HTTP 200，只通过 `generationStatus`/`lastError` 表达。
- **响应**：HTTP 200：

```json
{
  "conversationId": "11111111-1111-4111-8111-111111111111",
  "fact": {
    "summary": "已能解释牛顿第二定律，复杂情境尚待验证。",
    "knowledgePointDetails": [
      {
        "name": "牛顿第二定律",
        "masteryLevel": "basic",
        "evidenceStatus": "sufficient",
        "details": "已能解释概念，复杂情境尚未验证。",
        "changeDescription": "本次为首次有效评估，尚无纵向比较。",
        "lastAssessedAt": "2026-11-10T07:50:00.000Z",
        "evidenceRefs": [
          {
            "rehearsalId": "22222222-2222-4222-8222-222222222222",
            "pointId": "point-1"
          }
        ]
      }
    ],
    "tags": ["力学"],
    "masteryLevel": "basic",
    "generationStatus": "completed",
    "lastError": null,
    "generatedAt": "2026-11-10T08:00:00.000Z",
    "createdAt": "2026-11-10T08:00:00.000Z",
    "updatedAt": "2026-11-10T09:00:00.000Z"
  }
}
```

- 会话存在但从未登记事实时返回 `{ "conversationId": "...", "fact": null }`，不返回 404。
- 首次尚未成功时 `summary`、`knowledgePointDetails`、`tags`、`masteryLevel` 均为 `null`，`generatedAt=null`；`generationStatus` 为 `pending` / `running` / `failed`。旧事实存在时更新中或更新失败返回完整上次成功内容，不拼入本次半成品。
- 成功发布后 `summary` 非空且 ≤200 Unicode code points；`knowledgePointDetails` 为数组（允许 `[]`）；`tags` 为 0–8 个去重非空字符串；`masteryLevel` 为 `proficient` / `basic` / `needs_improvement` 或 `null`；`generatedAt` 为最近成功时间。
- `knowledgePointDetails[]` 字段固定为 `name`、`masteryLevel`、`evidenceStatus`、`details`、`changeDescription`、`lastAssessedAt`、`evidenceRefs`。`evidenceStatus=insufficient` 时等级与 `lastAssessedAt` 为 `null`；`sufficient` 时二者非空；`conflicting` 允许为空。`evidenceRefs` 去重，`rehearsalId` 为 UUID，`pointId` 非空，且引用必须来自本次评估或旧事实原样携带并在同会话真实存在。
- 时间为 UTC ISO 8601；`generatedAt=null` 表示尚无已发布事实，消费者不能把 `generationStatus` 当作内容是否存在。`lastError` 仅在 `failed` 时非空且 ≤500 字符，其他状态为 `null`。
- 生成失败仍返回 HTTP 200；不是 502/504。
- **错误**：
  - 400：`conversationId` 非 UUIDv4，`message` 为校验信息。
  - 401：本机 token 缺失或错误，`{ "statusCode": 401, "message": "Unauthorized." }`。
  - 403：任意 Origin 请求头，优先于 token 校验，`{ "statusCode": 403, "message": "Origin is not allowed." }`。
  - 404：会话不存在，返回安全提示，不返回 `fact: null`。
  - 500：读取失败或持久化 JSON 损坏；返回通用信息，不泄露原始 JSON/SQL。

机器可读响应契约见变更中的 [`api-schema.json`](../../../changes/2026-11-10-conversation-knowledge-facts/api-schema.json)。

### Read the shared student persona

- **方法**：`GET`
- **路径**：`/api/rehearsal-persona`
- **用途**：进入任意会话的演练模式时预填画像编辑器。
- **行为**：读取 `<configDir>/rehearsal-persona.txt`；文件不存在或为空时返回空字符串。不按 conversation 隔离。
- **响应**：HTTP 200 `{ "persona": "..." }`（已 trim，≤1000 字符）。
- **错误**：500 文件不可读。

### Save the shared student persona

- **方法**：`PUT`
- **路径**：`/api/rehearsal-persona`
- **请求体**：`{ "persona": "≤1000 字符，可为空串" }`。
- **行为**：trim 后经同目录临时文件 + rename 原子替换，权限 `0600`；空串写入空文件，表示清空画像。编辑器失焦时调用。
- **响应**：HTTP 200 `{ "persona": "<保存后的值>" }`。
- **错误**：400 超过 1000 字符；500 文件不可写。

## 状态与计数

- `progress.asked` 包含基础题、追问和跳过；`remaining = limit - asked` 是距离上限的余量，不是必须完成的题数。
- `progress.currentFollowUpDepth` 只反映当前可回答/评估中的 turn；列表摘要固定为 0。
- `endReason`：`manual`（用户手动结束）、`coverage`（计划知识点已覆盖，模型提前结束）、`limit`（达到 15 次提问上限）、`failed`（报告失败）。
- `turns[].status`：`awaiting_answer`、`answer_saved`、`evaluated`、`skipped`、`unanswered`、`failed`。

## 重启与恢复

- 问题在创建时持久化，回答在提交时写入 `rehearsal_turns.answer`；评估和后续题目随后写入。
- 进入演练模式时读取 `latest`；`awaiting_answer` 恢复当前题和历史问答，`completed` 恢复报告，`failed` 恢复部分逐题数据。
- 没有活跃 run 的 `evaluating`/`preparing_next` 立即 reconciliation 为 `awaiting_answer`；保存的回答会作为“上次评估未完成”显示，可重试评估。
- 没有活跃 run 的 `reporting` 转 `failed`，可重试结束。

## 已知限制

- 没有跨 conversation 历史、报告导出、人工重评、计划编辑或 SSE。
- 报告失败时只保留逐题数据，不伪造总体结论。
- 普通对话 digest 的完整记录路径位于本地 session 目录，Renderer 不读取文件正文。
