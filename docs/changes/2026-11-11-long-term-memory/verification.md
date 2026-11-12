---
status: current
layer: change
domain: long-term-memory
created_at: 2026-11-11
---

# 长期记忆验收

## 1. 自动化用例

| 编号 | 层级 | 覆盖 | 断言 |
|---|---|---|---|
| M1 | `memory.test.cjs` | 存储位置与目录创建 | 临时 `TEACHFORGE_CONFIG_DIR` 下存在 `<tmp>/memory/db0.sqlite`，且目录在启动初始化时已创建 |
| M2 | `memory.test.cjs` | 本地嵌入维度 | `SELECT length(embedding)/4 FROM db0_memory` = 512；`db0_meta.embedding_id` = `local:bge-small-zh-v1.5:512` |
| M3 | `memory.test.cjs` | 重启持久化 | 关闭实例、重新创建 `MemoryService` 后，同义查询命中同一条内容 |
| M4 | `memory.test.cjs` | 去重 | 相同内容写入两次，第二次返回 `duplicate`，表行数不增加 |
| M5 | `memory.test.cjs` | 维度保护 | 手动插入 384 维向量后检索抛 `Vector dimension mismatch` |
| M6 | `memory.test.cjs` | 显式意图写入 | `记住，我以后都用简体中文` 写入；`帮我看看这道题` 不写入 |
| M7 | `memory.test.cjs` | 注入格式 | 空库返回 `''`；有记忆时以 `## 长期记忆` 开头，≤2 条、每条 ≤150 字、带 `YYYY-MM-DD` 日期与“SOULS/当前指令优先”声明 |
| M8 | `memory.test.cjs` | 失败降级 | embedding 抛错或 `pack` 超时（1.5 s）时 `buildChatContext()` 返回 `''`，无异常外溢 |
| M9 | `memory-extension.test.cjs` | 工具契约 | 3 个工具都有对象 `parameters`；`execute` 返回 `{ content: [{type:'text'}], details }`；名称为 `memory_write` / `memory_search` / `memory_list` |
| M10 | `memory-extension.test.cjs` | 工具行为 | `memory_write` 返回 `saved`/`duplicate`/`superseded`；`memory_search` 按分数降序；`memory_list` 不返回 superseded |
| M11 | `session-entries.test.cjs` | 快照清洗 | 以 `## 长期记忆` 开头的历史 user 条目被剥离到 `## 用户输入` 之后；当前条目替换为干净 prompt |
| M12 | `tool-activity-label.test.cjs` | 桌面文案 | `memory_write`/`memory_search`/`memory_list` 不显示原始工具名 |
| M13 | `memory-policy.test.cjs` | 中文策略 | `polarity()` 识别“不要/别再/不用”为否定、“要/继续/喜欢”为肯定；排除正则命中“掌握/正确率/密码”；切句上限 2 条 |
| M14 | `memory.test.cjs` | 冲突覆盖 | 先写“用英文标题”，再写“以后不要用英文标题” → 第二次 `superseded`，旧行 `status='superseded'`，检索只返回新句 |
| M15 | `memory.test.cjs` | 注入阈值 | stub 余弦 0.60 的无关记忆不注入；0.75 的相关记忆注入；总数不超过 2；单条正文截断到 150 字符 |
| M16 | `memory.test.cjs` | 排除规则 | 含“掌握/正确率/密码”的句子写入被跳过 |
| M17 | `memory.test.cjs` | 锁与备份 | 已存在存活 PID 的 `.lock` → `disabledReason='locked'`、工厂返回 `undefined`；初始化后 `backup/` 中最多 3 个副本 |
| M18 | `memory-http.test.cjs` | 管理 API（若实现） | GET 列表不含 embedding；DELETE 单条 404 语义；清空返回数量且列表为空 |
| M19 | `agent-stream.test.cjs` | 写入时序 | 一轮内 `buildChatContext` 先于 `captureUserMessage` 执行，同轮检索看不到刚捕获的句子 |

命令：

```bash
npm run test:memory --workspace @teachforge/backend
npm run test:session-entries --workspace @teachforge/backend
npm run test:agent-stream --workspace @teachforge/backend
```

回归：

```bash
npm run test:agent-stream --workspace @teachforge/backend
npm run test:rehearsal --workspace @teachforge/backend
```

## 2. 集成检查（真实 Pi session）

| 编号 | 步骤 | 期望 |
|---|---|---|
| I1 | 启动后端，发一条普通消息（使用脚本化 provider，或手工真实模型） | `llm.session.create.completed` 中 `loadMemory=true`、`memoryToolCount=3`；工具列表包含 `memory_*` |
| I2 | 在聊天中发送“记住，我以后都用简体中文” | 下一轮系统/用户输入出现 `## 长期记忆` 块；`memory.write.saved` 有记录 |
| I3 | 新开会话问“我喜欢用什么语言回答” | 回答体现“简体中文”；`memory.context.built` 的 `items ≥ 1` |
| I4 | 重启后端，重复 I3 | 仍能命中（SQLite 持久化） |
| I5 | 触发一次演练（`generate`） | `memory.context` 无记录；工具列表为空；不出现 `## 长期记忆` |
| I6 | 让模型 `read` `~/.tech-forge/memory/db0.sqlite` | 返回 workspace 策略拒绝（受保护路径） |
| I7 | 删除一个会话后检查记忆库 | 记忆仍在；新会话仍可检索 |
| I8 | 若实现管理 API：在设置页删除一条错误记忆后再问相关问题 | 回答不再引用该记忆；`memory.context.built` 条目数下降 |

## 3. 手工验证要点

1. 检查磁盘：

```bash
ls -l ~/.tech-forge/memory
```

2. 直接读库（只读，不启动第二个写进程）：

```bash
sqlite3 ~/.tech-forge/memory/db0.sqlite \
  "select scope, status, length(content), length(embedding)/4 from db0_memory order by created_at desc limit 5;"
```

3. 空库/坏库降级：临时把 `TEACHFORGE_CONFIG_DIR` 指向只读目录，聊天仍应正常回答，日志出现 `memory.*.failed`，无 500。

## 4. 证据记录

| 日期 | 执行人 | 命令/场景 | 结果 |
|---|---|---|---|
| 2026-11-11 | 实施 | `npm run test:memory --workspace @teachforge/backend` | 20 passed |
| 2026-11-11 | 实施 | `npm run test:session-entries --workspace @teachforge/backend` | 7 passed |
| 2026-11-11 | 实施 | `npm run test:rehearsal --workspace @teachforge/backend` | 20 passed |
| 2026-11-11 | 实施 | `npm run test:agent-stream --workspace @teachforge/backend` | 11 passed |
| 2026-11-11 | 实施 | `nest build` + Electron `tsc` + renderer `tsc --noEmit` | 通过 |
| 2026-11-11 | 实施 | `npm run test:memory --workspace @teachforge/backend`（阈值调整为 0.72 / 2 条 / 150 字后） | 21 passed |
| 2026-11-11 | 实施 | `tsc --project tsconfig.build.json --outDir .test-dist` + `node --test test/agent-stream.test.cjs`（`dist` 被运行中的后端进程占用） | 15 passed，含写入时序用例 |

## 5. 未覆盖 / 后续

- 记忆质量（召回率、误记率）需要真实教师语料标定 0.72 注入阈值与意图正则；
- 跨平台仅 Windows x64 有运行证据；sql.js WASM 在打包后的 `utilityProcess` 中需单独验证；
- LLM 抽取、候选/确认状态、来源表与能力等级投影不在 v1（见 design §14）；若 T0 决策 2 未纳入，则“查看/删除记忆”也不在 v1，需作为已知缺口记录。

## 6. 双实例与耐久性检查（P0，手工）

| 编号 | 步骤 | 期望 |
|---|---|---|
| D1 | 启动两个应用实例（或 `node dist/main.js` + 桌面应用），在 A 中写入一条记忆，再在 B 中写入另一条，重启后检查 | 两条都存在；若实现选择单实例锁，第二个实例应直接退出或复用第一个实例 |
| D2 | 写入记忆后立刻杀掉 backend 进程（模拟崩溃），重启检查 | 记忆库可读，最多丢失最后一次写入；`backup/` 下有可恢复副本 |
| D3 | 把 `memory/` 设为只读后聊天 | 聊天正常，日志出现 `memory.*.failed`，无 500 |
