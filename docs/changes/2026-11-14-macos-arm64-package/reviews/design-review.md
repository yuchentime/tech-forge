---
status: completed
layer: change
review_type: design_review
created_at: 2026-11-14
design_path: docs/changes/2026-11-14-macos-arm64-package/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: macos-arm64-package

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-14-macos-arm64-package/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

## Scope Anchor

- Original ask: 需要支持 macOS 苹果芯片包。
- Design goals in scope: 增加 Apple Silicon macOS 本地 DMG 构建，保留 Darwin arm64 后端原生依赖并保持 Windows x64 打包。
- Design items outside ask (if any): Developer ID 签名、公证、官网分发及其它架构均明确排除。

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | 只增加构建目标及 staging 平台筛选。 |
| No premature new abstraction layer | pass | 复用现有 staging 与 builder 配置。 |
| No speculative generalization | pass | 仅支持本次明确目标 `win32 x64` 与 `darwin arm64`。 |
| Cross-cutting surface growth justified | pass | 包脚本、staging 和 electron-builder 三处必须协同改变。 |
| Operational weight justified | pass | 无服务、队列或外部上传；明确关闭公证。 |
| Alternatives Considered includes a simpler option | pass | 已说明单改 builder target 为何不足。 |
| Touch/complexity budget reasonable | pass | 不改运行时代码、依赖或业务行为。 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | n/a | 无数据模型变化。 |
| Alterations / migrations scoped | n/a | 无数据库变化。 |
| Cross-domain FK / shared tables justified | n/a | 无数据库变化。 |
| Rollback / backfill cost acceptable | n/a | 无数据库变化。 |
| No speculative schema for unused futures | pass | 不新增 schema。 |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC exists and numbering is continuous | pass | AC-01 至 AC-03 连续。 |
| AC is grounded in code | pass | 根构建配置、staging 脚本和原生依赖路径均已对照现状核验。 |
| AC is judgeable | pass | 以包文件、二进制路径与目标配置判定。 |
| AC granularity is appropriate | pass | 覆盖产物、原生依赖与 Windows 回归边界。 |
| Maps to design goals | pass | 每项构建目标均有对应 AC。 |
| Must-Not-Break business semantics retained | pass | 保留 Windows 安装与用户数据目录语义。 |

## Findings

### Over-design / risk findings

- Signing and notarization are needed before public distribution, but adding them now would require Apple credentials and external notarization; they remain out of scope.

### Suggested cuts (thinner design)

- None.

### Worth keeping (surprising but justified now)

- Verify Darwin arm64 native files before packaging because the existing script deletes platform binaries after copying dependencies.

## Developer Decision

- Decision: approved
- Reason / accepted cuts: 按用户原始请求实施 Apple Silicon 本地包；签名、公证与发布留待单独安排。
- Confirmed at: 2026-11-14

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | 可开始实施；AC Review 已在 `verification.md` 核对并批准。 |
