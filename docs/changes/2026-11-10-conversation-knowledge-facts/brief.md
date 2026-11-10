---
status: draft
layer: change
domain: rehearsals
created_at: 2026-11-10
requirements_review_status: approved
requirements_reviewed_at: 2026-11-10
---

# 会话知识掌握事实 Brief

## Problem

现有评估以单次演练为单位，不能直接表达教师在同一会话多次演练后的当前掌握情况。历史中的薄弱与后来的进步需要按时间解释，不能并列当作当前事实。

## Decision / Scope

每个会话保存一条知识掌握事实。演练报告成功落库后异步更新摘要（200 字符以内）、各知识点详细说明、关键词及英文掌握等级。先做后端生成、持久化和按会话查询。

上下文充足时读取全部历史评估；不足时使用已有事实、本次评估及最近 N 次历史评估，N 随预算变化。同会话串行生成，期间新评估触发持久化待处理状态，重启可恢复。

采用简化表，不增加 requestedVersion、publishedVersion、sourceEvaluationsJson、attemptCount；不建立独立知识点表。完整流程见 [功能设计](design.md)。用户已于 2026-11-10 确认需求评审。已实现后端生成、持久化与单会话查询；[技术设计评审](reviews/design-review.md)为 PASS，自动化 L1/L2 结果见 [verification](verification.md)，真实 provider L3 与验收标准确认仍待补。[API 契约](api-contract.md)及[响应 Schema](api-schema.json)已定义。

实施交接入口：[任务清单](tasks.md)，包含任务依赖、代码落点、AC 映射和交付检查。

## Out Of Scope

- 前端展示、普通对话注入、跨会话汇总和统一知识点库。
- 历史会话批量回填、手动重试入口、多后端进程并行调度。
