---
status: implemented
layer: change
domain: system-settings
created_at: 2026-11-07
---

# 本机工作空间设置任务

## Preconditions

- [x] Design Review is approved.
- [x] Required current docs are identified.
- [x] Verification target is known.

## Tasks

1. [x] 为新配置增加 workspace.path，并兼容缺少该字段的旧配置。
2. [x] 在 settings DTO、API 响应和 SettingsService 增加 workspacePath 与专用 getter。
3. [x] 在设置页增加可编辑路径和恢复默认操作。
4. [x] 更新系统设置事实、架构事实、manifest 和变更索引。
5. [x] 按任务约束运行非测试验证；不添加或运行测试。

## Verification Commands

- 类型检查或构建结果记录于 worklog.md。
- 不运行测试。

## Completion Checklist

- [x] Code behavior matches design.
- [x] No tests were added or run, per task scope.
- [x] Current docs reflect final behavior.
- [x] Historical or superseded docs are marked.
- [x] No task-only document is routed as required runtime context.

## v2.0 Post-Delivery Tasks

- [x] Design Review v2.0 and strict AC-05–AC-10 review approved before implementation.
- [x] Change default workspace to `.tech-forge/workspace/`, migrate the old default, and reject a workspace root that contains `.tech-forge`.
- [x] Apply workspace as Pi loader/session/tool cwd while retaining Pi's app-owned `agentDir`.
- [x] Allow arbitrary ordinary-file reads except app settings and atomic-replacement temp files; constrain writes, edits and directory creation to the workspace or current-turn explicit target.
- [x] Update workspace reset UI and clarify the read/write behavior.
- [x] Sync current docs, manifest and the change index.
- [x] Run backend/renderer/electron TypeScript checks and diff whitespace check; do not add or run tests.

### v2.0 Completion Checklist

- [x] Code behavior matches the approved v2.0 design.
- [x] Tests were not added or run under the task instruction.
- [x] Current docs reflect the shipped behavior.
- [x] v1.0 criteria and design review remain available as history.
- [x] The task document is not routed as required runtime context.
