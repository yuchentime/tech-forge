---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-09
---

# 演练模式验收计划

> 状态：`implemented`（2026-11-09）。自动化测试与真实 Provider smoke 结果见 §6；§2 保留为回归清单。

## 1. 环境

- macOS arm64，Node `>=22.19.0`。
- Backend：`apps/backend`，测试编译到 `.test-dist`，避免锁住开发中的 `dist`。
- Desktop：`apps/desktop`，测试通过 Electron/Vite 构建产物或现有测试入口。
- 真实 Provider：DeepSeek 或自定义 OpenAI-compatible；本地配置文件 `~/.tech-forge/config.toml` 必须可用。
- 测试数据：一个包含 2–4 轮普通对话的 conversation，主题明确（例如「金字塔原理」）。

## 2. 自动化测试矩阵

### 2.1 后端：状态机与限额

| 编号 | 用例 | 断言 |
|---|---|---|
| B1 | 有历史时开始 | 201；rehearsal `awaiting_answer`；第一 turn `base/depth=0`；`messages` 行数不变；父快照 JSON 不变 |
| B2 | 空会话开始 | 422；无 rehearsal 行 |
| B3 | 同一 `startRequestId` 重放 | 仅一行；返回同一 turnId；HTTP 200 |
| B4 | 回答 correct | 评估落库；返回 `follow_up` 或 `next_question`；计数正确 |
| B5 | 连续 2 次追问后回答 | 下一 turn `kind=base`、`followUpDepth=0`；旧 turn 深度为 2 |
| B6 | 第 15 问回答 | `completed`；report 非空；turns 数 = 15；无第 16 turn |
| B7 | 第 15 问跳过 | `completed`；turns 数 = 15；`skippedCount` +1；无补题 |
| B8 | 普通题跳过 | 当前 turn `skipped`；新 turn `base`；`askedQuestionCount` +1；不产生评估 |
| B9 | 手动结束（空闲） | `completed`；`endReason=manual`；逐题 + 总评；transcript 文件存在 |
| B10 | 手动结束（评估中） | 进行中 generate 被 abort；迟到结果不落库；未完成题标未评估 |
| B11 | 同一 `answerRequestId` 重放 | 返回首次结果；无重复 turn |
| B12 | 同一 turn 并发回答 | 一个 200，一个 409 |
| B13 | 模型 JSON 非法 | 修复重试一次；仍失败 422；答案保留，turn `failed` |
| B14 | `evaluating` 中断恢复 | GET 后回 `awaiting_answer`；turn `answer_saved`；重试成功 |
| B15 | 同一 conversation 并发开始 | 一个 201，一个 409 |
| B16 | 画像超长 | 422；无 rehearsal 行 |
| B17 | 删除 conversation | rehearsals/turns 行删除；transcript 随 session 目录删除；无 FK 错误 |
| B18 | 报告失败 | 保留逐题；允许重试 end；错误不含正文 |
| B19 | 第 15 问为第 2 次追问 | 评估后完成；不再创建基础题 |
| B20 | 模型返回 `complete` | 被拒绝或忽略；不提前结束 |
| B21 | 历史列表 | 当前 conversation 摘要；`createdAt DESC, id DESC`；不含 turns/plan/完整报告 |
| B22 | 历史分页 | `limit` + `cursor` 正确取下一页；`nextCursor` 正确；无重复/漏项 |
| B23 | 历史详情 | 单次接口返回完整 turns、逐题评估、总评、画像、计划 |
| B24 | 历史范围 | 不返回其他 conversation 的演练；404 conversation 不存在 |
| B25 | 状态筛选 | `status=active/completed/failed` 只返回对应状态；`all` 含进行中 |
| B26 | 列表恢复 | 过期且无活跃 run 的遗留 `evaluating` 在列表读取时被 reconciliation；有活跃 run 时不被误判 |

### 2.2 后端：普通对话接入

| 编号 | 用例 | 断言 |
|---|---|---|
| D1 | 报告完成后下一轮普通对话 | `promptContext` 含 digest；模型请求可见摘要 |
| D2 | `contextRefsJson` 合并 | 同时有 attachments / knowledge / rehearsals 时三个键都在 |
| D3 | 快照清洗 | 保存后的父快照最后一条 user 消息只含用户原文，不含 digest |
| D4 | digest 排序 | 只含 completed；按 `endedAt DESC`；最多 3 条 |
| D5 | digest 封顶 | 总长度 ≤6000 字符；最近一次完整，较早压缩 |
| D6 | transcript 路径 | digest 中的路径存在且普通 Agent 可 `read` |
| D7 | 开始新的演练 | 新 rehearsal 的规划 prompt 含上一批摘要与最新普通消息 |
| D8 | 普通消息历史 | `messages` 不新增演练行；历史接口不返回 digest |

### 2.3 桌面端

| 编号 | 用例 | 断言 |
|---|---|---|
| U1 | 空会话 | 开始按钮禁用；提示可见 |
| U2 | 填写画像开始 | 第一题出现；`已提问 1/15` |
| U3 | 提交回答 | 先显示本题评估，再显示下一题/报告 |
| U4 | 跳过 | 新题出现；进度 +1；不显示该题评估 |
| U5 | 结束 | 报告页出现；逐题表 + 总评 |
| U6 | 开始新的演练 | 新 Rehearsal；复用画像；第一题出现 |
| U7 | 切回普通对话 | 演练状态保留；普通对话顶部出现卡片 |
| U8 | 切换会话 | 卡片按会话加载；不串数据 |
| U9 | 模型错误 | inline 错误 + 重试；回答保留 |
| U10 | 提交中 | 提交/跳过禁用；结束可点 |
| U11 | 键盘 | `Ctrl+Enter` 提交；新题后焦点在回答框 |
| U12 | 无障碍 | `aria-pressed` / `aria-live` / 评估等级文字 |
| U13 | 历史入口 | 演练页头「历史演练」+ 数量角标；普通对话卡片可跳转 |
| U14 | 历史列表 | 进行中置顶；已完成显示主题/时间/结束原因/摘要；报告失败显示「报告未完成」 |
| U15 | 历史详情 | 只读报告展示完整问答、逐题评估、总评；无回答框/跳过/结束 |
| U16 | 不打断演练 | 进行中打开历史再返回，当前题/输入/提交中状态保留 |
| U17 | 分页/空态/错误 | 「加载更早」；空列表提示；错误可重试 |
| U18 | 历史开始新的演练 | 从历史报告新建一批；旧报告不被修改 |

## 3. 手工 smoke

按顺序执行，并记录证据：

1. 在普通对话中讨论「金字塔原理」，生成一份学习文档。
2. 切演练，填写学生画像，开始；记录第一题与计划。
3. 回答第一题，触发一次追问；再回答，触发换题。
4. 跳过一题，确认进度增加且不显示该题评估。
5. 手动结束，确认报告含逐题与总评；打开 transcript 文件。
6. 
7. 再切演练，点「开始新的演练」；确认新题基于当前普通对话；完成或结束第二批。
8. 打开「历史演练」，确认两批都在；打开较早一次，检查完整问答、逐题评估、总评、画像与计划；返回历史。
9. 在进行中的演练里打开历史再返回，确认当前题、输入与提交中状态保留。
10. 关闭并重启应用；进入演练模式，确认最近报告/进行中状态恢复；历史列表仍可读取。
11. 删除该 conversation；确认 rehearsal 行与 transcript 目录消失。
12. 检查 SQLite：
    - `messages` 无演练题/答；
    - `pi_session_snapshots` 的父会话 entries 未被演练覆盖；
    - `rehearsals` / `rehearsal_turns` 字段完整；
    - 历史列表查询不读取 turns；
    - 部分唯一索引存在。

## 4. 命令

实施后补充实际脚本；预期命令：

```bash
npm run build --workspace @teachforge/backend
npm run test:rehearsal --workspace @teachforge/backend
npm run test:rehearsal --workspace @teachforge/desktop
npm run test:agent-stream --workspace @teachforge/backend
npm run test:conversation-history --workspace @teachforge/desktop
```

若测试脚本尚未加入 `package.json`，先在对应 workspace 增加脚本，再运行。

## 5. 回归风险

- `LlmService.createSession()` 重构必须保持 `stream()` 的 system prompt、tools allowlist、pi-memory 加载、快照保存行为不变。
- `contextRefsJson` 合并改动会影响附件与知识块；必须回归 `test:chat-attachments`、`test:knowledge-context`。
- `AgentChatPage` 模式状态改动会影响普通对话挂载与历史恢复；必须回归 `test:conversation-history`。
- 删除会话顺序已有 `rehearsal_turns` → `rehearsals`；新增字段不应改变外键关系。
- 真实 Provider 的 JSON 稳定性可能低于测试桩；smoke 必须覆盖一次非法/空输出或至少记录 provider 失败行为。

## 6. 结果记录

实施环境：macOS arm64，Node `v22.23.2`，真实 Provider 为本地 `~/.tech-forge/config.toml` 的 DeepSeek 配置。

| 项 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 后端构建 | `npm run build --workspace @teachforge/backend` | PASS | `nest build` 无错误 |
| 演练状态机 / 限额 / 历史 / digest | `npm run test:rehearsal --workspace @teachforge/backend` | PASS 10/10 | start 幂等、追问上限、15 问完成、手动结束、第 15 问跳过、answer 重放、零回答结束/丢弃、重启恢复、context refs 合并 |
| 快照清洗 | `npm run test:session-entries --workspace @teachforge/backend` | PASS 4/4 | string/text-block、历史行映射、注入标题兜底 |
| Agent stream 回归 | `npm run test:agent-stream --workspace @teachforge/backend` | PASS 8/8 | 含 workspace-file-tools；macOS tmpdir realpath 修正 |
| 会话附件回归 | `npm run test:chat-attachments --workspace @teachforge/backend` | PASS 5/5 | context refs 合并未破坏附件 |
| 会话历史回归 | `npm run test:conversation-history --workspace @teachforge/backend` | PASS 5/5 | |
| 会话删除回归 | `npm run test:conversation-delete --workspace @teachforge/backend` | PASS 2/2 | |
| 知识库上下文回归 | `npm run test:knowledge-context --workspace @teachforge/backend` | PASS 11/11 | |
| 桌面构建 | `npm run build --workspace @teachforge/desktop` | PASS | Electron tsc + renderer tsc + Vite build |
| 桌面演练 store | `npm run test:rehearsal --workspace @teachforge/desktop` | PASS 6/6 | 恢复、历史、answer/end/start、失败重试、开始按钮完成轮次、零回答丢弃、重启后待评估回答重试 |
| 真实 Provider smoke | 本地 backend + DeepSeek，API 直达 | PASS | 开始生成 7 个知识点与首题；回答返回 partial + 追问；手动结束生成总体报告；历史列表 `completed=1`；latest 返回报告 |
| 普通对话 digest | 同一 conversation 调 `/api/chat/stream` | PASS | 模型回答引用演练薄弱点；`contextRefsJson.rehearsals` 写入；快照最终不含 digest 标题 |
| SQLite 检查 | `PRAGMA table_info` / 行查询 | PASS | migration 字段、部分唯一索引、父 `messages` 未被演练写入、历史注入块被清理；零回答 discard 后 Rehearsal/Turn 计数为 0 |

残留风险：

- 真实 Provider 的 JSON 稳定性只在一次 smoke 中观察；生产仍依赖一次修复重试。
- digest 每轮重复注入，长报告会增加普通对话 token；完整内容只在 transcript。
- 15 问总上限包含追问，实际基础题可能只有 5 道。
- v1 不做 SSE、跨会话历史、报告导出或计划编辑。
