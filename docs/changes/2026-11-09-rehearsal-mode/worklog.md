---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-09
---

# 演练模式实施记录

## 实施范围

在 `feat/rehearsal-mode` 分支实现：

- Backend：migration、Rehearsal 实体字段、`LlmService.generate()`、`ConversationsService.getRestorableHistory()` / `mergeUserMessageContextRefs()`、Rehearsals 状态机/Controller/DTO、普通对话 digest 注入、快照清洗、测试。
- Desktop：演练 API/store、开始页、答题/逐题评估、报告、历史列表/只读详情、普通对话卡片，以及 `AgentChatPage` 接入；开始按钮只在普通对话存在 completed user + assistant round 后启用，提示文案位于按钮下方。
- Docs：current 演练领域页、Agent Runtime / 架构 / Conversation 页面、manifest 与 change 记录。

## 关键实现点

- `RehearsalsService` 以 `rehearsals` / `rehearsal_turns` 为唯一状态源；不写 `messages`。
- 开场 `LlmService.generate()` 传入父 `conversation`，复用父 Pi 快照但不保存；后续调用使用无 history、无工具、无 `pi-memory` 的临时 session。
- 15 次总提问、单题 2 次追问、跳过消耗名额；模型 `complete` 被当作 `next_question`，结束只由用户或上限触发。
- 报告完成写 transcript；普通对话每轮注入最近 3 次 completed 摘要，`contextRefsJson.rehearsals` 通过合并写入。
- 历史列表只返回摘要并分页；详情复用单次读取；进行中记录置顶，浏览历史不卸载 session。
- 每个 Rehearsal 使用进程内 run registry 串行化；`end` abort 进行中的 `generate()` 并等待退出；迟到结果通过状态/run token 丢弃。
- 零回答结束先由 UI 确认，再调用 `DELETE /api/rehearsals/:id` 丢弃；有回答时丢弃返回 409。
- 回答问题在提交时落库；重启后 `latest` 恢复题面/历史回答，未完成评估显示已保存回答并允许用同一回答 + 新请求键重试；无活跃 run 的 `evaluating`/`preparing_next` 立即 reconciliation。
- migration 使用部分唯一索引保证同一 conversation 最多一个活跃 Rehearsal。

## 与设计的偏差与修正

1. **start 响应**：实现直接返回完整 `RehearsalDetail`，而不是单独的 start 子集；UI 使用 `currentQuestion`/`plan`/`progress`。设计已改为一致。
2. **`persistSnapshot` 选项**：实现没有单独的布尔参数，`generate()` 本身就不注册持久化钩子、不 upsert 快照；行为与设计目标一致，选项已从设计代码片段移除。
3. **状态码**：DTO 校验失败（画像超长、空回答）由全局 `ValidationPipe` 返回 400；模型输出非法返回 422。设计/API 文档已同步。
4. **快照清洗缺陷**：真实 smoke 发现 Pi 把 prompt 存成 text-block 数组，旧 `replaceInjectedUserText` 只处理字符串，导致 digest 留在父快照。已修复：
   - 处理 string 与 text-block 两种 content；
   - 按历史 user 行 id 还原纯文本；
   - Pi 内部 id 无法匹配时，用代码写死的注入标题 + `## 用户输入` 分隔符兜底；
   - 保存前清理当前与历史注入块。
   修复后用同一 conversation 再跑普通对话，快照中不再包含“此前的演练记录”。
5. **workspace 测试**：macOS `os.tmpdir()` 的 `/var` 与 `/private/var` realpath 不一致导致既有测试失败；测试 helper 改为 `fs.realpath`，不改变产品代码。
6. **客户端断开**：JSON bridge 没有通用 abort 通道，演练调用依赖 90 秒超时与 `end` 的服务端 abort；设计中“客户端断开 AbortSignal”按“无法可靠获取时依赖超时”处理。

## 验证记录

自动化命令均从仓库根执行：

| 命令 | 结果 |
|---|---|
| `npm run build --workspace @teachforge/backend` | PASS |
| `npm run test:rehearsal --workspace @teachforge/backend` | PASS 10/10 |
| `npm run test:session-entries --workspace @teachforge/backend` | PASS 4/4 |
| `npm run test:agent-stream --workspace @teachforge/backend` | PASS 8/8 |
| `npm run test:chat-attachments --workspace @teachforge/backend` | PASS 5/5 |
| `npm run test:conversation-history --workspace @teachforge/backend` | PASS 5/5 |
| `npm run test:conversation-delete --workspace @teachforge/backend` | PASS 2/2 |
| `npm run test:knowledge-context --workspace @teachforge/backend` | PASS 11/11 |
| `npm run build --workspace @teachforge/desktop` | PASS |
| `npm run test:rehearsal --workspace @teachforge/desktop` | PASS 6/6 |

真实 Provider smoke（DeepSeek，临时 SQLite + 真实 config）：

- 开始：生成 7 个知识点和首题；status `awaiting_answer`，progress `1/15`。
- 回答：返回 `partial` + 跟进追问；progress `2/15`，追问深度 1。
- 手动结束：生成总体报告；turns 包含已评估题与未作答题。
- 历史列表：`counts.completed=1`，摘要不含 turns；latest 返回报告。
- 普通对话：模型回答引用演练中的薄弱点；`contextRefsJson.rehearsals` 写入；快照清洗后不含 digest 标题。
- 临时数据与会话目录在验证后删除。

未进行 Electron 点击级自动化：桌面 UI 已通过 `tsc`/Vite 构建和 store 测试；真实 Provider smoke 走本地 HTTP API。

## 后续

- 用真实长对话验收开场复用父快照时的角色切换。
- 观察 digest 每轮注入的 token 成本；必要时只注入最近一次 + 指针。
- 视产品需要补 SSE 进度、报告导出、计划编辑、跨会话历史。
