---
status: current
layer: change
domain: classroom-simulation
canonical_for:
  - classroom-simulation-tasks
created_at: 2026-11-13
related:
  - docs/changes/2026-11-13-classroom-simulation/design.md
---

# 课堂模拟 Agent 轮次 — 任务

## 已完成

| 阶段 | 任务 | 结果 |
|---|---|---|
| 数据层 | `lessons` migration 与实体、`database.options.ts` 注册 | `lessons(id, status, endedAt, createdAt, updatedAt)`；无消息列 |
| 数据层 | `LessonsService` 建课堂 / 校验 active / 结束 / 追加 / 读取 | 每课堂一条 Promise 链；JSONL 一消息一行；坏行报行号 |
| 数据层 | `SettingsService` lessons 目录与 UUID 校验 | `getLessonDirectory()`；lessons 根加入受管路径 |
| 数据层 | `parseJsonObject` 从 rehearsals 抽到 `llm/model-json.ts` | 两处 rehearsal 引用改为新位置，`RehearsalMode` 测试回归通过 |
| Agent | `ClassroomSimulationAgent` 重写 | 建/续课堂 → 落盘老师消息 → 导演选人 → 学生回复 → 落盘 → 返回记录 |
| Agent | 导演 JSON 契约与校验 | 非 JSON / 非法 id 直接抛错 |
| Agent | `StudentAgent` 精简为纯工厂 | `createAgent(systemPrompt)`；学生档案迁到 `lessons/classroom-students.ts` |
| Agent | 两个 Agent 关闭思考 | `createCleanPiSession(..., 'off')`；选项不再暴露 `thinkingLevel` |
| 接线 | `LessonsModule` 引入 `LlmModule`，`AppModule` 注册 | 无循环依赖 |
| HTTP（读） | `ClassroomModule` + `ClassroomController` 的 `GET /api/lessons/:lessonId/messages` | 返回 `speaker/role/name` 与 `integrity`；400/404；ended 可读；`test:classroom-lessons` 覆盖 |
| HTTP（恢复） | `POST /api/lessons`（新建）、`POST /api/lessons/:id/end`（幂等） | 损坏记录可换新课堂；旧课堂记录保留 |
| 容错读取 | `readTranscript()` + `readMessages()` | 读接口降级不阻塞；追加消息拒绝损坏记录 |
| 总结存储 | migration `1794040000000` + `lessons` 四个 summary 字段 | 总结进 SQLite，消息仍在 JSONL |
| 总结生成 | `ClassroomSummariesService` + 固定 prompt | `LlmService.generate()`、tools 关闭、120s 超时；失败/损坏/并发都有状态 |
| 总结 API | `GET/POST /api/lessons/:lessonId/summary` | 仅 ended 可生成；active 或生成中 409 |
| 历史列表 | `GET /api/lessons` | `status/limit` 过滤，返回去掉 Markdown 符号的 `summaryPreview` |
| 发言端点 | `POST /api/lessons/:lessonId/turns` + `ClassroomTurnsService` 每课堂运行锁 | 返回全量消息；并发的第二轮 409 |
| 课堂首页 | `ClassroomHome` + `classroom-api.ts` | 进行中/历史/详情/CTA；生成中轮询 |
| 舞台接线 | `ClassroomMode` 改为 lesson API 数据源 | 加载、发送、气泡按 speaker 定位、结束回首页、草稿在视图切换间保留 |

## 待办

| 任务 | 依赖 | 备注 |
|---|---|---|
| 课堂详情端点 `GET /api/lessons/:id` | 与列表 + 消息组合重复 | 可省略 |
| SSE 逐字输出 | 当前整段返回 | 需要时再评估 |
| `clientMessageId` 幂等 | 客户端重试会产生重复老师消息 | 首版禁止自动重试 |
| `random_dispatcher` 工具 | 导演需要多步编排时 | 现由 JSON 选人覆盖 |
| `dispatch_to_student` 工具 | 同上 | 复用 `studentReply()` |
| 课堂级运行锁 | HTTP 并发入口存在后 | 目前只串行追加 |
| 前端接入 | HTTP 可用 | `ClassroomMode` 仍用本地状态 |
| 知识点抽取与课堂报告 | 产品设计稿后续阶段 | 不在本轮 |
