---
status: current
layer: change
domain: long-term-memory
created_at: 2026-11-11
---

# 长期记忆（db0 + 本地 bge）Brief

## Problem

`pi-memory` 扩展已在 `refactor(llm): remove the pi-memory extension`（`c76c018`）中整体移除：

- `apps/backend/src/memory/` 只剩空壳 `MemoryService`，不注册工具、不读写存储、不改系统提示词；
- `LlmService.createSession()` 的扩展通道只剩进程内持久化工厂，工具 allowlist 为 `read`/`edit`/`write`/`grep`/`find`/`ls`；
- 模型没有跨会话记忆：用户偏好、身份、长期要求只能靠每轮重复或 `SOULS.md` 静态文本；
- 文档已在 [Agent Runtime](../../current/platform/agent-runtime.md) 明确“长期记忆尚未实现”，本变更负责把该行改成真实实现。

同时，知识库已经有一套可直接复用的本地向量能力：

- `EmbeddingService` 用 `@huggingface/transformers` + 打包的 `bge-small-zh-v1.5`（ONNX `q8`，512 维，CLS pooling + L2 normalize）；
- 模型完全本地，运行时 `allowRemoteModels = false`，不产生任何 embedding API 调用。

## Decision / Scope

1. **引擎选 db0 的 core 层，不装 `@db0-ai/pi`**。`@db0-ai/pi@0.3.0` 与 Pi SDK 1.5 不兼容：工具用 `inputSchema` 而非 `parameters`（loader 会直接抛错）、`execute` 签名与返回值都不匹配、两个生命周期钩子读错事件参数。我们只依赖 `@db0-ai/core` 与 `@db0-ai/backends-sqlite`，工具注册和上下文注入由本仓库自己写。
2. **存储固定为 SQLite 单文件**：`<configDir>/memory/db0.sqlite`（`configDir` 默认 `~/.tech-forge`，受 `TEACHFORGE_CONFIG_DIR` 重定位）。新增 `SettingsService.getMemoryDirectory()`，并把该目录加入受保护路径，阻止文件工具读写。
3. **嵌入直接注入现有 `EmbeddingService`**：`embeddingFn = embedOne`、`batchEmbeddingFn = embed`。512 维、CLS、归一化与知识库一致；记忆库不引入第二个模型、不引入 llama.cpp / ONNX 之外的运行时。
4. **模型工具**：`memory_write`、`memory_search`、`memory_list`，经 `DefaultResourceLoader.extensionFactories` 的进程内扩展注册；工具参数使用 `typebox`（仓库已声明，Pi 同版本）。
5. **上下文注入走 user message 的 `promptContext`，不改系统提示词**。`ChatService` 在每轮把记忆块拼进 per-turn 材料，`## 用户输入` 之前的材料在快照清洗中被剥离；系统提示词保持跨轮稳定，不破坏 provider 前缀缓存。
6. **写入有两条明确入口**：
   - 模型主动调用 `memory_write`（系统提示词增加一条使用规则）；
   - 应用侧只对**显式记忆意图**的中文句子自动写入（“记住…”“以后都…”“每次…”“不要再用…”等），每轮最多 2 句，不做 LLM 抽取。
7. **不污染内部 JSON 调用**：`stream()` 默认装载记忆；`generate()`（演练、知识事实等）默认不装载，且 `tools: []` 时不注入记忆。
8. **记忆按用户全局共享**，不按会话隔离，不随会话删除；会话作用域在本项目“每请求新建 Pi session”的模型下没有稳定语义，v1 不使用。

## Out Of Scope

- LLM 自动事实抽取、记忆合并/整理、遗忘曲线、语义去重以外的清理策略；
- 记忆管理 UI、设置页开关、记忆导入/导出、`@db0-ai/inspector`；
- Markdown 作为记忆源文件（`sqlite-memory` 路线）、文件/目录同步、跨设备 CRDT 同步；
- `sqlite-vector` / ANN 索引、自写 `Db0Backend`、量化；
- 记忆删除工具与 `supersedes` 编辑入口（v1 只支持去重和冲突检测，不开放人工纠错）；
- 演练模式共享记忆（演练必须保持学生角色隔离）；
- **功能设计文档 §15 的完整长期记忆模型**：教师/课程/班级/经验四类记忆、候选/确认状态、`GET /api/memories`、`PATCH /api/memories/:id`、`memory_sources` 与能力等级投影。v1 只实现“教师 user 作用域事实”的最小闭环，差异与风险见 [design.md §14](design.md#14-产品范围差异与上线风险)。

## Acceptance 概要

- 后端启动后无需任何配置即可聊天；记忆库文件在首次写入时创建于 `<configDir>/memory/db0.sqlite`。
- 聊天系统提示词不包含记忆内容；每轮模型输入在 `## 用户输入` 之前多出 `## 长期记忆` 块，且该块不进入 SQLite 消息、不残留在下一轮快照。
- 模型可见 `memory_write` / `memory_search` / `memory_list` 三个工具；工具结果符合 Pi `AgentToolResult` 形状。
- 用户说“记住，我以后都用简体中文”后，同义查询（“我喜欢用什么语言”）在下一轮命中；重启后端仍命中。
- 无关语句（“帮我看看这道题”）不写入记忆；重复内容写入返回 `duplicate`。
- 先写“用英文标题”、再写“以后不要用英文标题”时，旧记忆变为 `superseded`，检索与注入只返回新句。
- 注入只取相关度 ≥0.65 的 top 3（每条 ≤200 字）；无关记忆不进入模型输入。
- 第二个应用实例不会覆盖第一个实例写入的记忆（单实例锁或记忆库锁生效）。
- 记忆对演练与知识事实 JSON 调用不可见；`generate({ tools: [] })` 不注册记忆工具、不注入上下文。
- 嵌入模型不可用或记忆库损坏时，聊天照常进行：仅跳过注入、工具返回失败，不阻断回答。
- 记忆目录对 `read`/`grep`/`write` 等文件工具返回策略拒绝。

## 验证

见 [verification.md](verification.md)。
