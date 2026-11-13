---
status: current
layer: change
review_type: implementation_review_response
created_at: 2026-11-13
responds_to: reviews/R001.md
verdict: fixed
---

# R001 处理记录

评审结论：`CHANGES_REQUESTED`（B001、B002 阻断，W001–W011 / N001–N003 警告与备注）。
处理结果：全部关闭；新增/更新测试与文档见下表。

| ID | 状态 | 处理 | 证据 |
|---|---|---|---|
| B001 | ✅ fixed | `ClassroomSimulationAgent` 给导演 60 秒、学生 120 秒的默认上限（调用方可用 `timeoutMs` 覆盖）；控制器监听 `reply.raw` 的 `close` 事件，断开时 abort 当前轮次 | `classroom-runtime` 6/6：超时中止、取消中止、已取消不启动 provider；锁在失败后释放 |
| B002 | ✅ fixed | 桌面桥只对 `GET` 做一次网络重试；非幂等 POST 直接报「本地服务连接中断」，并修正了“所有端点幂等”的注释 | `test/backend-request.test.cjs` 6/6，新增「POST 不重放」 |
| W001 | ✅ fixed | 部分唯一索引 `UQ_lessons_active`；迁移先把多余 active 行关闭；`openActiveLesson()` 返回既有课堂（200）或新建（201） | HTTP：连续两次 POST → 201/200、同一 id、数据库仅 1 行 active |
| W002 | ✅ fixed | 首页轮询在列表刷新之外，额外重取打开详情的总结，直到 `generating` 结束 | `ClassroomHome.tsx` 的 `refreshDetailSummary` |
| W003 | ✅ fixed | 新增 `LessonNotFoundError`/`LessonEndedError`/`LessonCorruptError`；控制器按类型映射 404/409，模型错误统一 `ClassroomTurnError` → 502，I/O 错误保留 500 | `lesson.errors.ts`、控制器 catch 分支 |
| W004 | ✅ fixed | 总结只把 `LessonCorruptError` 当作“记录损坏”；其它读取错误写 failed 状态后向上抛，不再误导用户重建课堂 | `classroom-summaries.service.ts` |
| W005 | ✅ fixed | 导演提示词新增“最近学生发言顺序”（不受 4000 字符预算限制），选人不再只依赖被截断的记录 | `formatSpeakerSequence()` + `buildDirectorPrompt()` |
| W006 | ✅ fixed | 发送失败后若老师消息已落盘且与本次文本一致，清空对应草稿，避免同一句话以“回答”身份再次发送 | `ClassroomMode.tsx` 失败分支 |
| W007 | ✅ fixed | 损坏横幅与失败横幅都提供「重试」「开始新课堂」；新课堂通过 `createLesson()` 后切换舞台 lessonId | `ClassroomMode.tsx`、`AgentChatPage.tsx` 的 `onSwitchLesson` |
| W008 | ✅ fixed | `endLesson()` 进入同一 per-lesson 队列，状态变更与追加互斥；注释改为真实语义 | `lessons.service.ts` |
| W009 | ✅ fixed | 改写 `verification.md` 的计数/未覆盖表；删除 `api-contract.md` 三处“未实现”；`design.md` §7/§10 改为已实现；`changes/README.md` 标题更新 | 文档校验：链接、围栏、单页 ≤200 行 |
| W010 | ✅ fixed | 新增追加队列并发顺序、HTTP 发言成功路径（fake runner）、桥接 POST 不重放、超时/取消 6 条用例 | `classroom-lessons` 13/13、`classroom-turns` 6/6 |
| W011 | ✅ fixed | 控制器直接使用 `runTurn()` 结果，去掉多余的一次整文件读取；剩余成本（追加前校验、行查询、ModelRuntime）记录为已知取舍 | `classroom.controller.ts sendTurn()` |
| N001 | ✅ fixed | 提示词与预览截断改用 `Array.from()`，不再切断代理对 | `transcript-format.ts`、`lesson-view.ts` |
| N002 | ✅ fixed | 控制器与模块类注释改为当前职责 | `classroom.controller.ts`、`classroom.module.ts` |
| N003 | ✅ fixed | 控制器把 `requestId` 透传到总结的 `generate()`，`classroom.summary.*` 与 `llm.generate.*` 可用同一 id 关联 | `classroom-summaries.service.ts` |

## 重新验证

| 套件 | 结果 |
|---|---|
| `test:classroom-lessons` | 13/13 |
| `test:classroom-turns`（含运行时超时/取消） | 6/6 |
| `test:classroom-summaries` | 5/5 |
| `test:rehearsal` | 20/20 |
| `test/backend-request.test.cjs`（desktop） | 6/6 |
| `tsc --noEmit`（backend） / `tsc --noEmit -p tsconfig.app.json`（desktop） | 通过 |

## 仍然保留的已知边界

- Electron 内未重测窗口比例锁；首页/舞台用 Chrome + 桥接 mock 验证。
- 真实 provider 只有手工 e2e，未固化为自动测试。
- 无 `clientMessageId`，客户端仍禁止自动重试；桥接已不再重放 POST。
- `GET /api/lessons/:id` 详情端点与 SSE 仍未实现。
