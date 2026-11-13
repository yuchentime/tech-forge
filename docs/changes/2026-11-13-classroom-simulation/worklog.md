---
status: current
layer: change
domain: classroom-simulation
canonical_for:
  - classroom-simulation-worklog
created_at: 2026-11-13
related:
  - docs/changes/2026-11-13-classroom-simulation/brief.md
  - docs/changes/2026-11-13-classroom-simulation/design.md
  - docs/changes/2026-11-13-classroom-simulation/api-contract.md
  - docs/changes/2026-11-13-classroom-simulation/verification.md
  - docs/current/platform/classroom-mode.md
---

# 课堂模拟 Agent 轮次 — 实施记录

- 日期：2026-11-13
- 状态：后端、课堂首页与舞台接线已实现；待代码评审
- 评审入口：本文「评审重点」+ `design.md` + `api-contract.md`
- 说明：本文记录意图演进、实施顺序与已知风险；稳定事实已同步到 `current/`。

## 1. 任务目标

### 1.1 初始诉求

1. 新建 `ClassroomSimulationAgent`，参考 `LlmService.generate()` 的 Pi SDK 调用方式，但更“干净”。
2. 计划注册两个工具：`random_dispatcher`（从 `su/lin/gu` 随机选人）与 `dispatch_to_student`（spawn 学生 subagent）；`dispatch_to_student` 只做基本实现。
3. 新建 `StudentAgent`，供课堂 Agent 调用，暴露 `createAgent(systemPrompt)`。

### 1.2 需求演进（用户追加约束）

| 约束 | 影响 |
|---|---|
| 暂不引入 tools | 选人改为导演会话输出 JSON；工具留待后续 |
| 消息不都进 SQLite，写本地 | 消息改为 `<configDir>/lessons/<id>/messages.jsonl`，SQLite 只存生命周期 |
| 去掉成员变量 `messages` | Agent 与服务均无消息状态，每轮从 JSONL 读 |
| 两个 Agent 都不用思考模式 | `thinkingLevel: 'off'`，选项不再暴露该开关 |
| 记录损坏要有恢复机制，可开始新课堂 | 读接口降级 + 追加拒绝 + 新建/结束端点 |
| 只做 P2 模型总结 | 不做规则统计；总结存 SQLite；历史首页展示 |
| 侧栏「课堂模式」改为课堂首页 | 进行中课堂 + 历史总结 + 空态 CTA；舞台独立 |

## 2. 背景与约束

- 单人本地应用：没有账号、租户与云同步；消息只需按时间回放，不参与检索。
- 仓库规则：LLM 层不拥有业务规则；SQLite 写事务不包模型或文件 I/O；文件工具不得读写应用托管数据。
- 课堂会话必须无状态、可重启：`SessionManager.inMemory` 重启即丢，因此上下文每轮从 JSONL 重建。
- 课堂消息是“本地运行数据”，用户明确不希望进 SQLite；总结是小文本且历史页要查询，因此进 SQLite。

## 3. 方案设计（摘要，详见 design.md）

### 3.1 关键取舍

| 议题 | 选择 | 放弃的方案与原因 |
|---|---|---|
| 消息存储 | 每课堂 JSONL | SQLite 消息表：回放型数据，事务与查询成本无收益 |
| 上下文 | 每轮重建最近 12 条 / 4000 字符 | 长驻 Pi session：重启即丢，需要回收与泄漏管理 |
| 选人 | 导演会话输出 `{"student":"su"}` | 自然语言解析（不稳定）；静默随机兜底（掩盖故障） |
| 工具 | 暂缓 | 当前决策一步完成，工具循环徒增成本 |
| 总结存储 | SQLite `lessons` 四列 | `.md` 文件：历史页逐文件读、状态需另找来源；JSONL：污染 speaker 契约 |
| 总结触发 | 结束后的独立 `POST /summary` | 结束内自动生成：结束被长请求拖住，重试易重复计费 |
| 总结内容 | 四节 Markdown，不评分 | 掌握度/评分：没有评估证据，违反 F2 真实可追溯原则 |

### 3.2 数据与流程

- `lessons(id, status, endedAt, summaryStatus, summaryMarkdown, summaryError, summaryGeneratedAt, createdAt, updatedAt)`。
- 消息行：`{id, speaker, text, createdAt}`，`speaker ∈ teacher|su|lin|gu`。
- 一轮：追加老师消息 → 导演（无工具、无思考）→ 学生 Agent（无工具、无思考）→ 追加学生消息。
- 损坏：`readTranscript()` 跳过坏行并返回行号；`readMessages()` 与 `appendMessage()` 拒绝；恢复手段是新建课堂。

## 4. 实施过程

| 阶段 | 内容 | 结果/验证 |
|---|---|---|
| P0 需求分析与规划 | 先审伪代码，列出 17 个可疑点（单例消息、无 lessonId、上下文矛盾、JSON 契约、标签注入、并发等） | 用户确认方向后实施 |
| P1 干净 Agent 底座 | 新建 `pi-agent-runtime`（环境解析、干净 session、单轮运行、文本判定）；两个 Agent 关闭思考 | 真实 DeepSeek 单轮通过 |
| P2 lessons 域 | `LessonEntity` + migration、`LessonsService`（JSONL 追加/读取、每课堂 Promise 链）、`SettingsService` lessons 路径与受管路径 | 两轮同一课堂、重启读回、结束拒绝 |
| P3 设计文档 | brief/design/tasks/verification + manifest 路由 + current 事实 | 文档链接与 manifest 校验通过 |
| P4 消息查询 API | `GET /api/lessons/:id/messages`，服务端补 `role/name` | 4 条 HTTP 测试 |
| P5 损坏恢复 | `readTranscript()` 容错；`readMessages()`/`appendMessage()` 严格；`POST /api/lessons`、`POST /:id/end`（幂等） | 测试覆盖降级、追加拒绝、建/结束 |
| P6 P2 总结 | summary migration、`ClassroomSummariesService`（`LlmService.generate()`）、列表 `summaryPreview`、总结 GET/POST、启动重置 `generating` | 服务级 5 条 + HTTP 覆盖；真实模型生成成功 |
| P7 发言端点与锁 | `POST /:id/turns`、`ClassroomTurnsService` 每课堂锁、错误映射 409/502 | 3 条锁测试 + HTTP 状态测试 + 真实模型 e2e |
| P8 前端 | `classroom-api.ts`、`ClassroomHome`、`ClassroomMode` 重写、`AgentChatPage` 路由；删除本地 `classroom-session-store` | renderer 构建通过；Chrome + 桥接 mock 截图核对 |

### 4.1 过程中的返工与修正

- 第一版 `readMessages()` 遇到坏行直接抛错，导致 UI 无法渲染；按“恢复机制”要求改为：读接口降级返回 `integrity`，写入仍拒绝，避免把新消息埋进坏文件。
- 总结预览最初保留 Markdown 符号（`## 本节讲了什么`），首页显示难看；改为在 `summarizePreview()` 去掉标题/列表/强调符号。
- 舞台发送失败后原实现只提示重试，可能重复写入老师消息；改为失败后先重新拉取记录，再展示错误。
- 发言端点最初原样抛出 provider 错误（500 + 内部文案）；改为日志保留真实错误、HTTP 返回稳定文案（502/409）。
- 首页与舞台切换会丢草稿；用模块级 `drafts` 按 lessonId 暂存，仅本次应用会话有效。

## 5. 代码地图

| 层 | 文件 |
|---|---|
| 数据 | `database/migrations/1794030000000-classroom-lessons.ts`、`1794040000000-classroom-summaries.ts`、`lessons/lesson.entity.ts`、`lessons.service.ts` |
| 展示映射 | `lessons/lesson-view.ts`、`lessons/lesson-message-view.ts`、`lessons/transcript-format.ts` |
| Agent | `llm/ClassroomSimulationAgent.ts`、`llm/StudentAgent.ts`、`llm/pi-agent-runtime.ts`、`llm/model-json.ts` |
| HTTP | `classroom/classroom.controller.ts`、`classroom-summaries.service.ts`、`classroom-turns.service.ts`、`classroom-summary.prompt.ts`、`classroom.dto.ts`、`classroom.module.ts` |
| 前端 | `features/classroom/classroom-api.ts`、`ClassroomHome.tsx`、`ClassroomMode.tsx`、`features/agent/AgentChatPage.tsx` |
| 测试 | `test/classroom-lessons.test.cjs`、`classroom-turns.test.cjs`、`classroom-summaries.test.cjs` |

## 6. 验证记录

| 命令 | 结果 |
|---|---|
| `npm run test:classroom --workspace @teachforge/backend` | 27/27（lessons 12、turns 3、runtime 3、transcript 3、summaries 5、migration 1） |
| `npm run test:classroom-turns` / `test:classroom-runtime` | 3/3、3/3（锁 / 超时与取消） |
| `npm run test:classroom-summaries` / `test:classroom-transcript` / `test:classroom-migration` | 5/5、3/3、1/1 |
| `node --test test/backend-request.test.cjs`（desktop） | 6/6（GET 重试、POST 不重放） |
| `npm run test:rehearsal --workspace @teachforge/backend` | 20/20（`parseJsonObject` 迁移回归） |
| `npx tsc -p tsconfig.build.json --noEmit`（backend） | 通过 |
| `npx tsc --noEmit -p tsconfig.app.json` + `npm run build:renderer`（desktop） | 通过 |
| 真实模型 e2e（临时配置目录） | 建课堂 → 两轮 `[teacher,lin]`、`[teacher,lin,teacher,su]` → 结束 → 总结 `ready` → 列表预览正常 |
| 界面核对（Chrome 1568×880 + 桌面桥 mock） | 首页显示进行中/历史/CTA；舞台发送后气泡落在对应座位（lin 左 / su 中 / gu 右）、计数 2、输入框切单行 |

截图未入库（临时文件已删除）。Electron 窗口比例锁与打包未在本轮重测。

## 7. 评审重点

1. **`LessonsService` 的读写语义**：`appendMessage()` 每次追加前完整读一遍记录（每轮两次读）。正确性优先，但请评估长课堂的 O(n) 成本与是否值得缓存/尾部校验。
2. **错误映射靠字符串匹配**：controller 用 `message.includes('transcript is corrupt')` / `'Lesson is not active'` 映射 409。建议改为 `LessonsService` 抛类型化错误（如 `LessonConflictError`）。
3. **总结同步请求**：`POST /summary` 最长 120 秒，前端在舞台结束后后台发起、首页轮询。请评估是否改成异步任务 + 状态机（当前已有 `generating` 状态与启动重置）。
4. **总结思考等级**：走 `LlmService.generate()` 默认（high thinking）。课堂 Agent 已关思考，总结是否也应显式 `thinkingLevel: 'off'|'low'`，请按成本/质量定。
5. **列表排序**：`listLessons()` 按 `createdAt DESC`，历史页实际想按结束时间排序；是否需要改成 `COALESCE(endedAt, createdAt)`。
6. **气泡定位**：`BUBBLE_LEFT` 写死 22%/50%/78%，换背景图必须同步改代码；是否抽成素材元数据。
7. **截断边界**：`formatTranscript()` 用 `slice` 截断，可能切断 emoji 代理对；影响仅限提示词展示。
8. **幂等**：没有 `clientMessageId`，客户端重试会重复老师消息；首版靠前端禁止自动重试。
9. **测试真实性**：总结成功路径用 fake LLM；真实 provider 只做过手工 e2e，未固化为自动测试。
10. **`dist` 被运行中的应用占用**：本轮后端编译产物走 `.test-dist`，评审环境请先重启或关闭运行的桌面应用再 `npm run build:backend`。

## 8. R001 评审修复

2026-11-13 收到实施评审 `reviews/R001.md`（CHANGES_REQUESTED），全部问题已关闭，逐条对应见 [R001-response.md](reviews/R001-response.md)。主要改动：

- **B001**：导演/学生默认 60s/120s 超时；控制器监听连接关闭并 abort；已取消信号不再启动 provider。
- **B002**：桌面桥只重试 `GET`，非幂等 POST 不再被静默重放。
- **W001**：`lessons` 部分唯一索引保证单 active；迁移关闭历史多余 active；`POST /api/lessons` 幂等返回既有课堂。
- **W003/W004**：lesson 领域类型化错误；I/O 错误保持 500，只有模型失败映射 502。
- **W005**：导演额外收到不受字符预算限制的“最近学生发言顺序”。
- **W006/W007**：失败后清空已落盘草稿；损坏/失败横幅提供「重试」「开始新课堂」。
- **W008**：`endLesson()` 进入同一 per-lesson 队列。
- **W010**：新增追加队列、HTTP 发言成功、桥接 POST 不重放、超时/取消用例。
- **W011**：控制器复用 `runTurn()` 结果，去掉一次整文件读取。
- **N001–N003**：Unicode 安全截断、注释更新、总结透传 `requestId`。

`verification.md`、`api-contract.md`、`design.md` 与 `changes/README.md` 的漂移同批修正。

## 9. R002 复评修复

R002（CHANGES_REQUESTED）在 R001 基础上指出：开始新课堂语义回归（B003）、队列测试无鉴别力（W014）、职责混杂（W012/W015/W016/W018）等。逐条对应见 [R002-response.md](reviews/R002-response.md)。

- **B003**：`POST /api/lessons` 恢复为“先结束旧 active，再新建”，始终 201 与新 id；前端与文档同步。
- **W012/W016/W017**：Agent 收敛为一段 `try/catch`；提示词与解析抽到 `classroom-simulation.prompt.ts`；`ClassroomTurnError` 移到 `llm/turn-errors.ts`。
- **W014/W015**：transcript 与队列抽到 `lesson-transcript.store.ts`，新增可鉴别队列测试与聚合脚本 `test:classroom`。
- **W018/W019/W021**：舞台拆出 `ClassroomRecoveryBanner`、`ClassroomMessageDrawer`、`classroom-drafts.ts`；轮询依赖收敛；气泡位置改为学生键联合类型。
- **W022**：迁移用例覆盖“旧库多条 active → 保留最新、其余 ended”。
- **W020/N004–N008**：共享 `isRecord`、注释、Unicode 截断、integrity 常量、busy 源、脚本拆分。
- 验收：API 9 组断言 + 界面 7 步流程全部通过，记录在 [acceptance.md](acceptance.md)。

## 10. 验收反馈调整

- 发送讲解后立即把它放到输入框上方、清空草稿并切换为单行回答框；老师消息以乐观行先进入列表，服务端返回后替换。
- 等待期间不再在输入框下方写「学生正在回应…」，改为三名学生头顶各一个小气泡「正在思考中…」（左侧旋转加载图标）；回复到达后替换为真实气泡。
- 界面集成复核：400ms 时 peek/单行输入框/3 个思考气泡均正确；9 秒后仅剩真实学生气泡。
- 座位修正：左→右为 `lin`/`su`/`gu`；思考气泡 left 依次 50/22/78，苏小满与林澈的真实气泡分别落在 50%/22%。
- 「结束课堂」改为仅当课堂记录加载成功且状态为 `active` 时渲染；加载中只显示「退出课堂」。
- 进一步改为草稿课堂：点「开始新课堂」只进入舞台，不创建行；首次发送才创建课堂（并结束旧 active），空草稿退出不留下 active/历史记录。
- 历史课堂支持删除：行尾垃圾桶 + 确认框；后端 `DELETE /api/lessons/:id` 只允许 ended，删除行、总结与 JSONL 目录，生成中返回 409。
- 知识点收束：SQLite 保存起点/标签/收束状态，轮次由 transcript 推导；同一知识点最多 2 次学生发言，第 3 次收束；导演 JSON 增加 `mode/pointLabel`，并新增 `test:classroom-point`。

## 11. 未完成与后续

- `GET /api/lessons/:id` 详情端点（与列表 + 消息组合重复，暂缓）。
- SSE 逐字输出学生回复。
- `random_dispatcher` / `dispatch_to_student` 工具。
- 课堂与 conversation 绑定、课堂报告与评估。
- Electron 内的最终实机回归（窗口比例锁、打包安装包）。
