---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - current-document-routing
related:
  - docs/index.md
  - docs/current/platform/index.md
last_verified: 2026-11-08
---

# 当前实现文档

- [平台索引](platform/index.md)：Electron、React、NestJS 运行架构和代码放置指南。
- [Agent Runtime](platform/agent-runtime.md)：Agent、Pi SDK、SQLite 持久化与恢复流程、结构化诊断日志，以及 Agent 文件读写的安全边界。
- [业务域文档组织](domains/README.md)：当前业务行为文档的责任划分；业务行为经代码验证后再添加。
- [Conversation 对话持久化与历史读取](domains/conversations/index.md)：Agent 对话写入 SQLite、会话侧栏列表和选中会话消息读取的当前行为。
- [本机 Agent 设置](domains/system-settings/index.md)：模型 Provider、config.toml / SOULS.md 本地文件、默认 Agent workspace、设置 API 与新 session 配置行为。
- [跨领域约定目录](shared/README.md)：多个领域共用的稳定契约。
- [工程规则目录](rules/README.md)：长期、可执行的工程规则。
