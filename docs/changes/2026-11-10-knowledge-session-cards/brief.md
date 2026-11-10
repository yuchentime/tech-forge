---
status: implemented
layer: change
domain: knowledge-profile
created_at: 2026-11-10
---

# 会话知识掌握卡片 Brief

## Problem

TeachForge 目前没有跨会话的知识掌握页面。用户希望按会话浏览演练评估，并通过卡片的视觉状态发现值得回看的内容；真实汇总数据暂未接入。

## Decision / Scope

- 在 `RehearsalsController` 提供 mock 知识卡片读取 API，明确卡片响应 schema。
- 保留现有 `GET /api/rehearsals/knowledge-cards` 路由与 `{ items }` 外壳；每个列表项使用 `{ conversationId, fact }` 会话事实响应 schema。
- 桌面端新增「知识掌握」视图，以双列会话卡片呈现标题、标签、掌握状态、完整摘要和独立会话入口；详情在单独页面查看，页顶提供返回列表按钮。
- 评估状态为「建议加强 / 基本掌握 / 熟练掌握」。
- 排序为：建议加强 → 基本掌握 → 熟练掌握；组内按知识点最近有效考察时间倒序。
- 标题由 Renderer 根据会话 ID 与现有会话摘要合并；没有会话时列表为空。

## Out Of Scope

- 从真实演练数据计算跨会话评估。
- 不将知识卡片持久化到 SQLite。
- Markdown 详情渲染、图谱、分数、百分比、跨用户比较与学习计划。
