---
status: implemented
layer: change
domain: rehearsals
created_at: 2026-11-10
---

# 会话知识掌握事实 Implementation Notes

## 落点

| 关注点 | 文件 |
|---|---|
| 简化单表 | `apps/backend/src/rehearsals/conversation-knowledge-fact.entity.ts`、`apps/backend/src/database/migrations/1794010000000-conversation-knowledge-facts.ts` |
| 契约类型 | `apps/backend/src/rehearsals/conversation-knowledge-facts.types.ts` |
| 严格输出校验/引用/时间 | `apps/backend/src/rehearsals/conversation-knowledge-facts.validation.ts` |
| Prompt 与预算 | `apps/backend/src/rehearsals/conversation-knowledge-facts.prompts.ts`、`conversation-knowledge-facts.budget.ts` |
| 持久化状态、单 worker、恢复 | `apps/backend/src/rehearsals/conversation-knowledge-facts.service.ts` |
| 只读 HTTP（单会话 + 集合） | `apps/backend/src/rehearsals/conversation-knowledge-facts.controller.ts` |
| 报告完成同事务登记 | `apps/backend/src/rehearsals/rehearsals.service.ts` `finishRehearsal()` |
| 删除清理 | `apps/backend/src/conversations/conversations.service.ts` `deleteConversation()` |
| 模型绑定预算入口 | `apps/backend/src/llm/llm.service.ts` `LlmGenerateOptions.buildPrompt` |

## 状态协议

1. `markPending(manager, conversationId)` 使用 SQLite upsert：新行内容全 null；已有行只更新 `generationStatus='pending'`、`lastError=null`、`updatedAt`，保留全部已发布内容。
2. `wake()` 只把会话放入进程队列并触发串行 drain；不等待模型。drain 未运行时，周期 5 秒扫描按 `updatedAt ASC, conversationId ASC` 找 pending。
3. 领取事务：条件 `pending → running`，清空 `lastError`，同一事务读取旧事实与全部 completed 评估。模型调用在事务外。
4. 成功/失败只做 `WHERE generationStatus='running'` 的整体更新；影响 0 行时读取状态，`pending` 则回队尾重跑，行不存在则退出。完成路径没有 upsert。
5. 关闭时置 `stopped`、abort 当前调用并最多等待 2 秒；当前 `running` 留给下次启动。启动先把遗留 `running` 更新为 `pending`，再开始扫描。

## 输入与预算

- 评估顺序：`endedAt ASC, createdAt ASC, id ASC`；每条带 rehearsalId、endedAt、topic、知识点（pointId/name/原始等级/evidence）和总体报告。
- `current` 固定是快照最后一条；其余按时间升序作为历史。重跑读取最新快照，旧触发但被合并的报告自然进入历史，不会重复输入当前评估。
- 预算在 `LlmService.generate()` 内部、provider/model 解析后通过 `buildPrompt({contextWindow})` 构造；读取的窗口与 session 使用同一模型。
- 估算使用 UTF-8 字节数作为 token 上界；`available = contextWindow - 8192 - ceil(contextWindow*0.1)`；估算额外计入 4096 字节结构/修复余量。先全量历史，超限从最旧整份移除到 N=0；仍超限抛 `KnowledgeFactBudgetError`。
- 校验失败最多 3 次调用；修复追加文本也落在预算余量内。provider/传输错误不在事实服务重试。

## 引用与时间校验

- 新引用必须在本次 prompt 评估集合中，或与旧事实引用逐字段相同；所有引用还必须存在于此会话全部 completed 评估的 `rehearsalId + pointId` 集合。
- `lastAssessedAt` 必须是任一真实评估的 `endedAt`（归一化为 UTC ISO），不能使用生成时间。
- `insufficient` 强制等级/时间为 null；`sufficient` 强制二者非空；`conflicting` 允许为空。
- 同一次输出内同名知识点拒绝；标签 trim 后去重，超过 8 个拒绝；summary 按 Unicode code point ≤200。

## 测试映射

| AC | 覆盖 |
|---|---|
| AC-01 | core：`report completion registers...`、`a fact-signal write failure rolls...`；既有 `test:rehearsal` |
| AC-02 | core：`facts publish atomically...`、迁移 up/down/up；HTTP 各状态 |
| AC-03 | core：`a report arriving during generation...`、`an old failure cannot consume...`、`one worker serializes...` |
| AC-04 | core：`startup recovers...`、`a real child process recovers...` |
| AC-05 | core：排序/预算/引用断言；真实语义 L3 未覆盖 |
| AC-06 | core：`budget keeps all history first...`（全量、截断、N=0、窗口未知） |
| AC-07 | core：`strict fact validation rejects...`、旧引用/截断引用；HTTP schema |
| AC-08 | core：`a failed generation keeps all old content...`、模型选项断言 |
| AC-09 | core：迁移 up/down/up、删除中生成、删除失败回滚 |
| AC-10 | HTTP：四种状态 + JSON Schema + 损坏 JSON 500 |
| AC-11 | HTTP：401/403 优先级/400/404 + 无泄露 |
| AC-12 | core：损坏报告失败；既有 rehearsal/delete/session-entries 回归 |
| AC-13 | core：`listAll returns every fact without knowledge-point details`；HTTP：集合/空集合/认证；查询不选择详情列 |

## 已知限制

- 未执行真实 provider 的 L3 语义验收；`verify:knowledge-facts-provider` 需要 `TEACHFORGE_REAL_PROVIDER=1` 和已配置 API Key。
- 仅支持单后端进程；没有多实例调度、手动重试 API、前端消费或普通对话注入。
- 计划中的验收标准确认仍为 pending，未由实施者代签。
