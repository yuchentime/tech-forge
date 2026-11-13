---
status: current
layer: change
domain: classroom-simulation
canonical_for:
  - classroom-simulation-brief
created_at: 2026-11-13
related:
  - docs/changes/2026-11-13-classroom-simulation/design.md
  - docs/changes/2026-11-13-classroom-simulation/verification.md
  - docs/current/platform/classroom-mode.md
  - docs/source/课堂模式功能设计.md
---

# 课堂模拟 Agent 轮次 — 简报

- 日期：2026-11-13
- 状态：后端单轮已实施；HTTP、前端与工具未接入
- 关联：[设计](design.md) · [任务](tasks.md) · [验收](verification.md) · [当前课堂模式](../../current/platform/classroom-mode.md)

## 用户诉求（验收标准）

> 创建一个 ClassroomSimulationAgent.ts……大模型调用方式参考 `generate()`，也是调用 Pi SDK，只不过比较干净……会创建并注册 2 个 tool：`random_dispatcher`（从 `['su','lin','gu']` 随机取一名学生）与 `dispatch_to_student`（spawn 一个 subagent）。`dispatch_to_student` 当前只是构想，基本实现即可。
>
> 再创建一个 StudentAgent.ts。这个 Agent 是被 ClassroomSimulationAgent 调用的，因此需要提供一个 `createAgent` 函数，传参是 `systemPrompt`。
>
> 具体的消息我不想都放进 sqlite，本来就是本地运行，那么完全可以写入本地……成员变量 messages 可以不需要，而是直接读取本地 jsonl 就好。
>
> 另外 student Agent 不需要思考模式，ClassroomSimulationAgent 也不需要思考。

拆成可验收项：

1. 一次老师发言产生一条学生回复，并且有明确的“由谁回复”决策，而不是写死。
2. 消息正文不写 SQLite：每条消息写入 `<configDir>/lessons/<lessonId>/messages.jsonl`，进程内不保留消息成员变量。
3. SQLite 只保留课堂生命周期（`id`、`status`、时间戳），重启后课堂仍可继续发言。
4. 学生 Agent 由 `StudentAgent.createAgent(systemPrompt)` 创建，系统提示词与课堂记录解耦。
5. 两个 Agent 都不启用思考模式。
6. 结束后的课堂拒绝再写入消息。
7. 记录损坏不会让课堂卡死：读接口降级展示可解析消息并给出行号，追加被拒绝，前端可一键开始新课堂；损坏文件保留原样。
8. 只做 P2 模型总结：结束课堂后按需生成四段 Markdown（本节讲了什么 / 学生关注点 / 尚未解答 / 建议补充），存 SQLite；不做 P1 规则统计。
9. 「课堂模式」入口改为课堂首页：进行中的课堂 + 历史课堂（含总结预览）+ 空态 CTA「开始新课堂」。

## 范围

| 层 | 位置 |
|---|---|
| 课堂生命周期与本地记录 | `apps/backend/src/lessons/`、`apps/backend/src/database/migrations/1794030000000-classroom-lessons.ts` |
| 导演与学生 Agent | `apps/backend/src/llm/ClassroomSimulationAgent.ts`、`StudentAgent.ts`、`pi-agent-runtime.ts`、`model-json.ts` |
| 本地路径与文件保护 | `apps/backend/src/settings/settings.service.ts`（`lessons/` 目录 + 受管路径） |

## 不在本轮

- 课堂 HTTP/SSE 端点、桌面端课堂视图接入模型（视图仍是本地原型）。
- `random_dispatcher` / `dispatch_to_student` 两个工具（当前用代码内的导演选人代替）。
- 课堂级运行锁（目前只串行化追加，不锁整轮模型调用）。
- 讲解知识点抽取、逐题评估与课堂报告。
- 课堂首页与总结视图的前端接线（后端列表/总结 API 已实现）。
