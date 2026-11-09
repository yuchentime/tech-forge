---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-09
---

# 演练模式任务

> 状态：`implemented`（2026-11-09）。下列清单保留为后续回归与扩展索引；实际命令和结果见 [verification.md](verification.md)。

## Phase 1：Schema 与 Entity

- [ ] 新增 migration `1793990000000-rehearsal-mode.ts`：
  - `rehearsals` 增加 `personaText`、`contextUpToSequenceNo`、`planJson`、`askedQuestionCount`、`baseQuestionCount`、`skippedCount`、`overallEvaluationJson`、`endReason`。
  - `rehearsal_turns` 增加 `kind`、`baseSequenceNo`、`followUpDepth`、`pointId`。
  - 回填已有行的计数；旧行默认 0。
  - 创建 `UQ_rehearsals_conversation_active` 部分唯一索引。
- [ ] 同步 `RehearsalEntity` / `RehearsalTurnEntity` 字段与索引。
- [ ] 确认删除顺序仍为 `rehearsal_turns` → `rehearsals` → ...，不新增绕过路径。
- [ ] 迁移在空库与已有库上各跑一次；确认 `PRAGMA foreign_keys=ON` 下无 FK 错误。

## Phase 2：`LlmService.generate()`

- [ ] 增加 `LlmGenerateOptions`：`systemPromptAppend`、`tools`、`loadMemory`、`persistSnapshot`、`timeoutMs`。
- [ ] 重构 `createSession()`，让 `stream()` 与 `generate()` 共享 Provider、cwd、文件边界、资源加载；`stream()` 默认行为不变。
- [ ] `generate()` 不注册 `persistConversationEvent`、不写 `pi_session_snapshots`。
- [ ] `conversation` 只用于读取历史与 cwd；`persistSnapshot: false` 时仍可走 `restoreEntries()` 读父快照。
- [ ] 超时/取消：`AbortController` → `session.abort()`；成功/失败都 `dispose()`。
- [ ] 空文本抛错；错误类型与 `stream()` 一致。
- [ ] 日志只记录长度、history 数、耗时、状态与安全错误字段。
- [ ] 回归 `npm run test:agent-stream --workspace @teachforge/backend`。

## Phase 3：RehearsalsService 与 API

- [ ] 在 `ConversationsService` 增加只读 `getRestorableHistory(conversationId, upToSequenceNo?)`，复用 `beginTurn()` 的角色/状态过滤与 `toHistoryMessage()` 投影，不写消息、不创建 turn。
- [ ] 实现 `RehearsalsController`、DTO、模块装配；`RehearsalsModule` 导入 `LlmModule`、`ConversationsModule`、`SettingsModule`（按实际依赖最小化）。
- [ ] 实现开始流程：校验普通历史、生成计划 + 首题、写 rehearsal/turn、处理 `startRequestId` 幂等。
- [ ] 实现回答流程：校验 turn、保存答案、调用决策、校验 JSON、强制限额、写评估与下一题。
- [ ] 实现跳过流程：不评估、生成新基础题、处理第 15 问与重复跳过。
- [ ] 实现结束流程：abort 进行中调用、汇总逐题、生成总评、写 transcript、`endReason`。
- [ ] 实现报告失败与重试；保留逐题数据。
- [ ] 实现 `RehearsalRunRegistry`：每 Rehearsal 锁、run token、abort、并发 409。
- [ ] 实现 `recoverInterrupted()`：`preparing`、`evaluating`、`preparing_next`、报告失败。
- [ ] 实现 `GET /api/conversations/:id/rehearsals` 历史列表：摘要字段、`limit`/`cursor`/`status`、`createdAt DESC, id DESC`、`nextCursor`；不返回 turns/plan/完整报告。
- [ ] 列表/详情读取时对“过期且无活跃 run”的行执行 reconciliation，避免 `evaluating` 长期挂在「进行中」，同时不干扰正在执行的请求。
- [ ] 实现 `buildConversationDigest()`：最近 3 次、6000 字符封顶、transcript 重建。
- [ ] 实现 transcript 文件写入与路径解析。
- [ ] 计数从 turns 派生并在事务内更新；模型返回值不作为计数来源。
- [ ] 日志事件：start/plan/answer/skip/end/report/digest/recovery，不含正文。

## Phase 4：普通对话接入

- [ ] `ChatService.stream()` 在 `beginTurn()` 后调用 digest，拼进 `promptContext`。
- [ ] 新增 `mergeUserMessageContextRefs()`，把 `attachments` / `knowledge` / `rehearsals` 合并写入；更新现有调用点，避免互相覆盖。
- [ ] 确认 `replaceInjectedUserText()` 会把 digest 从快照剥离；加回归断言。
- [ ] 普通对话历史接口不返回 digest；`messages` 不新增演练行。
- [ ] 普通对话「演练评估」卡片的数据接口与刷新逻辑。

## Phase 5：桌面端

- [ ] 新增 `apps/desktop/src/features/rehearsal/`：store、开始页、答题页、报告页、普通对话卡片。
- [ ] `AgentChatPage` 接入演练视图；保留普通对话挂载，用 `inert` 隐藏。
- [ ] 模式状态按 conversation 处理：切换会话重置为普通对话；有进行中演练时显示标记。
- [ ] 开始页：画像输入、空会话禁用、loading/error/retry、`startRequestId` 复用。
- [ ] 答题页：进度、历史问答、当前题、提交/跳过/结束、`Ctrl+Enter`、焦点管理、提交中禁用。
- [ ] 报告页：总体 + 逐题表 + 继续/返回/调整画像；报告失败重试；支持 `mode='history'` 只读展示。
- [ ] 历史演练：页头入口 + 数量角标；列表进行中置顶、已完成/失败分组；`nextCursor` 加载更早；空态/错误重试。
- [ ] 历史详情：按需读取单次，展示完整问答、逐题评估、总评、画像、计划；返回历史。
- [ ] 浏览历史不卸载当前 session；返回后题面、输入、提交中状态保留。
- [ ] 恢复：进入演练模式时加载 latest；进行中显示当前题；已完成显示报告。
- [ ] 普通对话卡片：最近一次报告摘要、查看完整报告、查看历史演练、按会话加载。
- [ ] 无障碍：`aria-pressed`、`aria-live`、`role="alert"`、评估等级文字。
- [ ] 桌面测试：开始/回答/跳过/结束/继续/错误/恢复。

## Phase 6：验证与文档

- [ ] 后端测试 `rehearsal.test.cjs`：B1–B26，含历史列表/分页/范围/状态筛选。
- [ ] 后端测试 `rehearsal-digest.test.cjs`：digest 注入、contextRefs、快照清洗。
- [ ] 桌面测试 `rehearsal-mode.test.cjs`：U1–U18，含历史入口/列表/详情/分页/不打断当前演练。
- [ ] 真实 Provider smoke：普通对话 → 演练 → 追问/跳过 → 报告 → 普通对话复习 → 开始新的演练。
- [ ] 检查 SQLite：父快照未变、`messages` 无演练行、rehearsals/turns 完整、删除级联正常。
- [ ] 更新 `docs/current/platform/agent-runtime.md`、`architecture-and-code-placement.md`、conversation 相关页面。
- [ ] 新增或更新 decision 记录：互斥模式、digest 同步、模型不提前结束。
- [ ] 更新 `docs/changes/README.md` 与 `docs/manifest.yaml`。
- [ ] 在 [verification.md](verification.md) 记录实际命令与结果。
