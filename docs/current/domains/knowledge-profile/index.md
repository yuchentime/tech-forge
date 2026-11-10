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
last_verified: 2026-11-10
---

# Knowledge Profile

## Current Behavior

- 桌面端提供独立的「知识掌握」视图，以双列卡片展示会话标题、标签、掌握状态和完整摘要；详情入口打开单独的详情页面，页面上方的返回按钮回到原列表位置。
- 卡片有独立的「进入会话」入口；展示的每张卡都关联真实会话 ID，入口复用 `AgentChatPage` 的会话历史恢复流程。
- 当前卡片评估是 controller 中的固定 mock 样例，不是模型生成结果，也不从演练报告或对话正文计算。
- 后端有会话时，mock fact 按现有会话 ID 绑定；没有会话时返回空列表。
- 卡片 API 保留 `/api/rehearsals/knowledge-cards` 和 `{ items }` 外壳，列表项复用 `{ conversationId, fact }` 单会话事实响应 schema。
- Renderer 按 ID 从现有会话摘要读取标题；API 不重复返回标题。
- 掌握状态显示为「建议加强 / 基本掌握 / 熟练掌握」，按该顺序排序；同组按知识点 `lastAssessedAt` 最新值降序。

## Boundaries

- 本领域拥有知识掌握卡片的展示契约；演练报告和对话历史仍由各自领域管理。
- 评估摘要与详情以纯文本显示；Renderer 不解析 Markdown。
- API 只读，不写数据库；mock 数据不能作为用户真实掌握水平的证据。
- 当前列表仍从 controller 的 mock fixture 取值，不读取事实存储；复用响应 schema 不改变此列表的数据来源。

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
