# Worklog: chat-api-rename

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 将后端流式模块与桌面桥接统一命名为 chat | 后端目录、类、DTO 和 SSE helper 改为 Chat；HTTP 路由改为 `/api/chat/stream`；Electron bridge、IPC、事件类型和当前事实文档同步更新 | 静态核对 AppModule、Controller、Electron endpoint/IPC 和事件类型引用一致；`git diff --check` 无空白错误（Git 提示部分文件 LF/CRLF 转换）；文档检查报告 8 个既有 reviews 文件命名错误和 3 个既有警告；未运行 build 或 tests | `pending review` | none | 使用旧 `/api/agent/stream` 的外部调用方需迁移；桌面内调用已同步 | `not committed` | `n/a` |
