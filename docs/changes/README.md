---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - change-record-lifecycle
related:
  - docs/README.md
  - docs/manifest.yaml
last_verified: 2026-11-06
---

# 变更记录

只有多轮实施、跨模块/共享契约影响、正式设计评审或 PR 级工作才建立 `YYYY-MM-DD-<slug>/` 变更目录。小型局部改动不创建流程负担，必要时直接更新 `current/`。

正式变更按需要包含 `brief.md`、`design.md`、`tasks.md`、`verification.md`、`worklog.md` 和 `reviews/`。结构与评审门槛遵循 `agent-runtime-docs` skill 的模板；模板并非已经复制到本仓库。变更落地后，将长期事实同步到对应 `current/` 文档。

## 当前设计记录

| 变更 | 责任单元 | 设计 |
|---|---|---|
| Agent 对话展示 | Agent 工具活动与流式回答的桌面呈现 | [设计](2026-11-07-agent-chat-presentation/design.md) · [验收](2026-11-07-agent-chat-presentation/verification.md) · [工作记录](2026-11-07-agent-chat-presentation/worklog.md) |
| Agent 单轮流式闭环 | 桌面端用户输入，经 Electron 安全桥接到 Agent/LLM 并流式显示回答 | [设计](2026-11-06-agent-streaming-loop/design.md) · [任务](2026-11-06-agent-streaming-loop/tasks.md) · [验收](2026-11-06-agent-streaming-loop/verification.md) |
