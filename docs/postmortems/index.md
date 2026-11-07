---
status: current
layer: platform
domain: engineering-insights
canonical_for:
  - postmortem-insight-index
related:
  - docs/index.md
  - docs/current/platform/agent-runtime.md
last_verified: 2026-11-07
---

# 故障复盘与复用经验

| Failure class | 假设错误 | 次数 | 示例 case | 当前护栏与强度 |
|---|---|---|---|---|
| IM-001 | 静态类型/API 成功被误当成 UI 运行时契约正确；跨环境、跨进程观察进一步遮蔽故障边界 | 1 | [历史加载运行时失败](2026-11-07-conversation-history-runtime.md) | [AC-04 与诊断检查单](../changes/2026-11-07-conversation-history-sidebar/verification.md#known-guardrails)、[Agent Runtime](../current/platform/agent-runtime.md)；实际包自动回归已实现，Electron 联动已验证但未固化一键 E2E |

检索线索：HTTP 200 但 UI 失败、存储 DTO 到 UI 模型映射、Electron Main 请求观测、浏览器与桌面环境差异。复盘完善不计为新事件；按同类假设错误的新事件累计复发次数。
