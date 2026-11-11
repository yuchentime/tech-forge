---
status: current
layer: domain
domain: memory
canonical_for:
  - long-term-memory-behavior
related:
  - docs/current/platform/agent-runtime.md
  - docs/current/domains/system-settings/index.md
  - docs/current/platform/tech-stack.md
  - docs/changes/2026-11-11-long-term-memory/design.md
last_verified: 2026-11-11
---

# 长期记忆当前事实

长期记忆是用户级、跨会话的文本事实，由 `apps/backend/src/memory/` 自研实现。引擎使用 `@db0-ai/core` 的 SQLite backend（sql.js），嵌入直接复用知识库的本地 `bge-small-zh-v1.5`，不调用任何远程 embedding 服务。

## 1. 存储

| 项目 | 事实 |
|---|---|
| 根目录 | `<configDir>/memory/`，默认 `~/.tech-forge/memory/`；`TEACHFORGE_CONFIG_DIR` 会同时移动该目录 |
| 主库 | `<configDir>/memory/db0.sqlite`（sql.js 单文件，整库驻留内存） |
| 锁 | `<configDir>/memory/.lock`：进程启动时以 `wx` 创建，记录 PID；存活持有者会让记忆整体禁用，陈旧锁会被回收 |
| 备份 | `<configDir>/memory/backup/db0-YYYY-MM-DD.sqlite`，最多保留 3 份；在打开已有库前复制 |
| 嵌入身份 | `db0_meta.embedding_id = "local:bge-small-zh-v1.5:512"`；不一致时启动阶段调用 `migrateEmbeddings` |
| 保护 | `SettingsService.getManagedFilePaths()` 包含该目录，`workspace-file-tools` 对读写都拒绝 |

`db0_memory` 是唯一主动写入的表：`agent_id = "teachforge"`、`user_id = "local-user"`、`scope = "user"`、`session_id = NULL`、`embedding` 为 512 × float32（2048 B）。`db0_state`、`db0_log`、`db0_memory_edges` 保留结构但本功能不写；禁止在每轮钩子写 `log()`，因为 sql.js 每次写都会整库重写文件。

## 2. 会话装载与工具

`LlmService.createSession()` 在 `loadMemory` 为真时调用 `MemoryService.createToolExtension()`，把工厂加入 `DefaultResourceLoader.extensionFactories`；工具名加入 allowlist 的 `memory_*` 模式。

| 调用 | 是否装载记忆 |
|---|---|
| 聊天 `stream()` | 是（默认 `loadMemory: true`） |
| 演练 / 知识事实 `generate()` | 否（默认 `loadMemory: false`，且 `tools: []`） |

| 工具 | 行为 |
|---|---|
| `memory_write` | 统一写入路径：精确去重 → 相似度 ≥0.80 且中文极性相反时 `supersedes` → 否则 `context().ingest()`；返回 `saved`/`duplicate`/`superseded` |
| `memory_search` | 本地嵌入查询，`scope: user`、`minScore 0.35`、最多 10 条 |
| `memory_list` | active 记忆，最多 50 条 |

工具参数必须提供 `typebox` 的 `parameters` 对象；`execute` 返回 `{ content: [{ type: 'text', text }], details }`。记忆禁用或锁定后，工具返回“长期记忆暂不可用”，不抛跨层异常。

## 3. 每轮注入

`ChatService` 在组装 per-turn 材料时调用 `MemoryService.buildChatContext(userPrompt)`：

- 不修改系统提示词（保持 provider 前缀缓存）；
- 注入块作为 user message 前缀，格式：

```text
## 长期记忆
以下内容来自跨会话长期记忆；只在与当前请求相关时使用，不要逐条复述。若与用户当前指令或 SOULS 风格设置冲突，以当前指令 / SOULS 为准。
- [2026-11-11] 用户偏好：先给结论再给例子。
```

- 阈值：`minScore 0.65`、最多 3 条、每条 200 字、超时 1.5 s；空库、低分、超时或异常都返回空串；
- 快照清洗：`replaceInjectedUserText()` 把 `## 长期记忆` 列入注入头，历史 user 条目在 `## 用户输入` 分隔符处剥离；当前条目替换为干净 prompt，记忆块不进入 SQLite 消息、不进入下一轮快照。

## 4. 写入策略

1. **模型工具**：系统提示词要求只在用户陈述长期偏好、身份或明确要求记住时调用 `memory_write`；禁止记录一次性任务、文件内容、教学掌握度（正确率/薄弱点）和回答风格。
2. **显式意图自动写入**：`ChatService` 在用户消息持久化后调用 `MemoryService.captureUserMessage()`。仅匹配 `记住/记一下/以后都/每次都/不要再用/我的偏好是…` 等中文意图，按句切分，最多 2 句，每句 4–300 字；命中 `掌握|正确率|错题|薄弱|API key|密码` 等排除规则时跳过。
3. **中文冲突**：写入前搜索相似度 ≥0.80 的 user 记忆；若新旧极性相反（否定词表 vs 肯定词表），用 `supersedes` 覆盖旧行并保留旧行为 `superseded`（可审计，不参与检索与注入）。
4. 写入经 `writeQueue` 串行化，避免 sql.js 并发持久化。

## 5. 本地管理 API

| API | 行为 |
|---|---|
| `GET /api/memories` | active 记忆，最多 100 条，字段 `{ id, content, tags, createdAt }`，不返回 embedding |
| `DELETE /api/memories/:id` | 物理删除一条；不存在返回 404 |
| `DELETE /api/memories` | 清空全部存储（含 superseded 历史），返回 `{ deleted }` |

设置页“长期记忆”区块读取该列表，支持单条删除与清空（二次确认）。删除对下一条消息立即生效。

列表默认只渲染前 3 条（`MEMORY_PREVIEW_LIMIT`），更多时显示“展开其余 N 条”；展开后滚动条只出现在该区块内（`max-h-96 overflow-y-auto`），不改变设置页整体滚动。删到只剩 3 条时自动折叠并隐藏切换按钮。

## 6. 失败与生命周期

- 锁被存活进程持有、db0 导入失败或嵌入模型不可用时，`MemoryService` 进入禁用状态：不注册工具、不注入、不写入；聊天照常进行。
- 日志只记录计数、耗时和错误类型，不记录记忆正文、用户原句或路径。
- 删除会话不删除记忆；`TEACHFORGE_DATA_DIR` 只影响 SQLite 主库与 `documents/`，不重定位记忆根。
- 记忆库不参与现有 `migrateLegacyDataDirectory()`；备份需要人工复制回主库恢复。

## 7. 代码位置

- 引擎、锁与备份：`apps/backend/src/memory/memory-engine.ts`
- 策略：`apps/backend/src/memory/memory-policy.ts`
- 工具扩展：`apps/backend/src/memory/memory-extension.ts`
- 服务与写入/注入：`apps/backend/src/memory/memory.service.ts`
- 管理 API：`apps/backend/src/memory/memory.controller.ts`
- 会话装载：`apps/backend/src/llm/llm.service.ts`
- 注入与捕获入口：`apps/backend/src/chat/chat.service.ts`
- 快照清洗：`apps/backend/src/llm/session-entries.ts`
- 设置页：`apps/desktop/src/features/settings/SettingsPage.tsx`
- 工具文案：`apps/desktop/src/features/agent/tool-activity-label.ts`
