---
status: current
layer: platform
domain: engineering-insights
canonical_for:
  - postmortem-insight-index
related:
  - docs/index.md
  - docs/current/platform/agent-runtime.md
  - docs/postmortems/2026-11-15-waiting-progress-hidden-after-text.md
last_verified: 2026-11-15
---

# 故障复盘与复用经验

| Failure class | 假设错误 | 次数 | 示例 case | 当前护栏与强度 |
|---|---|---|---|---|
| IM-002 | 把连接层的瞬时失败（keep-alive socket 被对端关闭后仍被复用）当成业务失败，且缺少按请求名称与错误码取证 | 1 | [桌面桥接请求 ECONNRESET](2026-11-08-backend-request-econnreset.md) | `connection: close` + socket 级单次重试 + 中文错误 + 方法/路径/错误码日志；`test:backend-request` 5 项断言；**根因未确认**，护栏为机制性加固 |
| IM-001 | 静态类型/API/局部状态成功被误当成 UI 运行时契约正确；跨环境、跨进程观察进一步遮蔽故障边界 | 2 | [历史加载运行时失败](2026-11-07-conversation-history-runtime.md)；[聊天文件卡片终态丢失](2026-11-10-chat-artifact-footer-lifecycle.md) | 已升级为事件顺序回归：`artifact → done` 后仍可读取文件，历史接管才清除；仍需在新鲜 Electron bundle 中验收可见卡片与“文件”入口 |
| IM-003 | 把「已有内容输出」当成「仍在工作」的充分证据，忽略被过滤事件流的静默期；进行中 UI 用内容类别代替活性 | 1 | [文本流式后等待提示消失](2026-11-15-waiting-progress-hidden-after-text.md) | 等待行判据收敛到 `turn-progress.ts`（`working` 或静默 ≥1s）；`test:agent-stream` 固定 liveness 刷新与四种 phase/静默组合；A/B 切换条件写入 [ADR](../decisions/2026-11-15-chat-waiting-progress-signal.md) |

检索线索：HTTP 200 但 UI 失败、存储 DTO 到 UI 模型映射、Electron Main 请求观测、浏览器与桌面环境差异；`fetch failed`/`ECONNRESET`、keep-alive 复用、长 CPU 任务期间的连接重置；流式文本后的静默、`responding` 冻结、`thinking_delta`/`toolcall_delta` 被过滤、停止按钮与等待提示不同源。复盘完善不计为新事件；按同类假设错误的新事件累计复发次数。
