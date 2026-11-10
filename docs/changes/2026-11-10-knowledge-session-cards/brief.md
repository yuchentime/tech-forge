---
status: implemented
layer: change
domain: knowledge-profile
created_at: 2026-11-10
---

# 会话知识掌握卡片 Brief

## Problem

TeachForge 需要按会话展示当前知识掌握情况。列表接口已提供轻量事实字段，知识点详情内容可能较大，应在用户打开详情时再按会话读取。

## Decision / Scope

- 使用 `GET /api/knowledge-facts` 获取轻量卡片列表；点击详情后使用 `GET /api/conversations/:conversationId/knowledge-facts` 获取完整事实。
- 桌面端新增「知识掌握」视图，以双列会话卡片呈现标题、标签、掌握状态、完整摘要和独立会话入口；详情在单独页面查看，页顶提供返回列表按钮。
- 评估状态为「建议加强 / 基本掌握 / 熟练掌握」。
- 排序为：建议加强 → 基本掌握 → 熟练掌握；组内按列表已有的 `updatedAt` 倒序。
- 标题由 Renderer 根据会话 ID 与现有会话摘要合并；没有可展示事实时显示空状态。

## Out Of Scope

- 从本功能重新计算或持久化知识事实；知识事实由其所属 API 与服务维护。
- Markdown 详情渲染、图谱、分数、百分比、跨用户比较与学习计划。
