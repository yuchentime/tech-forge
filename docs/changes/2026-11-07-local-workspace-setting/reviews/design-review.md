---
status: passed
layer: change
review_type: design_review
created_at: 2026-11-07
design_path: docs/changes/2026-11-07-local-workspace-setting/design.md
design_version: 2.0
verdict: PASS
confirmation_status: approved
---

# Design Review: local-workspace-setting

## Summary

| Field | Value |
|---|---|
| Design | docs/changes/2026-11-07-local-workspace-setting/design.md |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: 增加工作空间设置，默认使用 config.toml 所属目录；用户之后自行从 SettingsService 取值。
- Design goals in scope: TOML 持久化、设置页编辑/恢复默认、公开读取方法。
- Design items outside ask: 文件搬迁、目录创建、Agent/LlmService 集成、文件夹选择 IPC。

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | 只增加本地设置字段和 UI，不接入 Agent 运行链路。 |
| No premature new abstraction layer | pass | 复用 SettingsController、SettingsService 与现有 desktop request bridge。 |
| No speculative generalization | pass | 只保存一个绝对路径并提供一个 getter。 |
| Cross-cutting surface growth justified | pass | DTO、设置响应、TOML 和设置页是该设置的最小闭环。 |
| Operational weight justified | pass | 无新进程、依赖、IPC、数据库表或目录副作用。 |
| Alternatives Considered includes a simpler option | pass | 评估 TOML、Electron userData、SQLite 和文件夹 IPC。 |
| Touch/complexity budget reasonable | pass | 不触碰 LlmService、AgentService、文件工具或 Electron bridge。 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | 本机路径属于 config.toml，不增加 SQLite 表。 |
| Alterations / migrations scoped | pass | 无 schema 或 migration 改动。 |
| Cross-domain FK / shared tables justified | pass | 不适用。 |
| Rollback / backfill cost acceptable | pass | 旧配置缺字段时回退到 config directory，无需迁移。 |
| No speculative schema for unused futures | pass | 仅增加 workspace.path 字符串。 |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 至 AC-04 覆盖默认、读写、getter 和路径边界。 |
| AC 代码接地 | pass | 引用现有 settings API、SettingsPage、SettingsService 和配置目录所有权。 |
| AC 可判定 | pass | 默认值、回填、保存、重置及相对路径拒绝均可明确判定。 |
| AC 粒度合适 | pass | 覆盖关键持久化与调用边界，不细化到序列化伪代码。 |
| 与 design.md 目标对应 | pass | 所有目标都映射到验收标准。 |
| Must-Not-Break 业务语义保留 | pass | Provider、SOULS、Agent cwd、工具边界和 SQLite 位置保持不变。 |

## Findings

### Over-design / risk findings

- Workspace path 不自动创建或应用；这与用户要求自行集成相符。

### Suggested cuts (thinner design)

- 无；设置表单、TOML 字段和 getter 是完成请求所需的最小改动。

### Worth keeping (surprising but justified now)

- 独立的 getWorkspacePath() 避免将路径混入 getLlmSettings()，符合用户要求由其自行接入。
- 对旧 TOML 缺字段做默认回退，使已有用户配置可继续读取。

## Developer Decision

- Decision: approved
- Reason / accepted cuts: PASS；严格限定路径设置读取与保存，不接入 LlmService。
- Confirmed at: 2026-11-07

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | AC 已按现有 settings API 与文件所有权核对；允许开始实现。 |

## v2.0 Design Review Addendum — 2026-11-08

### Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-07-local-workspace-setting/design.md` v2.0 |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

### Scope Anchor

- Original ask: 将独立 Agent 输出空间设为默认工作目录；允许读取任意来源；默认创建/编辑文件必须不可越界，只有用户本轮明确指定外部目标才临时例外；config.toml 与 SOULS.md 固定归应用设置服务。
- Design goals in scope: workspace 默认迁移及 UI 默认值、Pi cwd 统一、read/write 文件工具分权、托管文件保护、当前 prompt 一次性外部写入许可。
- Design items outside ask: 新上传 UI/API、bash/shell 或通用文件系统权限框架。

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | 只改本机设置、session cwd 与现有 read/edit/write 工具链。 |
| No premature new abstraction layer | pass | 复用 SettingsService、LlmService 与已有 Pi 自定义工具操作。 |
| No speculative generalization | pass | 许可只针对单轮 prompt 中唯一明确目标，不增加通用授权引擎。 |
| Cross-cutting surface growth justified | pass | backend session 与工具必须落实不可越界；设置 UI 用于展示同一默认位置。 |
| Operational weight justified | pass | 不新增数据库、进程、依赖、队列或持久权限。 |
| Alternatives Considered includes a simpler option | pass | 对比 prompt-only、cwd-only 与限制所有读取的方案。 |
| Touch/complexity budget reasonable | pass | 变更落在现有设置、session 初始化和文件工具责任区。 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | workspace 继续作为本机 TOML 字段，不新增表。 |
| Alterations / migrations scoped | pass | 只将历史默认目录映射到 child workspace；保留其他自定义路径。 |
| Cross-domain FK / shared tables justified | pass | 不适用。 |
| Rollback / backfill cost acceptable | pass | 旧默认路径惰性映射；不搬移用户文件或数据库。 |
| No speculative schema for unused futures | pass | 一次性授权只在 session 初始化内存中存在，不持久化。 |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | v2.0 增加 AC-05 至 AC-10，连续覆盖新增判断点。 |
| AC 代码接地 | pass | 引用现存 SettingsService、SettingsPage、LlmService、AgentService、Pi 工具入口和 EWORKSPACE。 |
| AC 可判定 | pass | 每条均给出确定的允许/拒绝行为和可走查落点。 |
| AC 粒度合适 | pass | 包括安全边界和 cwd，不规定方法级实现伪代码。 |
| 与 design.md 目标对应 | pass | 默认路径、读写分离、单轮例外和配置文件归属均有 AC。 |
| Must-Not-Break 业务语义保留 | pass | API Key 私有配置、设置 API 与既有 session persistence 均保留。 |

### Findings

#### Over-design / risk findings

- 解析用户文本的外部写路径必须失败关闭；因此设计限定唯一绝对目标、明确写入意图和当前平台路径，不做模糊自然语言目的地推断。
- 任意来源读取仍需拒绝应用托管文件，防止读取配置绕过 SettingsService 的密钥所有权。

#### Suggested cuts

- 不增加上传流程或通用授权模块；相关能力不在当前代码路径中。

#### Worth keeping

- 文件工具操作层的路径检查是安全边界，系统提示词仅提供行为说明。
- 硬链接身份校验与目录本体保护覆盖只做 realpath 检查无法发现的文件别名。

### Developer Decision

- Decision: approved
- Reason / accepted cuts: 开发者明确确认“可以实施”；v2.0 风险处理和 AC 通过。
- Confirmed at: 2026-11-08

### Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | 设计与 v2.0 AC 通过；已完成 AC 严格核验，可开始实施。 |
