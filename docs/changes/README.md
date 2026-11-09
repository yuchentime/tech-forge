---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - change-record-lifecycle
related:
  - docs/README.md
  - docs/manifest.yaml
last_verified: 2026-11-08
---

# 变更记录

只有多轮实施、跨模块/共享契约影响、正式设计评审或 PR 级工作才建立 `YYYY-MM-DD-<slug>/` 变更目录。小型局部改动不创建流程负担，必要时直接更新 `current/`。

正式变更按需要包含 `brief.md`、`design.md`、`tasks.md`、`verification.md`、`worklog.md` 和 `reviews/`。结构与评审门槛遵循 `agent-runtime-docs` skill 的模板；模板并非已经复制到本仓库。变更落地后，将长期事实同步到对应 `current/` 文档。

## 当前设计记录

| 变更 | 责任单元 | 设计 |
|---|---|---|
| Local Knowledge Retrieval | 本地知识库：解析、分块、词法索引、向量化与双通道检索已实现；会话编排见下一条 | [简报](2026-11-08-knowledge-retrieval/brief.md) · [设计](2026-11-08-knowledge-retrieval/design.md) · [验收](2026-11-08-knowledge-retrieval/verification.md) · [工作记录](2026-11-08-knowledge-retrieval/worklog.md) |
| `/知识库` 斜杠注入 | 检索触发权归用户：命令解析、会话范围、整篇文档注入、token 预算、按版本去重与 `contextRefsJson`；删除 Agent 检索工具 | [简报](2026-11-09-knowledge-command-context/brief.md) · [验收](2026-11-09-knowledge-command-context/verification.md) |
| 知识库存储隔离 | 副本迁出 Agent workspace 到 `<configDir>/knowledge`，受保护目录子树拒绝读写，旧目录启动时迁移，`workspacePath` → `storedPath` | [简报](2026-11-09-knowledge-storage-isolation/brief.md) · [验收](2026-11-09-knowledge-storage-isolation/verification.md) |
| 知识库管理 | 侧栏知识库视图、文件导入到 workspace 并入库、资料列表与彻底删除（含后端 API 与 Electron 文件选择器） | [简报](2026-11-08-knowledge-base-management/brief.md) · [设计](2026-11-08-knowledge-base-management/design.md) · [验收](2026-11-08-knowledge-base-management/verification.md) |
| Document Parser Adapter | 不依赖会话或知识库业务的本地文档/图片解析适配层；v1 文本层提取（PDF/DOCX/MD/TXT），MinerU 保留为升级路径 | [设计](2026-11-08-document-parser-adapter/design.md) · [验收](2026-11-08-document-parser-adapter/verification.md) · [工作记录](2026-11-08-document-parser-adapter/worklog.md) |
| Conversation Tool Activity History | 历史 API 将已持久化工具摘要附于 user turn，并在桌面切换/翻页时恢复活动 UI | [简报](2026-11-08-conversation-tool-activity-history/brief.md) · [设计](2026-11-08-conversation-tool-activity-history/design.md) · [验收](2026-11-08-conversation-tool-activity-history/verification.md) · [工作记录](2026-11-08-conversation-tool-activity-history/worklog.md) |
| Chat API Rename | Chat 流式 API、NestJS 模块命名与 Electron bridge 契约 | [简报](2026-11-08-chat-api-rename/brief.md) · [工作记录](2026-11-08-chat-api-rename/worklog.md) |
| Agent Flow Structured Logging | Agent HTTP、对话持久化、Pi/LLM 与工具流程的关联诊断日志 | [设计](2026-11-07-agent-flow-logging/design.md) · [验收](2026-11-07-agent-flow-logging/verification.md) · [工作记录](2026-11-07-agent-flow-logging/worklog.md) |
| Conversation History Sidebar | Conversation 列表 API、历史消息 API 与桌面端会话选择/恢复 | [设计](2026-11-07-conversation-history-sidebar/design.md) · [验收](2026-11-07-conversation-history-sidebar/verification.md) · [工作记录](2026-11-07-conversation-history-sidebar/worklog.md) · [交接](2026-11-07-conversation-history-sidebar/handoff.md) |
| Agent Chat Layout and History Pagination | Agent 全屏两栏布局、滚动边界与按需读取历史 | [设计](2026-11-07-agent-chat-layout-history-pagination/design.md) · [验收](2026-11-07-agent-chat-layout-history-pagination/verification.md) · [任务](2026-11-07-agent-chat-layout-history-pagination/tasks.md) · [工作记录](2026-11-07-agent-chat-layout-history-pagination/worklog.md) |
| Conversation Session Persistence | Agent 对话通过 SQLite 消息记录恢复 Pi SDK 上下文 | [设计](2026-11-07-conversation-session-persistence/design.md) · [验收](2026-11-07-conversation-session-persistence/verification.md) · [工作记录](2026-11-07-conversation-session-persistence/worklog.md) |
| Agent 对话展示 | Agent 工具活动与流式回答的桌面呈现 | [设计](2026-11-07-agent-chat-presentation/design.md) · [验收](2026-11-07-agent-chat-presentation/verification.md) · [工作记录](2026-11-07-agent-chat-presentation/worklog.md) |
| 本机 Agent 设置 | 本机模型 Provider、config.toml 与 SOULS.md 风格偏好 | [设计](2026-11-07-local-agent-settings/design.md) · [任务](2026-11-07-local-agent-settings/tasks.md) · [验收](2026-11-07-local-agent-settings/verification.md) · [工作记录](2026-11-07-local-agent-settings/worklog.md) |
| 本机工作空间设置 | 默认在 `.tech-forge/workspace/` 保存 Agent 产物；分离任意来源读取与受限写入，并允许本轮明确指定的一次性外部目标 | [设计](2026-11-07-local-workspace-setting/design.md) · [任务](2026-11-07-local-workspace-setting/tasks.md) · [验收](2026-11-07-local-workspace-setting/verification.md) · [工作记录](2026-11-07-local-workspace-setting/worklog.md) |
| Agent 单轮流式闭环 | 桌面端用户输入，经 Electron 安全桥接到 Agent/LLM 并流式显示回答 | [设计](2026-11-06-agent-streaming-loop/design.md) · [任务](2026-11-06-agent-streaming-loop/tasks.md) · [验收](2026-11-06-agent-streaming-loop/verification.md) |
