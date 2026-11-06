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


---

# Design Review v2.0: Agent 单轮流式闭环

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-06-agent-streaming-loop/design.md` v2.0 |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: 将 Agent 的处理中间事件传到 UI，降低长时间等待时的不确定感；用户确认使用 Pi 原生事件和 EventBus 方式，同时最终回答继续流式输出。
- Design goals in scope: 每请求事件流、Pi lifecycle/tool/text 事件筛选、工具名和参数展示、最终文本增量、Electron 安全桥接、取消与状态清理。
- Design items outside ask (if any): 新增工具/RAG、全量 Pi payload 透传、思维链展示、持久化和重放。

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | 仅增加现有 Agent 请求的筛选事件与活动状态；不增加检索或工具能力。 |
| No premature new abstraction layer | pass | 不增加全局 EventBus 服务或第三方依赖；Renderer EventBus 只为同一请求事件的文本与活动状态消费者服务。 |
| No speculative generalization | pass | 采用单请求通道、固定 Agent 路径和固定 Pi 事件 allowlist；不支持重放或任意事件插件。 |
| Cross-cutting surface growth justified | pass | 后端 SSE、Electron decoder/Preload 与 Renderer 类型都必须允许事件到达；每个边界都有校验责任。 |
| Operational weight justified | pass | 复用每请求 SSE 和 MessagePort，异步事件队列保留现有取消与响应背压；无常驻进程或外部队列。 |
| Alternatives Considered includes a simpler option | pass | 评估了仅显示 spinner、全量 Pi 透传、自定义 progress 事件和全局总线。 |
| Touch/complexity budget reasonable | pass | 变更集中在已实现的单轮 Agent 流，不引入数据库、身份或多用户隔离。 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | n/a | 不新增持久化状态。 |
| Alterations / migrations scoped | n/a | 不改数据库结构。 |
| Cross-domain FK / shared tables justified | n/a | 不涉及关系或共享表。 |
| Rollback / backfill cost acceptable | n/a | 无数据迁移或回填。 |
| No speculative schema for unused futures | pass | 不引入 AgentRun 或事件历史表。 |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | v1 AC-01 至 AC-07 保留，v2 明确修订 AC-03/04 并新增 AC-08/09。 |
| AC 代码接地 | pass | `AgentSessionEvent` 与 `AgentSession.subscribe()` 在当前安装的 Pi SDK 声明中存在；现有 Controller、Main decoder、Preload validator 与 desktop bridge 是真实落点。 |
| AC 可判定 | pass | 事件名称、允许字段、顺序、终态和拒绝内容均可由 L1/L2 断言。 |
| AC 粒度合适 | pass | 分别覆盖 Pi 事件委托、边界过滤和运行生命周期；未将 AC 拆成方法级实现步骤。 |
| 与 design.md 目标对应 | pass | 事件交付、UI 活动态、最终回答流和取消处理均有 AC。 |
| Must-Not-Break 业务语义保留 | pass | JSON request、token 隔离、Course/health 路径和单轮无持久化继续由 v1 AC 覆盖。 |

### Permission Boundary

| Check | Result | Notes |
|---|---|---|
| Tool args visibility is explicit | pass | 用户明确要求展示 `tool_execution_start.args`；只通过本轮受控桥接发送。 |
| Pi payload remains allowlisted | pass | 明确排除结果、partial result、完整 messages/toolResults、未知事件和非文本内容。 |
| Existing desktop trust boundary remains | pass | Main 继续独占本地 token；Renderer 只能接收窄类型事件。 |

## Findings

### Over-design / risk findings

- None.

### Suggested cuts (thinner design)

- Do not introduce an external or process-wide EventBus package; the approved design keeps transport per request and the Renderer subscriber local.

### Worth keeping (surprising but justified now)

- Preserve the text delta as the Pi `message_update` event projection so the same ordered event stream updates both the UI activity state and the final assistant message.
- Strip payload fields at `AgentService`, before SSE encoding, so sensitive Pi message/tool result objects never reach Electron.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: PASS design stays within the existing one-run stream; no custom `progress` type, external bus, or raw Pi payload pass-through.
- Confirmed at: 2026-11-06

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | v2.0 goals, scope, API and verification criteria reviewed; AC-03/04/08/09 strict review recorded as approved before coding. |
