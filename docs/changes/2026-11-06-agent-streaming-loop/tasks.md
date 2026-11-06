---
status: in_progress
layer: change
domain: agent
created_at: 2026-11-06
canonical_for:
  - agent-streaming-loop-tasks
related:
  - docs/changes/2026-11-06-agent-streaming-loop/design.md
  - docs/changes/2026-11-06-agent-streaming-loop/verification.md
last_verified: 2026-11-06
---

# Agent 单轮流式闭环 Tasks

## Preconditions

- [x] `design.md` 已完成 Design Review；开发者确认保留现有扩展工具能力，达到 `DESIGN_REVIEW_PASS`。
- [x] 已识别需同步的当前事实页：`docs/current/platform/architecture-and-code-placement.md`。
- [x] 验收目标已写入 `verification.md` 并完成逐条 AC Review；`acceptance_review_status: approved`。

## Tasks

1. [x] **评审与开工门槛**：完成 Design Review（PASS_WITH_WARNINGS，开发者确认保留当前扩展工具）；逐条复核并修订 AC，`acceptance_review_status: approved`。
2. [x] **后端流式用例**：实现 prompt DTO 与 Agent HTTP streaming endpoint；让 `AgentService` 调用现有 `LlmService.stream()`；调整 `AgentModule`/`LlmModule` 导出与依赖；编码 SSE 事件并处理 provider 失败和客户端断开；为新增类和函数补充责任边界注释。对应 AC-01、AC-02、AC-03、AC-05、AC-06。
3. [x] **桌面流桥接**：在 `desktop-bridge.ts` 与 Preload 增加类型化流方法；Electron Main 通过固定 Agent 路径携带本地 token、增量解析 SSE、用 `MessageChannelMain` 转发事件，并处理请求 ID、取消和资源清理。保持现有 JSON `request()`。对应 AC-01、AC-04、AC-05、AC-07。
4. [x] **Assistant UI 页面**：引入 `@assistant-ui/react`，在 App shell 装配 `LocalRuntime` 和流式 `ChatModelAdapter`；添加 Agent 页面及标签；确保切换到 Course 页时 Runtime 仍挂载，保留健康状态和 Course 原型入口。对应 AC-03、AC-04、AC-07。
5. [x] **自动化验证**：增加基于 Node 内置 `node:test` 的局部测试，覆盖 AgentService 委托、事件编码/解析、输入校验和取消清理；增加默认只测本地 HTTP 的集成脚本，并用显式开关追加真实 DeepSeek HTTP 流。对应 AC-01 至 AC-06。
6. [x] **文档同步**：按代码事实更新平台架构页和路由；将最终 API/错误行为写回当前事实，保持 Course 原型状态记录准确。对应 AC-07。
7. [ ] **运行验收**：L1、本地 HTTP 回归、真实 DeepSeek 流和 Electron 启动/健康/Agent 完整回答已通过；停止生成与应用重启后的内存状态检查仍待完成，见 `verification.md`。

## Verification Commands

```bash
# 现有构建脚本：检查后端与桌面端类型/打包
npm run build:backend
npm run build --workspace @teachforge/desktop

# 以下脚本需由本变更的自动化验证任务新增
npm run test:agent-stream --workspace @teachforge/backend
npm run test:agent-stream --workspace @teachforge/desktop
npm run verify:agent-stream --workspace @teachforge/backend
npx cross-env TEACHFORGE_AGENT_LIVE_TEST=1 npm run verify:agent-stream --workspace @teachforge/backend
```

## Completion Checklist

- [x] Code behavior matches the approved design and AC scope.
- [x] L1, local HTTP, and real DeepSeek Provider checks pass; Electron streamed response and Course navigation also pass.
- [x] Current docs reflect implemented behavior.
- [x] No historical documents were superseded by this change.
- [x] No task-only document is routed as required runtime context.
