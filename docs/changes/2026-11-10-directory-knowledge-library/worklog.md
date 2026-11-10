# Worklog: directory-knowledge-library

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 完成实施前门禁与目录布局决策 | Design Review 记录为通过；接受混放受管根、index 白名单路由与 LlmService 持有 Pi session entry 的设计收敛；AC Review 已基于当前代码/API 完成。 | Pi SDK declarations、现有服务/工具/命令调用点已核验；尚未运行业务测试。 | `pending review` | 实现 catalog 数据与 Documents 域导入路径。 | 既有资料的显式 rebuild 需保持不触发启动期 Provider 调用。 | `not committed` | `n/a` |
| L002 | 建立目录数据基础与停止新索引写入 | 新 migration/实体增加 catalog 状态字段；新增受预算摘要校验与原子 index 投影；Documents 导入改为 `parsing → cataloging → ready/failed`，不再调用 chunk/vector 写入。 | `npm run build --workspace @teachforge/backend` 通过；`git diff --check` 通过。既有 ingest 测试仍断言旧检索行为，尚待按新 AC 改写。 | `pending review` | 接入 retry/rebuild、目录白名单工具策略与 Chat 命令。 | Provider 摘要调用和混放根的路径投影需在 L1/L2 验证。 | `not committed` | `n/a` |
| L003 | 明确目录权威来源与单副本布局 | 开发者确认 SQLite 为 catalog 权威、index 仅为原子重建投影；删除不解析 index。开始移除导入成功后保留在知识根 UUID 目录的重复副本。 | 文档契约已更新；实现验证待本轮完成。 | `pending review` | 完成单副本导入/删除及 index 重建验证。 | 需验证旧重复目录的受控清理策略，不可静默删除用户文件。 | `not committed` | `n/a` |
