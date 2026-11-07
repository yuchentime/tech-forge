---
status: implemented
layer: change
domain: local-agent-settings
created_at: 2026-11-07
---

# 本机 Agent 设置任务

## Preconditions

- [x] Design Review is approved.
- [x] Required current docs are identified.
- [x] Verification target is known.

## Tasks

1. [x] 新增 backend 本机设置文件服务、Controller 和 DTO；生成 TOML 与 SOULS 默认文件。
2. [x] 将 DeepSeek/custom Adapter 和 `LlmService` 改为读取每个新 session 的 Provider 配置及 SOULS 内容。
3. [x] 在侧栏底部增加设置入口，在右侧主区域实现 Provider 表单和风格编辑界面。
4. [x] 更新 Agent Runtime、架构当前事实、系统设置当前事实、文档索引和 manifest 路由。
5. [x] 按任务约束检查代码与文档，不添加或运行测试。

6. [x] 按用户反馈改为由设置 API 返回已保存 Key，并在设置页明文显示。

## Verification Commands

- L001: npm run build — pass.
- L002: backend, renderer, and Electron TypeScript noEmit checks — pass.
- L002: npm run build — blocked with EBUSY because the running backend process holds apps/backend/dist.
- Tests were not added or run.

## Completion Checklist

- [x] Code behavior matches design; UI was opened and visually checked in Electron.
- [ ] Tests pass.
- [x] Current docs reflect final behavior.
- [x] Historical source design remains marked as a candidate draft; the API Key storage divergence is documented.
- [x] No task-only document is routed as required runtime context.
