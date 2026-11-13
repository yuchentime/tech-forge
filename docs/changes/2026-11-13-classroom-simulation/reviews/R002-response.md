---
status: current
layer: change
review_type: implementation_review_response
created_at: 2026-11-13
responds_to: reviews/R002.md
verdict: fixed
---

# R002 处理记录

复评结论：`CHANGES_REQUESTED`（B003 阻断，W012–W022 / N004–N008）。
处理结果：全部关闭；R001 的 W007 恢复入口现在能真正切换到新课堂。

| ID | 状态 | 处理 | 证据 |
|---|---|---|---|
| B003 | ✅ fixed | `POST /api/lessons` 改为“先结束旧 active，再创建新行”，始终 `201` 与新 id；首页与舞台的「开始新课堂」都真正生效；旧课堂进入历史 | `lessons.service.ts startNewLesson()`；HTTP 测试“starting a new classroom closes the previous active one” |
| W012 | ✅ fixed | 环境 → 会话 → 导演 → 学生合并为一段 `try/catch`；删除 `withTurnError` 与 `session!` | `ClassroomSimulationAgent.ts` |
| W013 | ✅ fixed | `requestSeq` 让在途读取在 lesson 切换/卸载后丢弃结果，不再覆盖新课堂 | `ClassroomMode.tsx reloadMessages()` |
| W014 | ✅ fixed | transcript 与队列抽到 `LessonTranscriptStore`；新增有鉴别力的队列测试（无队列会得到 a-start, b-start, a-end） | `lesson-transcript.test.cjs` 3/3 |
| W015 | ✅ fixed | `LessonsService` 只保留行与总结；文件 I/O、解析、队列归 `lesson-transcript.store.ts`，与 `transcript-format.ts` 形成 store/render 对称 | 文件拆分 |
| W016 | ✅ fixed | 提示词、构建器、JSON 解析移到 `llm/classroom-simulation.prompt.ts`；Agent 只留编排 | `classroom-simulation.prompt.ts` |
| W017 | ✅ fixed | `ClassroomTurnError` 与 `isLessonError` 移到 `llm/turn-errors.ts`，控制器只从这一处导入 | `turn-errors.ts` |
| W018 | ✅ fixed | 拆出 `ClassroomRecoveryBanner`、`ClassroomMessageDrawer`、`classroom-drafts.ts`；首页结束课堂也清理草稿 | 三个新文件；Home 的 `clearClassroomDraft` |
| W019 | ✅ fixed | 轮询依赖收敛为 `detailLessonId` + `detailSummaryStatus`；删除永不更新的列表快照判断 | `ClassroomHome.tsx` |
| W020 | ✅ fixed | 共享 `src/api/json.ts` 的 `isRecord`，删除 `knowledge-profile-api.ts` 与 `chat-stream-event.ts` 的私有副本 | 三处统一 |
| W021 | ✅ fixed | `BUBBLE_LEFT` 改为 `Record<Exclude<LessonSpeaker,'teacher'>, string>`，删除无用 `teacher` | `ClassroomMode.tsx` |
| W022 | ✅ fixed | 迁移用例手工构造旧 schema 与两条 active，验证只保留最新、其余 `ended` 且 `endedAt` 非空、唯一索引拒绝第二条 active | `lesson-migration.test.cjs` 1/1 |
| N004 | ✅ fixed | `run()` 与选项注释改为“结束当前 active 并新建” | Agent 注释 |
| N005 | ✅ fixed | 诊断文案统一使用 `truncateChars()`，按码点截断 | `transcript-format.ts`、prompt 模块 |
| N006 | ✅ fixed | 新增 `OK_INTEGRITY` / `toIntegrity()`，控制器两处响应共用 | `lesson-message-view.ts` |
| N007 | ✅ fixed | `busy` 并入 `isStartingNew`，新建在途时输入框不可发送 | `ClassroomMode.tsx` |
| N008 | ✅ fixed | 脚本拆分为 `test:classroom-{turns,runtime,transcript,migration}`，新增聚合 `test:classroom` 一次跑全部课堂套件 | `apps/backend/package.json` |

## 重新验证

| 套件 | 结果 |
|---|---|
| `npm run test:classroom`（聚合） | 27/27 |
| `test:classroom-lessons` / `turns` / `runtime` / `transcript` / `summaries` / `migration` | 12 / 3 / 3 / 3 / 5 / 1 |
| `npm run test:rehearsal` | 20/20 |
| `test/backend-request.test.cjs`（desktop） | 6/6 |
| `tsc --noEmit`（backend / desktop）、`build:renderer` | 通过 |

## 文档

- `design.md`、`api-contract.md`、`verification.md`、`current/platform/classroom-mode.md` 的「开始新课堂」统一为“结束旧 active 后新建”。
- `brief.md` 删除了已过时的“前端尚未接线”。

## 仍保留的边界

- Electron 实机与窗口比例锁未重测。
- 真实 provider 只有手工 e2e。
- 无 `clientMessageId`；桥接仅 GET 重试。
- `GET /api/lessons/:id` 详情端点与 SSE 未实现。
