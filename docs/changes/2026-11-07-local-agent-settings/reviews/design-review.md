---
status: passed
layer: change
review_type: design_review
created_at: 2026-11-07
design_path: docs/changes/2026-11-07-local-agent-settings/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: local-agent-settings

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-07-local-agent-settings/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: 在 Agent 侧栏加设置入口，右侧显示模型和风格设置；配置落本机 `~/.tech-forge/config.toml` 与 `SOULS.md`，新 session 加载风格偏好。
- Design goals in scope: Provider 选择、API Key、DeepSeek 默认模型/自定义参数、文件持久化和 system prompt 注入。
- Design items outside ask: 数据目录迁移、Provider 连通性测试、数据库配置表、系统密钥链。

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | 聚焦本机模型/风格设置和 Agent session 入口。 |
| No premature new abstraction layer | pass | 一个设置 Service/Controller 是文件与 HTTP 边界所需，不引入全局状态层或 API client 框架。 |
| No speculative generalization | pass | 只建模 DeepSeek 和本次要求的自定义 OpenAI-compatible Provider。 |
| Cross-cutting surface growth justified | pass | 设置 API、runtime adapter 和主界面入口直接对应用户功能；复用桌面请求桥接。 |
| Operational weight justified | pass | 不加缓存、队列、外部依赖或迁移；session 读取本地配置快照。 |
| Alternatives Considered includes a simpler option | pass | 比较了 SQLite、Renderer 文件访问和共享 runtime 重注册。 |
| Touch/complexity budget reasonable | pass | 覆盖必要的 backend、Electron UI 和当前事实文档；无通用设置平台。 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | 本机配置是文件资产，不新增 SQLite 表。 |
| Alterations / migrations scoped | pass | 无 schema 或 migration 变化。 |
| Cross-domain FK / shared tables justified | pass | 不涉及。 |
| Rollback / backfill cost acceptable | pass | 只创建用户目录文件；无需迁移既有数据。 |
| No speculative schema for unused futures | pass | 只保存当前两个 Provider 和 Markdown 风格偏好。 |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01 至 AC-04 连续。 |
| AC 代码接地 | pass | 引用当前存在的页面、适配器注册、session 创建和桌面 request API。 |
| AC 可判定 | pass | 文件路径、脱敏、模型选择、prompt 注入和视图切换均有明确规则。 |
| AC 粒度合适 | pass | 四条 AC 覆盖模型、存储/脱敏、提示词、视图/回归。 |
| 与 design.md 目标对应 | pass | 目标均映射到 AC。 |
| Must-Not-Break 业务语义保留 | pass | Runtime、SSE、工具权限和 preload 边界列入回归约束。 |

### Permission / Current-Doc Conflict

| Check | Result | Notes |
|---|---|---|
| 本机密钥写入符合明确需求 | pass | 需求指定 config.toml；设计记录与旧草案的差异并约束只写不读回。 |
| 当前数据/执行边界保留 | pass | SQLite 路径、Electron token 和 Pi 工具边界不变。 |

## Findings

### Over-design / risk findings

- None blocking. Plain-text local API Key is user-specified; UI/API redaction and per-user file permissions are in scope.

### Suggested cuts (thinner design)

- No cuts. File service and runtime integration are the minimum needed for this request.

### Worth keeping (surprising but justified now)

- Create a per-session ModelRuntime so saved settings take effect without relying on undocumented re-registration behavior.
- Return only `apiKeyConfigured` and preserve existing keys when the form leaves fields blank.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: PASS; no cuts required. Follow the explicit request and record the source-design deviation.
- Confirmed at: 2026-11-07

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | AC review is approved before implementation. |

## Revision Review — v2.0

### Scope Anchor

- User feedback: after saving an API Key, reopening Settings must display the saved value in plaintext.
- In scope: include saved keys in the existing authenticated local settings response and populate the settings inputs with plaintext values.
- Outside scope: expose keys through Agent SSE, logs, Conversation records, a general renderer API, or any remote service.

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | This directly fixes the reported empty input after reopening Settings. |
| No premature new abstraction layer | pass | Reuses the existing SettingsController, SettingsService, and desktop request bridge. |
| No speculative generalization | pass | The plaintext response is confined to the existing settings screen. |
| Cross-cutting surface growth justified | pass | Extends only the local settings response shape and the matching UI model. |
| Operational weight justified | pass | No new process, dependency, cache, or persistence system. |
| Alternatives Considered includes a simpler option | pass | Returning the stored field directly is the smallest change. |
| Touch/complexity budget reasonable | pass | Backend response, form state, current facts, and AC are the affected surfaces. |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | No database change; existing TOML key remains the source of truth. |
| Alterations / migrations scoped | pass | Only the local settings response type changes. |
| Cross-domain FK / shared tables justified | pass | Not applicable. |
| Rollback / backfill cost acceptable | pass | No migration or backfill. |
| No speculative schema for unused futures | pass | No new persisted fields. |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC exists and remains numbered | pass | AC-02 now explicitly requires plaintext readback. |
| AC code grounded | pass | Uses GET /api/settings, LocalSettingsView, SettingsPage, and the existing desktop request bridge. |
| AC judgeable | pass | The saved value must be present in the response and text input after loading. |
| AC granularity appropriate | pass | Tests the response and UI state that caused the reported symptom. |
| Goals map to AC | pass | The readback requirement is included in the revised design goal and AC-02. |
| Existing behavior preserved | pass | Key remains out of Agent SSE, ordinary logs, and SQLite. |

### Risk And Guardrails

The API Key becomes available in renderer memory and is visible in the Settings input. This is the explicit user requirement. The response remains on the existing authenticated local Electron bridge; unrelated Agent and persistence flows do not receive the key.

### Developer Decision

- Decision: approved
- Reason: the user explicitly requested that Settings display the saved API Key in plaintext.
- Confirmed at: 2026-11-07

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS v2.0 | passed | The response contract change is scoped to the local Settings view. |