---
status: current
layer: change
review_type: design_review
created_at: 2026-11-06
design_path: docs/changes/2026-11-06-agent-streaming-loop/design.md
verdict: PASS_WITH_WARNINGS
confirmation_status: approved
---

# Design Review: Agent 单轮流式闭环

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-06-agent-streaming-loop/design.md` |
| Verdict | PASS_WITH_WARNINGS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

按任务文档实施一轮本地 Agent 流式对话：Renderer 经 Electron 安全桥接访问 NestJS，AgentService 委托已有 LLM 流；保留健康状态和 Course 原型。开发者确认允许复用当前 LlmService 已装载的扩展工具；不新增工具或工具调用 UI。

- Original ask: 按 `tasks.md` 实施 Agent 单轮流式闭环。
- Design goals in scope: Agent 文本流、受控 Main/Preload 桥接、保留 health 和 Course 入口。
- Design items outside ask (if any): 无。

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | 单轮文本闭环；明确允许当前已装载扩展工具，未扩展到持久化、多轮历史、检索或新增业务工具。 |
| No premature new abstraction layer | pass | 复用已有 AgentService、LlmService 和桌面桥接；没有新建通用运行时或消息总线。 |
| No speculative generalization | pass | 固定 Agent 路径和单一 Provider，不设计任意流代理。 |
| Cross-cutting surface growth justified | pass | DTO、SSE、专用 IPC 和 UI 适配器均是跨进程真实流式传输所需边界。 |
| Operational weight justified | pass | MessageChannelMain 生命周期与取消清理对应真实流式响应；不增加常驻服务或队列。 |
| Alternatives Considered includes a simpler option | pass | 评估了 JSON 缓冲响应及现有 invoke 请求，并说明它们不能交付增量。 |
| Touch/complexity budget reasonable | warning | 当前扩展包含 context 管理与子代理工具；这是比纯文本闭环更宽的能力。开发者确认保留此行为，设计已记录工具副作用和 UI 不呈现工具事件的边界。 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | 不新增表。 |
| Alterations / migrations scoped | pass | 不改字段、索引或枚举，不需要迁移。 |
| Cross-domain FK / shared tables justified | pass | 不涉及关系或共享表。 |
| Rollback / backfill cost acceptable | pass | 无持久化结构变化，无回填或数据回滚成本。 |
| No speculative schema for unused futures | pass | 设计没有预建 Conversation、Message 或 AgentRun 表。 |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 至 AC-07 连续。 |
| AC 代码接地 | pass | 当前落点标为现有代码；新增路由、DTO 和 bridge 明确标为目标合同。 |
| AC 可判定 | pass | AC-03 已修订为允许当前已装载扩展工具、禁止本次新增工具/工具事件，并明确通过代码走查判断。 |
| AC 粒度合适 | pass | AC 按认证、校验、委托、桥接、取消、无持久化和回归边界划分。 |
| 与 design.md 目标对应 | pass | 各项目标都有 AC 覆盖。 |
| Must-Not-Break 业务语义保留 | pass | 启动时序、健康请求、Course 操作及 token 边界均有明确检查。 |

### Permission Boundary

| Check | Result | Notes |
|---|---|---|
| Existing extension tools are explicit and bounded by the existing session setup | warning | Agent 将保留当前 Pi session 的 `billion-context-pi` 与 `pi-subagents` 扩展工具；工具调用可能执行本地 context 管理或子代理工作，且 UI 不呈现工具事件。开发者明确接受该能力；本次不增加扩展、任意 IPC 或新的工具权限面。 |

## Findings

### Over-design / risk findings

- Complexity — Architecture / Permission Boundary: `LlmService.stream()` 的 Pi session 装载 `billion-context-pi` 和 `pi-subagents` 扩展。`noTools: 'builtin'` 只禁用内置工具；扩展工具仍可用，可能执行本地 context 管理或子代理工作，且聊天 UI 不呈现工具调用。开发者选择保留此现有能力；设计已明确这项行为与本次不新增工具的边界。

### Suggested cuts (thinner design)

- 不新增工具注册、工具审批 UI 或工具事件协议；继续仅使用 `LlmService` 当前配置的扩展。开发者未采纳“关闭全部工具”的建议，并确认接受该能力。

### Worth keeping (surprising but justified now)

- 专用 Electron MessagePort 流桥接及取消生命周期：现有 JSON IPC 会等完整响应结束，无法满足“模型完成前已显示增量”的目标。
- 健康和 Course 回归：新增 IPC 与 App shell 会触及现有桌面入口，保留相应回归检查有必要。

## Developer Decision

- Decision: approved
- Reason / accepted cuts: 开发者确认允许 Agent 调用当前 `LlmService` 已装载的 Pi 扩展工具。设计、AC 与任务文档已同步；本次不新增工具，SSE/UI 仍只传递助手文本、完成和错误事件。
- Confirmed at: 2026-11-06

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | PASS_WITH_WARNINGS 已由开发者明确确认；当前扩展工具能力作为接受的设计范围记录。AC Review 已完成并 approved，可开始编码。 |

> 此评审保留一个已接受警告：当前扩展可能执行本地 context 管理或子代理工作，UI 不显示对应工具事件。设计已记录该能力，且本次不增加工具。AC Review 通过后可开始编码。
