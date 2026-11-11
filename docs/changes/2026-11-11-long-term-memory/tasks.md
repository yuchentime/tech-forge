---
status: current
layer: change
domain: long-term-memory
created_at: 2026-11-11
---

# 长期记忆实施任务

按顺序执行；每个任务完成后先跑该任务的最小验证，再进入下一项。

## T0 前置决策与保护（先于编码）

- [x] 按 [worklog §2](worklog.md) 的推荐默认执行（四项产品决策未获书面确认）。
- [x] **单实例或记忆库文件锁**：优先在 Electron Main 增加 `app.requestSingleInstanceLock()`（全局收益）；若产品暂不允许改桌面启动行为，则在 `MemoryService` 初始化时对 `<configDir>/memory/db0.sqlite` 加独占锁文件（`wx` 创建 + PID/时间戳），拿不到锁时禁用记忆并记录告警。
- [x] **写盘保护**：每次 `persist()` 后无法感知上游失败，因此在 `MemoryService` 侧维护 `<configDir>/memory/backup/db0-<date>.sqlite` 的每日副本（最多保留 3 份），并记录 `memory.backup.written`。
- [x] 若决策要求“候选/确认”或“记忆管理入口”，在 T3/T5 之前补充对应范围；否则在 brief 中明确 v1 不满足 `功能设计文档.md` §15.3，并通知产品侧。

## T1 依赖与目录

- [x] `apps/backend/package.json` 增加 `@db0-ai/core@0.3.0`、`@db0-ai/backends-sqlite@0.3.0`；更新根 `package-lock.json`（`npm install --workspace @teachforge/backend`）。
- [x] `SettingsService` 增加 `private readonly memoryDirectory = join(this.configDirectory, 'memory')` 与 `getMemoryDirectory(): string`。
- [x] `getManagedFilePaths()` 返回值加入 `this.memoryDirectory`。
- [x] `apps/backend/src/memory/memory.module.ts` 导入 `EmbeddingModule`、`SettingsModule`，`exports: [MemoryService]`。

验收：`npm run build --workspace @teachforge/backend` 通过；`getMemoryDirectory()` 在临时 `TEACHFORGE_CONFIG_DIR` 下返回 `.../memory`。

## T2 引擎与嵌入

- [x] 新建 `apps/backend/src/memory/memory-engine.ts`：
  - 动态 import `@db0-ai/core` / `@db0-ai/backends-sqlite`（复用 `new Function('specifier', 'return import(specifier)')` 手法）；
  - **先取 `<configDir>/memory/.lock`**（`wx` + PID；陈旧锁清理；拿不到则 `disabledReason='locked'`）；
  - `createSqliteBackend({ dbPath: join(memoryDir, 'db0.sqlite') })`；
  - `mergeProfiles(PROFILE_CODING_ASSISTANT, { retrieval: { scoring: 'similarity', minScore: 0.65, topK: 3, graphExpand: { enabled: false } }, context: { includeEdges: false } })`；
  - `embeddingFn` / `batchEmbeddingFn` 绑定 `EmbeddingService`；
  - `EMBEDDING_ID = \`local:${embedding.modelId}:${embedding.dimension}\``，初始化时 `metaGet('embedding_id')` → 写入 / `migrateEmbeddings` / 无操作；
  - **每日备份**：复制到 `backup/db0-<date>.sqlite`，最多 3 份；
  - 暴露 `getHarness(conversationId)`、`close()`、`disabledReason`。
- [x] `MemoryService.onModuleInit()` 安排后台预热（动态 import + backend 初始化 + 一次 `embedOne('预热')`），不阻塞应用启动。
- [x] 初始化失败时清空缓存 promise、设置 `disabledReason` 并记录 `memory.disabled`（不抛给调用方）。
- [x] `onApplicationShutdown`：删除锁文件、关闭 backend。

验收：临时目录下首次 `getHarness()` 后 `db0_meta.embedding_id` 为 `local:bge-small-zh-v1.5:512`；`db0_memory.embedding` 长度 2048 B。

## T3 工具与写入路径

- [x] 新建 `apps/backend/src/memory/memory-policy.ts`：意图正则、排除正则、`normalize()`、`polarity()`（中文否定/肯定词表）、`splitMemorySentences()`；纯函数，便于单测。
- [x] 新建 `apps/backend/src/memory/memory-extension.ts`：
  - `typebox` 定义三个工具的 `parameters`；
  - `memory_write` → `MemoryService.write(content, tags)`（§8.3：精确去重 → 相似度 ≥0.80 + 极性冲突 → `supersedes`；否则 `ingest`），返回 `{ content: [{ type:'text', text }], details }`；
  - `memory_search` → `memory().search({ embedding, scope: ['user'], limit, minScore: 0.35 })`；
  - `memory_list` → `memory().list('user')`，过滤 `active`，最多 50 条；
  - 所有输出截断到 300 字符/条，错误映射为失败文本；
  - `disabledReason` 非空时返回“记忆暂不可用”。
- [x] `MemoryService.write()` 全部经过 `writeQueue`；返回 `saved` / `duplicate` / `superseded`。
- [x] 工厂签名 `createMemoryToolsExtension(deps): PiExtensionFactory`，只调用 `pi.registerTool`，不注册事件钩子。

验收：用假 `pi` 对象断言 3 个工具名、`parameters` 为对象、`execute` 返回 `{ content, details }`；写入“以后不要用英文标题”能 supersede 语义相近的旧肯定句。

## T4 LLM 装载

- [x] `LlmService` 注入 `MemoryService`（`LlmModule` 导入 `MemoryModule`）。
- [x] `LlmRequestOptions` / `LlmGenerateOptions` 增加 `loadMemory?: boolean`；`PiSessionBuildOptions` 同步增加。
- [x] `createSession()`：
  - `const loadMemory = buildOptions.loadMemory ?? true;`
  - `loadMemory` 时 `extensionFactories.push(await this.memory.createToolExtension(conversationId))`（`undefined` 跳过）；
  - allowlist：`buildOptions.tools ?? [...默认, 'memory_*']`；
  - `llm.session.create.completed` 增加 `loadMemory`、`memoryToolCount`。
- [x] `stream()` 默认 `loadMemory: true`；`generate()` 传 `loadMemory: options.loadMemory ?? false`。
- [x] 普通聊天 `customSystemPrompt` 增加记忆使用规则；演练分支（`systemPromptAppend` 存在）不拼接。

验收：聊天会话工具列表包含 `memory_*`；`generate({ tools: [] })` 不注册记忆工具，扩展工厂不被调用。

## T5 注入与写入入口

- [x] `MemoryService.buildChatContext()`：
  - `disabledReason` 非空返回 `''`；
  - `pack(userPrompt, { scopes: ['user'], tokenBudget: 400, maxItems: 3, minScore: 0.65 })`，1.5 s 超时；
  - 过滤 active、按分数与日期排序、每条 200 字、最多 3 条；
  - 输出带日期与“SOULS/当前指令优先”声明的 `## 长期记忆` 块；
  - 空/失败/超时返回 `''`。
- [x] `ChatService` 注入 `MemoryService`（`ChatModule` 导入 `MemoryModule`）：
  - `const memoryContext = await this.memory.buildChatContext(userPrompt);`
  - `promptContext = [attachmentContext, memoryContext].filter(Boolean).join('\n\n')`；
  - 用户消息持久化后调用 `this.memory.captureUserMessage(userPrompt)`（不 `await`）。
- [x] `MemoryService.captureUserMessage()`：`memory-policy.ts` 的意图正则 + 排除正则 + 切句 + 最多 2 句；逐句调用 `write(sentence, ['explicit'])`；异常吞掉。
- [x] `session-entries.ts` 的 `injectedHeaders` 增加 `'## 长期记忆'`；`session-entries.test.cjs` 增加“以长期记忆头开头的历史条目被剥离”的用例。

验收：`composeModelPrompt` 输出形如 `<附件>\n\n## 长期记忆\n...\n\n## 用户输入\n<原句>`；快照清洗后只保留原句；低相关记忆不会进入注入块。

## T6 桌面端工具文案

- [x] `apps/desktop/src/features/agent/tool-activity-label.ts` 的 `TOOL_VERBS` 增加：
  - `memory_write: '记录记忆'`
  - `memory_search: '搜索记忆'`
  - `memory_list: '读取记忆'`
- [x] `apps/desktop/test/tool-activity-label.test.cjs` 增加三个工具的 running/completed 断言。

验收：`npm run test:agent-stream --workspace @teachforge/desktop` 通过。

## T6.5 记忆管理入口（若 T0 决策 2 为“需要”，与 T5 同批上线）

- [x] `apps/backend/src/memory/memory.controller.ts`：
  - `GET /api/memories`：active、最多 100 条，字段 `{ id, content, tags, createdAt, status }`；
  - `DELETE /api/memories/:id`：物理删除，404 表示不存在；
  - `DELETE /api/memories`：清空 active，返回删除数量。
- [x] `MemoryService` 增加 `listForUi()`、`deleteMemory(id)`、`clearMemories()`；写操作同样经过 `writeQueue`。
- [x] 设置页新增“长期记忆”区块：条目数、列表、单条删除、清空（二次确认）；渲染层不直接读文件。
- [x] 桌面 bridge 类型与 IPC 白名单补充对应路由（沿用现有设置请求通道）。

验收：设置页能看到刚写入的记忆；删除后 `memory_search` 不再命中；清空后注入块消失。

## T7 测试

- [x] `apps/backend/test/memory-policy.test.cjs`：`normalize()`、`polarity()` 中英文否定/肯定、意图与排除正则、切句上限。
- [x] `apps/backend/test/memory.test.cjs`（`node:test`，用确定性 stub embedding；另留一条真实 bge 用例）：
  1. 临时 `TEACHFORGE_CONFIG_DIR`：写入后文件位于 `<tmp>/memory/db0.sqlite`；
  2. 维度：`length(embedding)/4 === 512`（真实 bge）；
  3. 持久化：新实例重新检索仍命中；
  4. 去重：同文两次 → `duplicate`；
  5. **冲突**：先写“用英文标题”，再写“以后不要用英文标题” → `superseded`，旧行 `status='superseded'`，检索只返回新句；
  6. 排除：包含“掌握/正确率/密码”的句子不写入；
  7. 注入：无关句（stub 余弦 0.6）不进注入块；相关句（0.75）按日期排序、≤3 条、每条 ≤200 字；
  8. 失败隔离：embedding 抛错时 `buildChatContext` 返回 `''`、不抛错；
  9. 超时：pack 超过 1.5 s 时返回 `''`；
  10. 锁：模拟已有存活 PID 的 `.lock` → `disabledReason='locked'`，工具工厂返回 `undefined`；
  11. 备份：初始化后 `backup/db0-*.sqlite` 存在，最多 3 份。
- [x] `apps/backend/test/memory-extension.test.cjs`：假 `pi` 注册断言；`disabledReason` 时 execute 返回“记忆暂不可用”。
- [ ] 若实现 T6.5：`apps/backend/test/memory-http.test.cjs` 覆盖 GET/DELETE/清空与 404。
- [x] `apps/backend/package.json` 增加 `test:memory` 脚本（`tsc -p tsconfig.build.json --outDir .test-dist && node --test test/memory*.test.cjs`）。

验收：`npm run test:memory --workspace @teachforge/backend` 全绿；含真实 bge 的用例单独标记，允许较慢但不得依赖网络。

## T8 文档与回归

- [x] 更新 `docs/current/platform/agent-runtime.md`：
  - `MemoryService` 行改为已实现；
  - 扩展通道段落加入记忆工具；
  - allowlist 段落加入 `memory_*`；
  - 边界第 7 条改写为记忆目录、写入入口与快照清洗；
  - “第三方文件扩展”段落改为“无文件扩展，进程内工厂：持久化 + 记忆工具”。
- [x] 新增 `docs/current/domains/memory/index.md`（存储、schema、工具、注入阈值、写入/冲突规则、开关、失败行为、隐私边界、锁/备份、管理 API——若实现）。
- [x] 更新 `docs/current/platform/tech-stack.md` 后端依赖表。
- [x] 更新 `docs/current/index.md`、`docs/current/domains/README.md`。
- [x] 更新 `docs/changes/README.md` 表格与 `docs/manifest.yaml` 的 `long-term-memory` 路由。
- [x] 若记忆管理 API 落地：同步 `docs/current/domains/memory/api-contract.md`。
- [x] 在 `docs/decisions/` 记录一条长期决策：记忆引擎选择、本地嵌入、锁/备份策略，以及“产品 §15 完整模型后续单独实现”的边界。
- [x] 回归：`npm run test:agent-stream --workspace @teachforge/backend`、`npm run test:rehearsal --workspace @teachforge/backend`、`npm run test:session-entries --workspace @teachforge/backend`。

验收：文档链接与 frontmatter 自洽；三个既有测试套件不回归。
