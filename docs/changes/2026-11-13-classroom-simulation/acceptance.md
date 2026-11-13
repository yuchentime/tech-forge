---
status: current
layer: change
domain: classroom-simulation
canonical_for:
  - classroom-simulation-acceptance
created_at: 2026-11-13
related:
  - docs/changes/2026-11-13-classroom-simulation/design.md
  - docs/changes/2026-11-13-classroom-simulation/api-contract.md
  - docs/changes/2026-11-13-classroom-simulation/verification.md
---

# 课堂模拟 Agent 轮次 — 验收文档

- 日期：2026-11-13
- 范围：R002 修复后的课堂后端、桌面首页/舞台与桌面桥
- 判定方式：自动化套件 + 真实 provider HTTP 集成 + 界面集成（Chrome + 桌面桥 mock）
- 结果列在每节末尾；未覆盖项单列，不折算为通过。

## 1. 需求一致性

| ID | 用例 | 期望 | 方法 |
|---|---|---|---|
| R-01 | 一轮 = 老师消息 + 一名学生回应 | 返回 2 条新消息，顺序 teacher → student | HTTP 集成 |
| R-02 | 消息只在本地 JSONL | 记录文件存在、SQLite `lessons` 无消息列 | HTTP 集成 + 库检查 |
| R-03 | 两个 Agent 关闭思考、无工具 | 代码/测试断言 `thinkingLevel: 'off'`、`tools: []` | 代码审查 + 单测 |
| R-04 | 导演 JSON 选人，非法即失败 | 非法输出不落学生消息，返回 502 | 代码审查 + 单测 |
| R-05 | 记录损坏可恢复 | 读降级、追加 409、新建课堂可脱离 | HTTP 集成 |
| R-06 | 只做 P2 总结，不评分 | 四节 Markdown，无掌握度/分数 | HTTP 集成 |
| R-07 | 入口是课堂首页 | 侧栏进入后显示进行中/历史/CTA，不直接进舞台 | 界面集成 |
| R-08 | 「开始新课堂」总是新建 | 新 id；旧 active 结束并进入历史 | HTTP + 界面集成 |

## 2. 功能正确性

| ID | 用例 | 期望 | 方法 |
|---|---|---|---|
| F-01 | 新建课堂 | 201、`active`、`summaryStatus: none` | HTTP 集成 |
| F-02 | 连续新建 | 两次都 201，id 不同；仅 1 行 active | HTTP 集成 |
| F-03 | 一轮发言 | 200；`messages` 带 `speaker/role/name/text/createdAt` | HTTP 集成 |
| F-04 | 学生身份映射 | `su/lin/gu` → 苏小满/林澈/顾知夏；`teacher` → 老师 | HTTP 集成 |
| F-05 | 同课堂并发 | 两个同时请求一个 200、一个 409；只落一轮消息 | HTTP 集成 |
| F-06 | 结束课堂 | 200、`ended`、`endedAt` 非空；重复结束 200 | HTTP 集成 |
| F-07 | 结束后发言 | 409，且不新增消息 | HTTP 集成 |
| F-08 | 总结生成 | `ready` + 四节 Markdown；可重新生成 | HTTP 集成 |
| F-09 | 历史列表 | `summaryStatus`、`summaryPreview`（无 Markdown 符号） | HTTP 集成 |
| F-10 | 舞台发送与气泡 | 学生消息出现在对应 `speaker` 位置，侧栏计数正确 | 界面集成 |
| F-11 | 结束回首页 | 舞台结束 → 首页；后台总结轮询到完成 | 界面集成 |
| F-12 | 发送即时反馈 | 讲解立刻出现在输入框上方；输入框清空并切为单行回答框；老师消息立刻进入列表 | 界面集成 |
| F-13 | 思考气泡 | 等待时三名学生头顶各一个「正在思考中…」（带旋转加载图标）；回复到达后替换为真实学生气泡 | 界面集成 |
| F-14 | 气泡座位 | 左→右为 `lin`（22%）、`su`（50%）、`gu`（78%）；学生气泡按 `speaker` 落在对应座位 | 界面集成 |
| F-15 | 结束按钮时机 | 草稿舞台只有「退出课堂」；首次发送创建成功且 `active` 后才出现「结束课堂」 | 界面集成 |
| F-16 | 草稿不落库 | 开始新课堂但不发送，退出后首页无进行中课堂、历史不增加 | 界面集成 |
| F-17 | 删除历史课堂 | 行尾删除 → 确认 → 列表移除；行、总结与记录目录删除；active/生成中返回 409 | 界面 + HTTP 集成 |

## 3. 边界与错误

| ID | 用例 | 期望 | 方法 |
|---|---|---|---|
| E-01 | 空/纯空白消息 | 400，不写文件 | HTTP 集成 |
| E-02 | 未知课堂 | 404 | HTTP 集成 |
| E-03 | 非法 UUID | 400 | HTTP 集成 |
| E-04 | 损坏记录读取 | 200 + `integrity.degraded` + 行号 | HTTP 集成 |
| E-05 | 损坏记录追加 | 409，新消息不写入坏文件 | HTTP 集成 |
| E-06 | 甲方断开 / 超时 | 轮次中止、锁释放（运行时用例） | 单测 |
| E-07 | 无 token / 带 Origin | 401 / 403 | 单测 |

## 4. 数据与迁移

| ID | 用例 | 期望 | 方法 |
|---|---|---|---|
| D-01 | JSONL 行格式 | `{id,speaker,text,createdAt}`，一消息一行 | HTTP 集成 |
| D-02 | 总结存储 | `lessons.summaryStatus/summaryMarkdown/...`，不进 JSONL | HTTP 集成 |
| D-03 | 旧库多条 active | 保留最新，其余 ended 且 `endedAt` 非空；唯一索引拒绝第二条 | 迁移单测 |
| D-04 | 重启读取 | 新服务实例可读回全部消息 | 单测（已有） |

## 5. 回归与契约

| ID | 用例 | 期望 | 方法 |
|---|---|---|---|
| G-01 | 桌面桥重试 | 仅 GET 重试一次；POST 不重放 | desktop 单测 |
| G-02 | 演练 JSON 解析 | 20/20 通过 | 回归套件 |
| G-03 | 类型检查/构建 | backend、desktop 通过 | tsc + vite build |
| G-04 | HTTP 契约 | 状态码/字段与 `api-contract.md` 一致 | HTTP 集成 |
| G-05 | 文档一致性 | 代码、契约、current 页面无“未实现/新 UUID”漂移 | 文档校验 |

## 6. 可读性与结构（R002）

| ID | 用例 | 期望 | 方法 |
|---|---|---|---|
| S-01 | 队列可鉴别 | 去掉队列会交错；现有用例断言顺序 | 单测 |
| S-02 | 职责拆分 | transcript/队列、提示词、错误类各自独立文件 | 代码审查 |
| S-03 | 前端拆分 | 横幅/抽屉/草稿独立；轮询依赖收敛 | 代码审查 |

## 7. 未覆盖

| 项 | 原因 |
|---|---|
| Electron 实机与 16:9 窗口锁 | 界面集成使用 Chrome + 桥接 mock |
| 真实 provider 自动化 | 集成脚本使用真实密钥但一次性执行，不入 CI |
| SSE 逐字输出、`clientMessageId` 幂等 | 未实现 |
| `GET /api/lessons/:id` 详情端点 | 暂缓 |
| 两个课堂工具 | 按需求暂缓 |

## 8. 集成执行结果

### 8.1 API（真实 DeepSeek，临时配置/数据目录）

一次性脚本启动 `TypeOrmModule + ClassroomModule`，真实 HTTP + 真实 provider；临时目录在结束后删除。

| ID | 结果 | 观察 |
|---|---|---|
| F-01 | pass | `POST /api/lessons` → 201、`active`、`summaryStatus=none` |
| F-02 / R-08 | pass | 连续新建：两次 201、id 不同；旧课堂 `ended` 且 `endedAt` 非空；active 仅 1 行 |
| R-01 / F-03 / F-04 | pass | 一轮返回 `[teacher, student]`；学生 `lin/林澈`，字段齐全 |
| F-05 | pass | 同课堂两个并发 `/turns`：`200/409`；消息仍只有一轮 |
| R-05 / E-04 / E-05 | pass | 追加坏行后读 `200 + degraded + 1 行`；发言 409；新建得到新 id，旧课堂 ended |
| F-06 / F-07 | pass | 结束 200；重复结束 200；结束后发言 409 |
| F-08 / F-09 / R-06 | pass | 总结 `ready`（272 字符）；列表预览不含 `##` |
| E-01 / E-02 / E-03 | pass | 空白 400、未知课堂 404、非 UUID 400 |
| D-01 / D-02 | pass | JSONL 正好 2 行，字段为 `createdAt/id/speaker/text`；总结只在 SQLite |

### 8.2 界面（Chrome 1568×880 + 桌面桥 mock）

| ID | 结果 | 观察 |
|---|---|---|
| R-07 / UI-01 | pass | 侧栏「课堂模式」打开首页；无进行中课堂时显示说明；历史 6 条 |
| R-08 / UI-02/05 | pass | 「开始新课堂」进入草稿舞台；空草稿退出不落库；首次发送后出现 active 课堂 |
| F-10 / UI-03 | pass | 发送讲解后出现学生气泡（苏小满/林澈/顾知夏之一）与侧栏消息；气泡位于该 `speaker` 的座位 |
| UI-04 | pass | 退出课堂回首页，「继续上课」可用 |
| F-11 / UI-06/07 | pass | 结束确认后回首页、进入历史；后台总结轮询至「总结已生成」 |
| F-12 / F-13 | pass | 发送后 400ms：peek 含讲解、输入框为单行「回答学生…」、三名学生各一个带加载图标的「正在思考中…」；9 秒后仅剩真实学生气泡 |
| F-14 | pass | 思考气泡 left 依次 `50%/22%/78%`（su/lin/gu）；苏小满真实气泡 `50%`，林澈真实气泡 `22%` |
| F-15 | pass | 草稿舞台无「结束课堂」；首次发送成功后出现且只有一个 |
| F-16 | pass | 空草稿退出后首页显示「现在没有进行中的课堂」，历史 0 条 |
| F-17 | pass | 删除后历史 2→1、记录目录消失；API 只剩另一节；active 与生成中均 409 |

边界观察：在没有任何消息的第二节课上直接结束，总结仍能生成，模型会输出「记录中没有相关内容」；不阻塞、不报错。若希望空课堂不生成总结，需要单独的产品规则，本轮未改。

### 8.3 回归

| 套件 | 结果 |
|---|---|
| `npm run test:classroom` | 27/27 |
| `npm run test:rehearsal` | 20/20 |
| `test/backend-request.test.cjs`（desktop） | 6/6 |
| `tsc --noEmit`（backend/desktop）、`build:renderer` | 通过 |
| 文档链接、代码围栏、manifest YAML | 通过 |

### 8.4 结论

除第 7 节列出的未覆盖项外，本次验收维度全部通过。「开始新课堂」进入草稿舞台，首次发送才创建课堂（并结束旧 active）；空草稿退出不留下 active/历史记录，结束课堂只在课堂存在后显示。记录降级、并发锁、结束与总结链路均按契约工作。
