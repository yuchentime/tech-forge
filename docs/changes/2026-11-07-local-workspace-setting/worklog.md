# Worklog: local-workspace-setting

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 增加本机工作空间路径设置并保持与 LLM 读取隔离 | 新增 config.toml `[workspace].path`、旧配置默认回退、SettingsService getter 和设置页编辑/恢复默认；同步系统设置事实与路由 | Backend、Renderer、Electron `tsc --noEmit` 均通过；`git diff --check` 通过，存在仓库 LF/CRLF 提示；变更文档相对链接均可解析；未新增或运行测试。`check_doc_runtime.py docs` 仍因 8 个评审文件命名错误和 2 条既有 warning 返回失败；其中本变更的 `reviews/design-review.md` 文件名由技能模板规定，检查器要求 Lxxx 命名；本路由预算 warning 已消除 | `pending review` | 桌面运行后人工确认保存、重开和恢复默认 | 未在当前 Electron 窗口验证交互；工作空间不影响 `getLlmSettings()`、LlmService 或当前 Agent 工作目录 | `not committed` | `n/a` |
| L002 | 实施默认 workspace 与 Agent 文件读写权限边界 | v2 将默认输出根改为 `.tech-forge/workspace/`，兼容旧默认值；Pi loader/session/tool 共用 workspace cwd；read 支持任意普通文件但保护设置文件及替换临时文件，写入默认限制在 workspace，仅当前 prompt 的明确外部绝对目标获得本轮许可；同步设置 UI、当前事实、manifest 和旧测试断言 | Backend、Renderer、Electron `tsc --noEmit` 均通过；`git diff --check` 通过，仅有仓库 CRLF 提示；未新增或运行测试。文档检查仍因 8 个 review 文件命名错误与 3 条既有 warning 返回失败；当前 workspace 路由无新增预算 warning | `pending review` | none | 尚未新增上传流程或 UI/API；外部授权要求单一清楚的绝对路径，含空格路径需加引号并失败关闭 | `not committed` | `n/a` |
