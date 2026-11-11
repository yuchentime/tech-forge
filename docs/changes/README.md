---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - change-record-lifecycle
related:
  - docs/README.md
  - docs/manifest.yaml
last_verified: 2026-11-10
---

# 变更记录

只有多轮实施、跨模块/共享契约影响、正式设计评审或 PR 级工作才建立 `YYYY-MM-DD-<slug>/` 变更目录。小型局部改动不创建流程负担，必要时直接更新 `current/`。

正式变更按需要包含 `brief.md`、`design.md`、`tasks.md`、`verification.md`、`worklog.md` 和 `reviews/`。结构与评审门槛遵循 `agent-runtime-docs` skill 的模板；模板并非已经复制到本仓库。变更落地后，将长期事实同步到对应 `current/` 文档。

## 当前设计记录

| 变更 | 责任单元 | 设计 |
|---|---|---|
| DeepSeek 网页搜索与抓取工具（已实施） | DeepSeek Search/Fetch 作为 `web_search`/`web_fetch` 自定义工具；普通聊天与 `/探索主题` 可用，`generate()` 禁用；内置 skill 支持资料库 + 网络证据；输出截断、重试、取消与隐私日志 | [简报](2026-11-11-deepseek-web-tools/brief.md) · [设计](2026-11-11-deepseek-web-tools/design.md) · [任务](2026-11-11-deepseek-web-tools/tasks.md) · [验收](2026-11-11-deepseek-web-tools/verification.md) |
| 长期记忆（已实施） | db0 core + SQLite（`<configDir>/memory/db0.sqlite`）、本地 bge 512 维嵌入、`memory_*` 工具、每轮 user 前缀注入、显式意图写入、设置页管理；不装 `@db0-ai/pi` | [简报](2026-11-11-long-term-memory/brief.md) · [设计](2026-11-11-long-term-memory/design.md) · [任务](2026-11-11-long-term-memory/tasks.md) · [验收](2026-11-11-long-term-memory/verification.md) · [实施记录](2026-11-11-long-term-memory/worklog.md) |
| `/探索主题` 斜杠命令 | 固定先检索知识库，再用内置 `deep-research` Pi skill 生成知识文档与自包含 SVG 知识地图；不新增 Agent/表，产物按普通会话 artifact 登记 | [简报](2026-11-10-deep-research-command/brief.md) · [设计](2026-11-10-deep-research-command/design.md) · [验收](2026-11-10-deep-research-command/verification.md) |
| Chat 截断语义与实时文件卡片（待评审） | 输出上限/内部取消的终态与消息行状态一致；线程结束后保留实时文件卡片，历史加载时按会话去重 | [交接](2026-11-10-chat-truncation-and-artifact-footer/handoff.md) |
| 会话知识掌握卡片 | 三种掌握状态的会话卡片、摘要/详情和会话跳转；轻量列表读取，详情按需读取 | [简报](2026-11-10-knowledge-session-cards/brief.md) · [设计](2026-11-10-knowledge-session-cards/design.md) · [验收](2026-11-10-knowledge-session-cards/verification.md) · [实施记录](2026-11-10-knowledge-session-cards/worklog.md) |
| 会话知识掌握事实（已实现，L3 待补） | 一会话一条事实；报告后异步更新、时间序列归纳、上下文截断与持久化待处理状态；只读查询接口 | [简报](2026-11-10-conversation-knowledge-facts/brief.md) · [设计](2026-11-10-conversation-knowledge-facts/design.md) · [API](2026-11-10-conversation-knowledge-facts/api-contract.md) · [验收](2026-11-10-conversation-knowledge-facts/verification.md) · [任务](2026-11-10-conversation-knowledge-facts/tasks.md) · [worklog](2026-11-10-conversation-knowledge-facts/worklog.md) · [技术评审 PASS](2026-11-10-conversation-knowledge-facts/reviews/design-review.md) · [实施评审](2026-11-10-conversation-knowledge-facts/reviews/L001.md) |
| 目录驱动的自主资料库查阅（设计中） | 上传时生成结构化摘要并原子维护 `knowledge/index.md`；固定 AGENTS 引导 Agent 自主或强制地读取目录/原文；停用新向量与全文索引写入但保留旧模块观察 | [简报](2026-11-10-directory-knowledge-library/brief.md) · [设计](2026-11-10-directory-knowledge-library/design.md) · [任务](2026-11-10-directory-knowledge-library/tasks.md) · [验收](2026-11-10-directory-knowledge-library/verification.md) · [实施交接](2026-11-10-directory-knowledge-library/handoff.md) |
| 演练模式（已实现） | 独立 Rehearsal 状态机；学生画像；15 问总限额与单题 2 次追问；跳过/手动结束/上限报告；历史演练列表与只读详情；普通对话摘要注入，报告从演练模式历史查看 | [简报](2026-11-09-rehearsal-mode/brief.md) · [设计](2026-11-09-rehearsal-mode/design.md) · [任务](2026-11-09-rehearsal-mode/tasks.md) · [验收](2026-11-09-rehearsal-mode/verification.md) · [实施记录](2026-11-09-rehearsal-mode/worklog.md) |
| 演练评估一次性投递 | 摘要不再每轮拼进 user 消息：`loadedContext` 只放行未投递的已完成演练，摘要以 `custom_message` entry 进入 Pi 上下文并随快照持久化，不参与快照清洗 | [简报](2026-11-09-rehearsal-digest-delivery/brief.md) · [设计](2026-11-09-rehearsal-digest-delivery/design.md) · [验收](2026-11-09-rehearsal-digest-delivery/verification.md) |
| 开始演练延迟与等待体验（已实施） | 独立准备画面（真实阶段进度条 + 状态文案，无时长显示）、只读阶段端点与轮询、A2 竞态守卫、等价 detail 组装；session 引导裁剪、异步 start、模型输入调整仍待单独批准 | [简报](2026-11-10-rehearsal-start-latency/brief.md) · [设计](2026-11-10-rehearsal-start-latency/design.md) · [验收](2026-11-10-rehearsal-start-latency/verification.md) |
| 学生画像本地持久化 | 画像存 `<configDir>/rehearsal-persona.txt`（不建表、跨会话共用），进入演练模式读取，编辑器失焦原子写回 | [简报](2026-11-10-rehearsal-persona-persistence/brief.md) · [验收](2026-11-10-rehearsal-persona-persistence/verification.md) |
| 多会话并行 | 生成中的会话不阻塞切换/新建/发送；每会话独立 `LocalRuntime` 与历史，切走后后台生成继续；运行态按会话隔离；运行中的会话不可删除 | [简报](2026-11-09-concurrent-conversations/brief.md) · [设计](2026-11-09-concurrent-conversations/design.md) · [设计评审：PASS_WITH_WARNINGS](2026-11-09-concurrent-conversations/reviews/index.md) |
| Local Knowledge Retrieval | 本地知识库：解析、分块、词法索引、向量化与双通道检索已实现；会话编排见下一条 | [简报](2026-11-08-knowledge-retrieval/brief.md) · [设计](2026-11-08-knowledge-retrieval/design.md) · [验收](2026-11-08-knowledge-retrieval/verification.md) · [工作记录](2026-11-08-knowledge-retrieval/worklog.md) |
| `/知识库` 斜杠注入 | 检索触发权归用户：命令解析、会话范围、整篇文档注入、token 预算、按版本去重与 `contextRefsJson`；删除 Agent 检索工具 | [简报](2026-11-09-knowledge-command-context/brief.md) · [验收](2026-11-09-knowledge-command-context/verification.md) |
| 会话附件 | 发送时复制进 `sessions/<会话ID>/attachments/<附件ID>/` 并解析写 `text.md`；本轮材料拼进 user message（40k 字符上限），快照保存前还原为纯用户文本；消息只保留 `{attachmentId, name}` 用于标签；不入资料库 | [简报](2026-11-09-chat-attachments/brief.md) · [设计](2026-11-09-chat-attachments/design.md) · [验收](2026-11-09-chat-attachments/verification.md) |
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
