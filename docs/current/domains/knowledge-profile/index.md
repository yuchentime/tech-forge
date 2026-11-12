---
status: current
layer: domain
domain: knowledge-profile
canonical_for:
  - knowledge-profile-cards
related:
  - docs/current/domains/rehearsals/index.md
  - docs/current/domains/conversations/index.md
  - docs/changes/2026-11-10-knowledge-session-cards/design.md
last_verified: 2026-11-12
---

# Knowledge Profile

## Current Behavior

- 桌面端提供独立的「知识掌握」视图，以响应式网格卡片展示会话标题、标签、掌握状态和完整摘要；列数随可用宽度自动调整，未填满的末行保留网格列宽。详情入口打开单独的详情页面，页面上方的返回按钮回到原列表位置。
- 卡片有独立的「进入会话」入口；展示的每张卡都关联真实会话 ID，入口复用 `AgentChatPage` 的会话历史恢复流程。
- 卡片列表读取 `GET /api/knowledge-facts`，按会话 ID 返回已生成事实的摘要、标签、等级和时间状态。
- 列表响应不包含 `knowledgePointDetails`；点击「查看详情」后才读取 `GET /api/conversations/:conversationId/knowledge-facts`。
- Renderer 按 ID 从现有会话摘要读取标题；API 不重复返回标题。
- 掌握状态显示为「建议加强 / 证据不足 / 基本掌握 / 熟练掌握」，按该顺序排序；`masteryLevel=null` 的已发布事实显示为「证据不足」，不再被过滤。同组使用列表中的 `updatedAt` 倒序，不为排序预取详情。
- 没有任何可展示卡片时显示共享空状态（`EmptyState`，图标 `Stack`）：说明卡片来自演练结束后的评估、生成需要时间，并提示先讲清主题再进演练模式。空状态不额外提供刷新按钮；切走再进入该视图会重新读取列表。

## Boundaries

- 本领域拥有知识掌握卡片的展示契约；演练报告和对话历史仍由各自领域管理。
- 评估摘要与详情以纯文本显示；Renderer 不解析 Markdown。
- facts API 只读，不触发事实生成；卡片列表与详情分别使用轻量列表接口和单会话详情接口。
- Renderer 不读取数据库或直接访问本机 HTTP；详情加载失败可重试，也可返回保留位置的列表。

## Canonical Docs

- `api-contract.md`：知识卡片只读 API 字段与排序契约。
- `../../../changes/2026-11-10-knowledge-session-cards/design.md`：本次实现的设计、边界与变更范围。
- `../../../changes/2026-11-10-knowledge-session-cards/verification.md`：实现验收约束。

## Task Routes

| Task | Read |
| --- | --- |
| 改知识掌握 API | `api-contract.md` → `../../../changes/2026-11-10-knowledge-session-cards/design.md` |
| 改卡片布局或交互 | 本页 → `../../../changes/2026-11-10-knowledge-session-cards/design.md` → `../../../changes/2026-11-10-knowledge-session-cards/verification.md` |

## Related Domains

- `../rehearsals/index.md`
- `../conversations/index.md`
