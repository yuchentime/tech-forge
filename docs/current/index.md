---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - current-document-routing
related:
  - docs/index.md
  - docs/current/platform/index.md
last_verified: 2026-11-10
---

# 当前实现文档

- [平台索引](platform/index.md)：Electron、React、NestJS 运行架构和代码放置指南。
- [技术栈](platform/tech-stack.md)：运行链路实际使用的依赖、声明与安装版本、存储/嵌入/解析选型，以及声明但未接入的遗留项与升级约束。
- [Agent Runtime](platform/agent-runtime.md)：Agent、Pi SDK、SQLite 持久化与恢复流程、扩展装载（含 `pi-memory` 记忆工具与记忆注入）、结构化诊断日志，以及 Agent 文件读写的安全边界。
- [业务域文档组织](domains/README.md)：当前业务行为文档的责任划分；业务行为经代码验证后再添加。
- [Conversation 对话持久化与历史读取](domains/conversations/index.md)：Agent 对话写入 SQLite、会话侧栏列表和选中会话消息读取的当前行为。
- [演练模式](domains/rehearsals/index.md)：独立 Rehearsal 状态机、15 问限额、学生画像、逐题/总体评估、历史列表，以及普通对话 digest 同步。
- [知识掌握](domains/knowledge-profile/index.md)：按会话展示掌握状态、评估摘要和详情；当前使用只读 mock 数据。
- [资料入库](domains/documents/index.md)：本机文件解析、500-token 分块、词法索引与向量写入、入库状态机、知识库导入/删除 API 与读取模型。
- [知识库检索](domains/retrieval/index.md)：词法 + 向量双通道、RRF 融合、单字回退、可选查询扩展，以及 `/查询资料库` 命令触发的分片注入、去重与注入位置（user message，而非 system prompt）。
- [Artifact 会话产出文件](domains/artifacts/index.md)：模型写入文件的登记、`session`/`external` 路径解析、预览与删除记录接口，以及文件侧边栏（缺失文件的记录可删除）。
- [本机 Agent 设置](domains/system-settings/index.md)：模型 Provider、config.toml / SOULS.md 本地文件、默认 Agent workspace、设置 API 与新 session 配置行为。
- [跨领域约定目录](shared/README.md)：多个领域共用的稳定契约。
- [工程规则目录](rules/README.md)：长期、可执行的工程规则。
