---
status: accepted
layer: decision
domain: memory
canonical_for:
  - long-term-memory-engine-decision
decided_at: 2026-11-11
---

# 长期记忆引擎与本地嵌入

## Context

`pi-memory` 已移除，产品需要跨会话长期记忆。已有约束：

- 产品按单人 Personal Agent 建模，数据留在本机；
- 知识库已经内置 `bge-small-zh-v1.5`（ONNX q8，512 维，CLS + normalize），不允许新增远程 embedding API；
- 所有应用状态位于 `<configDir>`（默认 `~/.tech-forge`），Agent 文件工具对它只有受限访问；
- Pi session 每请求重建，`session`/`task` 作用域没有稳定语义。

## Decision

1. **引擎**：使用 `@db0-ai/core` + `@db0-ai/backends-sqlite`（0.3.0），不安装 `@db0-ai/pi`。
   - `@db0-ai/pi@0.3.0` 与 Pi SDK 1.5 不兼容（工具 schema 字段、execute 签名、事件参数均错），装载即失败。
   - 仅使用 db0 的 `memory`/`context` 能力；state/log 不写。
2. **嵌入**：通过 `HarnessConfig.embeddingFn` / `batchEmbeddingFn` 注入现有 `EmbeddingService`；`db0_meta.embedding_id = local:bge-small-zh-v1.5:512`，变化时走 `migrateEmbeddings`。
3. **存储**：`<configDir>/memory/db0.sqlite`；独占锁 `.lock` + 每日备份 3 份；写操作串行化。sql.js 每次写整库覆盖的代价由“少量写入 + 不写 log/state”控制。
4. **作用域**：只写 `user`，`agent_id=teachforge`、`user_id=local-user`、`session_id=NULL`；删除会话不影响记忆。
5. **注入**：不改系统提示词；`ChatService` 把 `## 长期记忆` 块拼进 per-turn user prefix，快照清洗负责剥离。阈值 0.72、top 2、每条 150 字、1.5 s 超时；捕获排在检索之后，注入头由 `memory-context.ts` 统一导出（见 [注入边界 ADR](2026-11-11-memory-injection-boundary.md)）。
6. **写入**：模型工具 + 显式中文意图捕获；写入前做精确去重与中文极性冲突判定，必要时 `supersedes`；教学掌握度、凭据、一次性任务与风格不写入。
7. **失败**：锁冲突、引擎或嵌入不可用时整体禁用，聊天继续；管理入口为 `GET/DELETE /api/memories` 与设置页列表。

## Alternatives

| 方案 | 未采用原因 |
|---|---|
| `@db0-ai/pi` | 与当前 Pi SDK 不兼容，无已修复版本 |
| `sqlite-memory`（llama.cpp GGUF） | 需要第二套嵌入运行时与 GGUF 模型；无预计算向量入口，记忆模型是文本块而非作用域事实 |
| db0 默认 hash embedding | 非语义，中文不可用 |
| 把记忆注入系统提示词 | 破坏 provider 前缀缓存；与会话/附件约定冲突 |
| 直接写主 SQLite 表 | 会与产品 `memory_sources`、候选/确认模型绑定，超出本次最小闭环 |

## Consequences

- 产品 `功能设计文档` §15 的课程/班级/经验记忆、候选/确认、来源表与能力等级投影仍未实现；当前只覆盖教师偏好/身份类事实，差异记录在变更设计 §14。
- sql.js 是单写者假设：多实例通过 Electron 单实例锁 + 记忆库锁阻止；长期若记忆量增长，需要评估 `better-sqlite3` 自写 `Db0Backend`。
- 移除记忆或删除会话不会自动清理已记录事实；教师通过设置页显式删除。
