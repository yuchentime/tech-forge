# Worklog: conversation-history-sidebar

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 提供 Conversation 查询 API 并在 Agent 左侧栏加载和切换历史 | 增加 Conversation 摘要/消息 GET API、侧栏和选中会话 LocalRuntime 恢复；更新 Conversation/API/Agent Runtime 当前事实与 manifest 路由 | `git diff --check` 通过；文档检查器因要求 `reviews/Lxxx.md` 与技能要求 `reviews/design-review.md` 冲突而报错；其余 warning 属既有 Agent Streaming L007；未运行构建、测试或 Electron 手工验证 | `pending review` | 如需独立代码评审或运行验证，再新增对应 loop；当前实现已完成 | 列表与选中历史未分页；当前 query 运行时行为需在桌面环境确认 | `f4e5148` | n/a |
| L002 | 修复启动空白页和 `useAssistantState` 缺少导出的异常 | 改用 `@assistant-ui/react@0.15.32` 的公开 hook `useAuiState`；按用户反馈升版 design/verification 文档 | 针对 Vite 优化模块导出与页面导入的检查从缺失导出转为通过；`git diff --check` 通过；未运行构建或 Electron 重启确认 | `pending review` | 如需进一步确认，重启桌面应用验证渲染与会话列表加载 | 当前验证覆盖 ESM 导出匹配，未覆盖 Electron 启动路径 | not committed | n/a |
