---
status: current
layer: change
domain: long-term-memory
created_at: 2026-11-11
---

# 长期记忆实施记录

## 1. 已落地

| 范围 | 文件 |
|---|---|
| 依赖 | `@db0-ai/core@0.3.0`、`@db0-ai/backends-sqlite@0.3.0`（`apps/backend/package.json`、根 lock） |
| 目录与保护 | `SettingsService.getMemoryDirectory()`、`getManagedFilePaths()` 加入 `<configDir>/memory` |
| 引擎 | `memory-engine.ts`：动态 import、独占锁、每日备份、嵌入迁移、harness |
| 策略 | `memory-policy.ts`：意图/排除正则、中文极性、切句与候选上限 |
| 工具 | `memory-extension.ts`：`memory_write`/`memory_search`/`memory_list`，TypeBox schema，Pi 结果形状 |
| 服务 | `memory.service.ts`：注入块、统一写入、冲突覆盖、捕获、管理操作、预热与降级 |
| API | `memory.controller.ts` + `memory.module.ts`：`GET/DELETE /api/memories` |
| 会话装载 | `llm.service.ts`：`loadMemory`、`memory_*` allowlist、记忆系统提示规则 |
| 注入与捕获 | `chat.service.ts`：user prefix 记忆块、显式意图捕获、日志字段 |
| 快照清洗 | `session-entries.ts`：新增 `## 长期记忆` 注入头 |
| 桌面 | `SettingsPage.tsx` 长期记忆区块；`tool-activity-label.ts` 三个记忆动词；Electron 单实例锁 |

## 2. 默认决策（未收到产品书面确认）

1. 模型写入的 active 记忆直接参与回答，同时提供设置页查看/删除/清空作为纠错闭环；不实现候选状态。
2. 提供 `GET/DELETE /api/memories`，不提供 `PATCH`（编辑 = 删除后重新记录）。
3. 记忆不记录教学掌握度（排除正则拦截），与 `conversation_knowledge_facts` 分工。
4. 风格偏好仍以 SOULS.md 为唯一入口；注入块声明“当前指令 / SOULS 优先”。

## 3. 与设计文档的偏差

- `MemoryService.createToolExtension()` 不再接收 `conversationId`：v1 只写 user 作用域，`session_id` 恒为 NULL，传参没有语义。
- `disabledReason` 只区分 `locked` / `init_failed`；嵌入失败与初始化失败合并，避免重复加载模型。失败在进程内保持粘性，重启后重试。
- 自动捕获在 `ChatService` 持久化用户消息后触发，写入串行队列，失败只记 `memory.capture.failed`。
- 管理 API 的 GET 返回数组（最多 100 条），DELETE 单条返回 `{ deleted: 1 }`，清空返回 `{ deleted: n }`。

## 4. 验证证据

| 命令 | 结果 |
|---|---|
| `npm run test:memory --workspace @teachforge/backend` | 20 passed（含真实 bge 512 维、锁、备份、冲突覆盖、注入阈值、管理操作） |
| `npm run test:session-entries --workspace @teachforge/backend` | 7 passed |
| `npm run test:rehearsal --workspace @teachforge/backend` | 20 passed |
| `npm run test:agent-stream --workspace @teachforge/backend`（agent-stream 部分） | 14 passed |
| `npm run test:agent-stream --workspace @teachforge/desktop` | 11 passed |
| `npm run build --workspace @teachforge/backend` | 通过 |
| `npm run build:electron` + `tsc --noEmit -p tsconfig.app.json` | 通过 |

## 5. 顺带修复的既有测试漂移

以下两处测试在本次实施前已与当前实现不一致，为了让回归可运行一并修正：

- `agent-stream.test.cjs` 仍断言 `contextMessage`，当前 `ChatService` 传 `contextMessages`；
- 同一套件的 `knowledge` mock 仍是旧的 `buildContext`，当前 `ChatService` 调用 `KnowledgeDirectoryService.loadForAgent()`。

## 6. 未覆盖

- 未用真实模型跑一次插件装载；工具契约由假 `pi` 测试覆盖，`createSession` 装载路径由代码审查与构建保证。
- 未实现 `memory-http.test.cjs`：管理接口由服务层测试覆盖，HTTP 层尚未单独起 Nest 实例验证。
- 记忆召回质量仍需真实教师语料标定 0.65 阈值与意图正则。
