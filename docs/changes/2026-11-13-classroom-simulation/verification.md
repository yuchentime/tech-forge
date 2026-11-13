---
status: current
layer: change
domain: classroom-simulation
canonical_for:
  - classroom-simulation-verification
created_at: 2026-11-13
related:
  - docs/changes/2026-11-13-classroom-simulation/design.md
---

# 课堂模拟 Agent 轮次 — 验收

- 日期：2026-11-13
- 状态：R002 修复后通过，验收集成见 [acceptance.md](acceptance.md)；Electron 实机与真实 provider 自动化仍未覆盖

## 1. 类型与回归

| 命令 | 结果 |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit`（`apps/backend`） | 通过 |
| `npm run test:rehearsal`（`apps/backend`） | 20/20 通过（验证 `parseJsonObject` 迁移未破坏演练 JSON 解析） |
| `npm run test:classroom`（`apps/backend`，聚合） | 36/36 通过（下分项合计） |
| `test:classroom-lessons` | 14/14：说话人身份映射、新建课堂结束旧 active、损坏降级、列表与预览、总结读取、损坏记录生成失败、HTTP 发言成功路径、历史课堂删除（含目录清理与 409）、404/400、token/origin |
| `test:classroom-turns` | 3/3：同课堂并发拒绝、不同课堂并行、失败释放锁 |
| `test:classroom-runtime` | 3/3：超时中止、取消中止、已取消信号不启动 provider |
| `test:classroom-transcript` | 3/3：队列顺序、失败隔离与清理、损坏行读取/严格读取 |
| `test:classroom-summaries` | 5/5：生成落库、失败可重试、损坏不调模型、并发生成拒绝、启动重置 |
| `test:classroom-migration` | 1/1：旧库多条 active → 保留最新、其余 ended、唯一索引生效 |
| `test:classroom-point` | 7/7：知识点起点/新点重置/轮次推导/上限/已收束保持/起点缺失/导演 JSON 解析 |
| `node --test test/backend-request.test.cjs`（`apps/desktop`） | 6/6 通过：GET 重试一次、POST 不重放、非网络错误不重试、中文错误文案 |

## 2. 端到端（真实 DeepSeek，临时配置/数据目录）

隔离方式：`TEACHFORGE_CONFIG_DIR` 与 `TEACHFORGE_DATA_DIR` 指向临时目录，拷入本机 `config.toml`；一次性脚本直接构造 `LessonsService` 与 `ClassroomSimulationAgent`，跑完后删除临时目录。

| 检查 | 观察 |
|---|---|
| 第一轮 | 2 条消息，speakers `["teacher","lin"]` |
| 第二轮（同一 `lessonId`） | 4 条消息，speakers `["teacher","lin","teacher","su"]`；导演改选了另一名学生 |
| 学生回复内容 | 与老师讲的内容相关，一到两句话，无 Markdown |
| SQLite | 1 行 `lessons`，`status=active`，`endedAt=null` |
| JSONL | `messages.jsonl` 4 行，一消息一行，字段 `{id,speaker,text,createdAt}` |
| 重启语义 | 新建 `LessonsService` 实例仍读回 4 条（无内存状态） |
| 结束课堂 | `endLesson()` 后再次发言被拒绝：`Lesson is not active: <id>`，未产生模型调用 |
| 思考模式 | 两轮均在约 2–4 秒完成，未配置思考等级；日志无 reasoning 输出 |

## 3. 消息列表 API

| 检查 | 观察 |
|---|---|
| 响应字段 | 每条消息含 `id/speaker/role/name/text/createdAt`；teacher → `老师`，lin → `林澈` |
| 排序 | 与 JSONL 写入顺序一致 |
| 结束课堂后 | 仍返回 200 与 `status: "ended"`，记录完整 |
| 非法输入 | 非 UUID → 400；未知课堂 → 404；无 token → 401；带 Origin → 403 |
| 记录损坏 | 读接口 200 + `integrity.degraded` + 损坏行号；可解析消息照常返回 |
| 追加保护 | 损坏记录的 `readMessages()` 与 `appendMessage()` 都被拒绝，新消息不写进坏文件 |
| 恢复手段 | `POST /api/lessons` 返回 201 新课堂；`POST /:id/end` 幂等返回 200 |
| 课堂列表 | `GET /api/lessons` 返回生命周期 + `summaryStatus` + `summaryPreview`；`status` 过滤生效 |
| 总结读取 | `GET /api/lessons/:id/summary` 返回 Markdown、错误与生成时间 |
| 总结生成保护 | active 课堂 POST 返回 409；损坏记录返回 200 + failed 且不调用模型 |
| 发言端点（真实模型） | 建课堂 → 两轮 `/turns` 返回 `[teacher,lin]`、`[teacher,lin,teacher,su]`；结束 → 总结 `ready`；列表带清理后的预览 |
| 发言超时 / 取消 | provider 不返回时 `runPiTurn` 按 `timeoutMs` 中止并让锁释放；已取消信号不会发起 prompt |
| 开始新课堂 | 连续两次 `POST /api/lessons`：均 201、id 不同；旧课堂自动 `ended` 并进入历史；数据库仅 1 行 active |
| 追加互斥 | 队列顺序（无队列会交错）、失败不阻塞后继、settle 后队列清理 |
| 桥接重试 | 只有 GET 在 ECONNRESET 时重试一次；POST 直接报「本地服务连接中断」，不重放 |
| 课堂首页（Chrome + 桥接 mock） | 显示进行中课堂、历史总结预览与状态、右上「开始新课堂」；无横向挤压 |
| 课堂舞台（Chrome + 桥接 mock） | 「继续上课」加载记录；发送讲解后气泡按 `speaker` 落在对应座位（lin 22% / su 50% / gu 78%）、侧栏计数 2、输入框切为单行回答态 |

## 4. 未覆盖

| 项 | 原因 |
|---|---|
| Electron 实机与窗口比例锁 | 首页/舞台用 Chrome + 桥接 mock 验证；Electron 内未重测 |
| 真实 provider 自动化 | 手工 e2e 通过，但未固化为自动测试（成本与密钥） |
| SSE 逐字输出 | 未实现 |
| `clientMessageId` 幂等 | 未实现；桥接已限制为只重试 GET，客户端仍禁止自动重试 |
| `GET /api/lessons/:lessonId` 详情端点 | 与列表 + 消息组合重复，暂缓 |
| 两个工具（`random_dispatcher` / `dispatch_to_student`） | 按用户要求暂缓 |
| 课堂报告与评估 | 产品设计稿后续阶段 |

## 5. 复现要点

1. 编译到隔离目录：`npx tsc -p tsconfig.build.json --outDir .test-dist`。
2. 设置 `TEACHFORGE_CONFIG_DIR` / `TEACHFORGE_DATA_DIR` 指向临时目录，并把本机 `config.toml` 复制进去。
3. 用 `buildDatabaseOptions()` 构造 `DataSource` 并 `initialize()`（自动跑 migration）。
4. 构造 `SettingsService`、`DeepseekLLMAdapter`、`LessonsService`、`StudentAgent`、`ClassroomSimulationAgent`，连续调用 `run()` 两次，第二次带第一次的 `lessonId`。
5. 断言 SQLite 行、JSONL 行数、`speakers` 顺序与结束后拒绝。
