---
status: current
layer: change
domain: classroom-simulation
canonical_for:
  - classroom-point-state
created_at: 2026-11-13
related:
  - docs/changes/2026-11-13-classroom-simulation/design.md
  - docs/changes/2026-11-13-classroom-simulation/acceptance.md
  - docs/current/platform/classroom-mode.md
---

# 知识点状态栏

## 问题

课堂里老师回答学生追问后，学生会继续追问同一个知识点，没有停止条件。之前的代码状态机（每人 2 次、收束后换人、探索概率）过于复杂；现在只保留一个状态栏，由导演判断讨论是否足够。

## 状态

每个课堂在 SQLite `lessons` 保存：

| 列 | 含义 |
|---|---|
| `pointStartMessageId` | 当前知识点第一条老师消息的 id |
| `pointLabel` | 当前知识点的短标签（≤40 字符） |

- 轮次不存计数器：`turns = 起点之后的学生消息数`，消息文件是事实源，崩溃只会少算。
- 没有 `closed` 状态：`done` 是导演每轮重新判断的结果，不落库。

## 每轮流程

1. 老师消息落盘，记下 `teacherMessage.id`。
2. 代码带上 `pointLabel`、`turns`、`maxTurns=5` 调导演。
3. 导演输出 `{"student":"su","pointLabel":"…","done":false,"nextStudent":"lin","nextFocus":"…"}`：
   - `pointLabel` 变化 → 视为新知识点，起点改为当前老师消息，轮次归零；
   - `done=true` → 本轮学生只确认，不再提问。
4. 代码计算 `forceClose = done || turns >= 5`；新知识点首轮不因 `done` 关闭。
5. 学生 prompt 带 `StudentPointContext`：标签、已发言轮次、是否收束、上限。
6. 学生回复成功后：
   - 普通继续：不写状态（轮次由消息推导）；
   - 新点：写回 label 与起点；
   - 收束：先落盘收束确认，再委派 `nextStudent` 生成新知识点问题，写回新起点与 label。

## 导演规则

- 老师回答清晰、学生核心疑问解决 → `done=true`；通常在 3 次左右收束。
- 学生已发言达到 3 次时默认 `done=true`，除非老师最新消息明显没有回应学生。
- 5 次是硬上限，代码强制收束。
- 老师开启新讲解时更新 `pointLabel`，不要为了换人而改标签。
- 每轮都提名 `nextStudent`（不能是 `student`）和可选的 `nextFocus`；代码只在收束时使用。

## 边界

| 场景 | 行为 |
|---|---|
| 旧课堂无状态 | 下一条老师消息视为新点 |
| 起点消息不在记录中 | 重置为新点 |
| 收束后自动提问 | 收束学生确认后，立即用 `nextStudent` 生成新点问题；新起点就是该问题消息 |
| 提名非法/缺失 | 代码从其余学生中按旧点发言最少 → 随机兜底 |
| 新问题生成失败 | 保留收束消息并记日志；下一轮老师发言可再次触发收束与重试 |
| 标签频繁变化 | 每次变化都重置轮次；提示词要求只在老师开启新内容时改 |
| 收束后老师继续讲同一点 | 导演保持 `done=true`，学生只确认 |
| 删除课堂 | 状态随行删除 |
| 崩溃 | 消息已落盘但状态未写时，轮次按 transcript 重算，最多少算一轮 |

## 配置

- `MAX_POINT_TURNS = 5`（`lessons/lesson-point.ts`）：硬上限；正常退出由导演决定。
- 导演提示词在 `llm/classroom-simulation.prompt.ts`，演示 3 次左右收束。

## 验证

- `test:classroom-point` 8/8：起点、状态栏、轮次推导、done、5 次上限、标签重置、起点缺失、导演 JSON 解析。
- 真实模型 6 轮：老师两次引入新内容导致标签重置；最终知识点在第 3 次学生发言后收束（无问号、请老师继续下一个知识点）。
- 5 次硬上限由纯函数单测覆盖（真实模型难以稳定让导演连续 5 轮不收束）。
