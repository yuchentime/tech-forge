# Worklog: conversation-history-sidebar

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 提供 Conversation 查询 API 并在 Agent 左侧栏加载和切换历史 | 增加 Conversation 摘要/消息 GET API、侧栏和选中会话 LocalRuntime 恢复；更新 Conversation/API/Agent Runtime 当前事实与 manifest 路由 | 代码与文档自查完成；`git diff --check` 通过；未运行构建、测试或 Electron 手工验证 | `pending review` | 如需独立代码评审或运行验证，再新增对应 loop；当前实现已完成 | 列表与选中历史未分页；当前 query 运行时行为需在桌面环境确认 | not committed | n/a |
