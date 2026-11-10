---
status: draft
layer: change
domain: knowledge-profile
canonical_for:
  - knowledge-profile-implementation-verification
last_verified: 2026-11-10
version: 3.0
acceptance_review_status: approved
---

# 会话知识掌握卡片 Verification

## Test Layer Taxonomy

- **L1 — Local Logic Verification**：单个 API/排序状态逻辑的自动验证。
- **L2 — Automated Real-World Verification**：NestJS 路由、Electron bridge 和实际会话恢复的自动联动验证。
- **L3 — Human-Aided Verification**：桌面端视觉与交互验收。

## Acceptance Criteria（代码级验收规则）

### AC-01 事实 schema 复用

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `RehearsalsController.getKnowledgeCards` (`apps/backend/src/rehearsals/rehearsals.controller.ts`)；`KnowledgeCardsView` 与知识事实响应类型 (`apps/backend/src/rehearsals/rehearsal.types.ts`)；事实 JSON Schema (`docs/changes/2026-11-10-conversation-knowledge-facts/api-schema.json`) |
| 前置条件 | GET 请求经既有本地 JSON bridge 到达 controller |
| 预期行为 | 路径仍为 `GET /api/rehearsals/knowledge-cards`，返回 `{ items }`；每项严格符合 `{ conversationId, fact }`。fact 对象字段、null 规则、枚举和嵌套知识点/证据字段符合事实 schema；无会话时 items 为空数组 |
| 禁止出现 | 列表仍不调用 LLM、不根据会话文本或演练报告计算评估、不写 SQLite；不替换现存的单会话 facts 路由 |
| 判定方式 | TypeScript 类型与 controller 代码走查；核对列表与单会话路由职责互不替代 |

### AC-02 掌握状态排序

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `RehearsalsController` 的知识卡片 GET 路由 |
| 前置条件 | item.fact 含三种 `masteryLevel`，知识点可含 ISO `lastAssessedAt` |
| 预期行为 | 依次排序 `needs_improvement`、`basic`、`proficient`；同组按 `knowledgePointDetails[].lastAssessedAt` 的最大有效时间降序 |
| 禁止出现 | 使用 `generatedAt` 或当前时间改变排序；引入第四种掌握状态；将 `needs_improvement` 改成旧枚举 |
| 判定方式 | Controller comparator 代码走查；如用户要求验证，再补局部逻辑检查 |

### AC-03 卡片展示和交互

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/desktop/src/features/knowledge-profile/KnowledgeProfilePage.tsx` 和 `knowledge-profile-api.ts` |
| 前置条件 | 页面成功获取 `{conversationId, fact}` 列表 |
| 预期行为 | 按会话 ID 合并标题；只有 fact 已成功发布、摘要完整且总体等级非空时才显示卡片；卡片完整显示摘要；点击详情后切换到独立详情页面；详情页顶部「← 返回」回到原列表并保留滚动位置；知识点为空时隐藏详情入口；底部会话入口独立于详情入口；状态样式无卡片图标 |
| 禁止出现 | 显示整体印象/会话评估/冗余解释标题；摘要被截断；空 `conversationId` 发起跳转 |
| 判定方式 | API 校验器与 React 视图代码走查；如用户要求验证，再做桌面端视觉检查 |

### AC-04 会话入口

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/desktop/src/features/agent/AgentChatPage.tsx` 的 `loadConversation`；`KnowledgeProfilePage` 的会话入口 |
| 前置条件 | 卡片包含非空 `conversationId` |
| 预期行为 | 隐藏知识掌握视图并调用既有 `loadConversation(conversationId)` 流程 |
| 禁止出现 | 创建新会话、直接读取 SQLite/HTTP，或为 null ID 请求会话历史 |
| 判定方式 | 代码走查；如用户要求验证，再做桌面端交互检查 |

## Required Automated Checks

本轮未获执行测试/构建验证的请求，因此不运行命令。若后续要求验证，计划运行：

```bash
npm run build:backend
npm run build --workspace @teachforge/desktop
```

- [L1] 后端与桌面端构建用于检查 TypeScript/API contract 编译。
- [L2] 无新增持久化或第三方依赖；真实会话导航需桌面端验证。

## Required Manual Checks

- [L3] 检查主页面卡片排序、点击详情后的独立页面、页顶返回及列表位置保留、会话跳转；仅在用户要求视觉/交互验证时执行。

## Must-Not-Break Checks

- [ ] 资料库和设置仍可从原入口打开。
- [ ] 会话列表状态、运行中的会话和历史恢复行为不变。
- [ ] 现有演练开始、报告和详情路由不被静态 mock 路由影响。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| 状态排序 | 按建议加强、基本掌握、熟练掌握排列；同组按知识点最近有效考察时间倒序 | L1 | 代码走查/局部逻辑检查 | 保持关注顺序直观 |
| 未发布或无总体等级的事实 | 不呈现带掌握等级的卡片 | L1 | 前端代码走查 | 不引入未确认的第四种状态 |
| 打开详情并返回 | 进入单独详情页；点页顶箭头后回到原列表位置 | L1/L3 | 组件状态代码走查；桌面端交互检查 | 长详情不挤压卡片列表，可连续浏览 |
| 从有效卡片进入会话 | 复用当前恢复路径 | L2/L3 | Electron UI 检查 | 防止新入口破坏会话恢复 |

## Known Guardrails

- Mock 评估不是真实掌握结论，不能在产品文案中宣称真实分析已上线。
- 不基于时间衰减调整掌握等级和排序。

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | `RehearsalsController.getKnowledgeCards` 是现有静态路由；列表项改用 `{conversationId, fact}`，其 fact 字段与对应 schema 对齐。 |
| AC-02 | pass | facts schema 为同组排序提供 `lastAssessedAt`；`generatedAt` 只表示最近成功发布时间。 |
| AC-03 | pass | v3 明确详情页切换、页顶返回和列表位置保留；`KnowledgeProfilePage` 是现有列表与详情视图的状态边界。 |
| AC-04 | pass | `AgentChatPage.loadConversation(conversationId)` 和侧栏会话选择回调已存在；卡片导航复用此路径。 |

- 评审结论：AC 已协商一致
- 评审方 / 确认人 / 时间：Codex（逐条对照当前代码核验）/ 用户已授权实施 / 2026-11-10

## Version History

### v1.0 — 2026-11-10（历史基线）

- 原 AC-01 验证扁平字段 `cardId`、`conversationId`、`conversationTitle`、`tags`、`masteryStatus`、`assessmentSummary`、`assessmentDetails`、`evaluatedAt`。
- 原 AC-02 按 `needs_strengthening`、`basic`、`proficient` 排序，同组按 `evaluatedAt` 倒序。
- 原 AC-03/AC-04 分别覆盖卡片摘要/详情交互和既有会话恢复入口。
- 原验收评审记录：

| AC | 核验结果 | 备注 |
| --- | --- | --- |
| AC-01 | pass | 原扁平 mock 字段属于首版新增契约。 |
| AC-02 | pass | `evaluatedAt` 仅用于同组排序，不驱动时间衰减。 |
| AC-03 | pass | 摘要常显、详情折叠、无卡片图标。 |
| AC-04 | pass | 复用 `AgentChatPage.loadConversation(conversationId)`。 |

### v2.0 — 2026-11-10

- 触发：开发者提供会话知识事实 API schema，并选择改造现有知识卡片 API schema。
- 改动内容：AC-01 改为验证 `{ conversationId, fact }` 与事实 schema；AC-02 使用 `masteryLevel` / `lastAssessedAt`；AC-03 增加已发布/null fact 过滤与知识点详情映射要求。
- 影响范围：API contract 验收、排序、卡片映射与错误边界；`Must-Not-Break` 继续覆盖资料库、设置、会话恢复和演练路由。
- 处理状态：已按当前代码重新核验并实施；构建和视觉验收未执行。

#### v2.0 Acceptance Criteria Review（历史记录）

| AC | 核验结果 | 备注 |
| --- | --- | --- |
| AC-01 | pass | 路由和 controller 已存在；item 是 `{conversationId, fact}` 并对齐 facts schema。 |
| AC-02 | pass | 同组使用 `lastAssessedAt` 最新有效时间，不使用 `generatedAt`。 |
| AC-03 | pass | 原要求是摘要常显、详情卡内按需展开、无卡片图标。 |
| AC-04 | pass | 卡片导航复用 `AgentChatPage.loadConversation(conversationId)`。 |

### v3.0 — 2026-11-10

- 触发：开发者反馈详情内容通常较多，要求详情进入独立页面，并通过上方「←」返回。
- 改动内容：AC-03 改为独立详情页面、页顶返回和列表滚动位置恢复；卡片详情入口仍与会话入口分开。
- 影响范围：知识掌握页的局部视图状态和 L3 交互验收；API schema、mock、排序和会话恢复边界不变。
- 处理状态：v3 设计评审、AC 严格核验和代码实现已完成；未运行构建和产品测试。
