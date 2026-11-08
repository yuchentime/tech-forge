# Worklog: conversation-tool-activity-history

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 固化切回会话后工具活动消失的回归表现 | 增加 SQLite 历史查询用例和历史活动总线用例；通过设计评审并批准 AC | 修复前 backend 2 个用例均因缺少 `toolActivities` 失败；desktop 5 个用例中历史恢复用例因方法不存在失败，其余 4 个通过 | `pending review` | 用安全 DTO 修复查询和 renderer 恢复 | 不把工具参数或结果加入历史响应 | not committed | n/a |
| L002 | 恢复分页历史中的工具活动并保持原有文本消息语义 | 查询 turn 区间内的 `toolExecution` 并嵌套安全摘要；仅持久化可选 `displayPath`；按持久用户消息 ID 恢复桌面活动状态 | Desktop 目标命令 5/5 通过；Backend 隔离编译及 SQLite 历史测试 3/3 通过；将 backend 测试构建改为 `.test-dist` 以避开运行中应用锁住的 `dist` | `pending review` | 同步当前文档并运行文档结构检查 | 本轮未启动实际模型调用或修改用户对话数据 | not committed | n/a |
| L003 | 同步 API、运行行为、路由和变更记录文档 | 更新 Conversation、Agent Runtime 当前事实、API 契约、架构说明、manifest 和变更索引 | `git diff --check` 通过；文档检查器 9 错误/3 警告，其中 8 个既有 review 文件命名错误和 3 项既有警告；另将本变更的 `reviews/design-review.md` 判为 Lxxx 命名错误，源于项目约定与检查器规则不同 | `pending review` | none | 文档检查器的命名约定冲突已记录；历史路由 token-budget 警告仍在 | not committed | n/a |
