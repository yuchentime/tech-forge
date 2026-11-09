# Worklog: 多会话并行（后台生成）

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 完成实施前门禁与 SDK 核验 | 复核 `@assistant-ui/react` 0.15.33 的多线程运行时源码；补代码级 AC 和门禁记录 | `npm ci --ignore-scripts` 因 lockfile 缺 `webpack@5.112.2` 失败；不改 lockfile 的临时安装成功，源码确认 `backgroundThreads` 生命周期 | `pending review` | 实现共享运行注册表与创建/删除 API | lockfile 与 package.json 不同步，最终依赖可复现性待修复 | not committed | n/a |
| L002 | 落地并发运行的后端和桌面线程基础 | 新增共享 `ConversationRunRegistry`、创建 API、远程线程适配器、每线程 LocalRuntime、键控草稿/活动/产物标签与行级侧栏状态 | desktop renderer/electron build、`test:agent-stream` 9/9 通过；`test:conversation-history` 1 个既有断言差异；backend 编译受既有 TS2742 阻塞 | `pending review` | 补并发集成测试与人工双流验收 | 当前 lockfile 不同步；真实 Provider/Electron 双流尚未执行 | not committed | n/a |
| L003 | 桌面启动与首次草稿创建调试 | 修复附件 store 空快照导致的 React 无限更新；移除空草稿 `reset()`，避免 assistant-ui 初始化事件在未发送前调用 `POST /api/conversations` | 桌面端输入、发送、运行中切换会话与切回可用；DevTools 热更新后 0 条错误；重载前后 SQLite 会话数均为 2；`build:renderer`、`build:electron`、桌面 `test:agent-stream` 9/9、`git diff --check` 通过 | `pending review` | 执行真实 Provider 的双会话并发流与后端竞争用例 | 本轮只观察到单次本地流状态；未验证真实 Provider 双流结果 | not committed | L002 |
| L004 | 修复新草稿错误显示后台会话的“正在思考” | 将 `AgentEventBus` 的活动 request 关联到 stable `localThreadId`；页面只读取当前线程的 live activity | 新增跨线程活动过滤回归测试：先失败（缺少按线程快照 API），修复后桌面 `test:agent-stream` 10/10、`build:renderer`、`git diff --check` 通过；热更新后新草稿显示空状态 | `pending review` | 用真实长 Provider 流复验 A 运行时 B 不显示进度 | 当前手工 Provider 响应过快，未截获长流期间的视觉状态 | not committed | L003 |
| L005 | 最终验收与提交准备 | 用户完成桌面端验收，确认并行会话及新草稿进度隔离符合预期 | 用户确认“验收通过”；已保留自动化与人工调试证据 | `passed` | 创建提交 | 真实长 Provider 流截图未单独留存，但用户验收通过 | pending | L004 |
