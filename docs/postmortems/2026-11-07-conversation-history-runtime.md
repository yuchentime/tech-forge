---
status: historical
layer: postmortem
domain: conversations
created_at: 2026-11-07
last_verified: 2026-11-07
canonical_for:
  - conversation-history-runtime-contract-incident
related:
  - docs/postmortems/index.md
  - docs/changes/2026-11-07-conversation-history-sidebar/verification.md
  - docs/current/platform/agent-runtime.md
---

# 2026-11-07 历史消息转换运行时失败

## Summary

历史加载失败的直接原因是 DTO 转换违反 UI 依赖的运行时契约：接口返回 200，Renderer 却因给 user 消息附加 `status` 而在 LocalRuntime reset 时抛错。只给 assistant 设置状态后，真实 Electron 的读取、切换和重启恢复通过。

更有复用价值的教训是：诊断应沿真实运行入口和请求所属进程取证，以“选中会话后正文可见”为完成信号。编译、HTTP 和局部环境检查各自只证明一个边界；错误提示改善也不能替代原问题修复。

## Impact

包含用户消息的会话无法在桌面恢复，通用错误提示把转换失败表现为历史读取失败。此前增加浏览器提示和 404 处理没有解除这一失败路径，用户需要再次交接修复。

本轮没有发现或修复用户历史数据丢失；空数据库观察和旧摘要来源仍不能由本次结论解释。影响时长及受影响会话数量没有可靠统计，不作估算。

## Trigger

用户根据 [交接记录](../changes/2026-11-07-conversation-history-sidebar/handoff.md) 要求修复尚未解决的验收问题。

## Facts

- 独立 SQLite 数据目录中放入两个 user/assistant 会话，通过真实 Electron 点选复现。
- 历史 bridge 返回 HTTP 200、合法有序 DTO；不是 bridge 缺失或未知会话。
- Debugger 捕获 `status is only supported for assistant messages`，栈经过 `fromThreadMessageLike`、`ExportedMessageRepository.fromArray`、LocalRuntime reset。
- 原转换器对所有角色设置 status；安装包的 ThreadMessageLike 静态类型允许，但运行时有角色校验。
- 修复前实际包回归 2/4 失败，修复后 4/4 通过，真实桌面选中、切换、重启恢复通过。

| 关键证据 | 可以推出 | 不能推出 |
|---|---|---|
| 普通 Chrome 中 `window.teachforge` 不存在 | 该页面不能走 Electron preload bridge | Electron 窗口也因 bridge 缺失而失败 |
| 某个 userData 数据库没有消息 | 该文件在查询时没有历史 | 当前窗口必然连接此文件、所选 ID 必然返回 404 |
| 同一次 Electron bridge 调用返回 200 和预期 DTO | 本次 HTTP 读取已成功 | 数据转换、runtime reset 和可见渲染也已成功 |
| 捕获到转换器角色校验异常 | 本次失败发生在客户端消费阶段 | 所有“历史加载失败”都属于同一原因 |
| 修改角色映射后原复现转绿 | 修复针对已复现的失败路径有效 | 真实模型续聊、缺失数据恢复也已验证 |

证据入口：[L003 验收记录](../changes/2026-11-07-conversation-history-sidebar/verification.md#l003--actual-electron-history-regression)、[生产转换器](../../apps/desktop/src/features/agent/conversation-history.ts)、[实际包回归](../../apps/desktop/test/conversation-history.test.cjs)。

## Root Cause

**技术根因**：存储/API 为 user 和 assistant 都提供终态字段，UI 依赖却仅允许 assistant 携带 `status`。原转换器把同名字段视为同义字段；`ThreadMessageLike` 静态类型没有排除无效的 role/status 组合，编译因此没有发现问题。

**诊断延误的条件**：

1. 普通 Chrome 的 bridge 检查与 Electron 失败来自不同运行环境。前者解释了浏览器预览受限，未覆盖用户在桌面端的症状。
2. 空数据库与 404 是有待关联到同一进程、同一 ID 的假设。交接时缺少实际状态码，无法排除 HTTP 成功后的客户端失败。
3. `loadConversation()` 的 try/catch 同时包住 request、映射和 `thread.reset()`；日志统一使用 `history_request_failed`，仅凭分类名称看不出失败阶段。即使 `errorName` 为 Error，也不足以定位依赖内部的角色约束。
4. 原交接建议在 Renderer DevTools Network 查历史 HTTP 请求，但 [Preload](../../apps/desktop/electron/preload/preload.ts) 实际通过 IPC 调用 [Main 的 fetch](../../apps/desktop/electron/main/main.ts)。取证必须覆盖请求所属进程；Renderer Network 不能独立证明 Main 是否发出请求。

这些是代码与交接证据支持的诊断缺口，不推断协作者的主观判断或能力。

## Fix

把转换器提取到 `conversation-history.ts`，user 只传 ID、角色、文本和时间；assistant 额外映射完成/失败/取消状态。不改变 API 或 SQLite 格式。

定位路径先使用独立 SQLite 数据目录和真实 Electron 复现，再捕获被 catch 的异常栈；锁定角色约束后，将生产转换器送入安装包实际使用的 `ExportedMessageRepository.fromArray()`。该回归先失败再通过，最后返回完整桌面入口验证。整个历史读取复现不需要调用模型或获取 API key。

## Insight

| 可复用洞察 | 本案依据 | 下次如何执行 |
|---|---|---|
| 同名字段跨层可能有不同语义 | 存储 status 适用于所有消息，UI status 只适用于 assistant | 为角色、状态、附件等组合约束显式转换；使用真实消费方校验，不能只检查 JSON 字段是否齐全 |
| 观察工具必须匹配执行进程 | HTTP 在 Main，页面状态在 Renderer | 先画出调用边界；联合 bridge 返回值、Main/backend 证据和 Renderer 异常定位，避免只看一个 Network 面板 |
| 复现环境是证据的一部分 | 浏览器 bridge 缺失与桌面转换异常并存 | 记录入口、进程、数据目录、会话 ID；来自不同环境的观察不可直接组成一条因果链 |
| 成功信号必须到达用户目标 | HTTP 200 后仍然看不到历史正文 | 同时断言数据契约与可见正文；切换后确认旧正文消失，重启后确认活动会话恢复 |
| 最小复现应切掉无关依赖 | 固定 user/assistant 数据足以触发失败 | 用独立 SQLite 样本保留真实 IPC/HTTP/UI 链路，排除模型网络和用户数据差异；不要把关键消费方 mock 掉 |
| 修复后保留能再次变红的检查 | 只断言转换对象外形容易重复实现者的错误假设 | 生产转换器接真实库，保留失败前后结果；局部回归与完整入口验证分别报告覆盖范围 |
| 通用提示不等于根因分类 | request 与 reset 共享 catch，HTTP 200 仍记录 request_failed | 排查时先识别最后成功阶段，再查看下一阶段异常；正式日志改进应分阶段且保持脱敏 |

有效检查顺序：确认真实入口与进程 → 确认数据来源 → 获取 bridge/HTTP 结果 → 捕获 DTO 消费或 reset 异常 → 验证可见正文。它是缩小故障范围的方法，不要求每次盲目检查所有层。

## Failure Class And Recurrence

- Failure class id: `IM-001` — 静态类型/API 成功被误当成 UI 运行时契约正确。
- Recurrence count: `1`（首次建立复盘索引；不凭未归类的历史推断次数）。
- 本次是完善同一事件的复盘，不新增事件、不增加复发次数；运行环境和观测进程问题作为促成因素记录。
- Prior cases in this class: 无已登记 case。
- Escalation required by count: 文档与验收护栏；本次进一步增加实际包自动测试。

## Guardrails

- Documentation update: [Agent Runtime](../current/platform/agent-runtime.md) 明确状态角色边界。
- Rule update: [AC-04 与 Known Guardrails](../changes/2026-11-07-conversation-history-sidebar/verification.md#known-guardrails) 固化真实入口、同源证据、HTTP 200 后消费阶段检查和原失败可复现要求。
- Test update: `apps/desktop/test/conversation-history.test.cjs` 用实际安装包转换器检验生产映射，禁止只比对手写 mock。
- Script update: `npm run test:conversation-history --workspace @teachforge/desktop`。
- Manifest route update: conversation-history-sidebar 收录回归测试和本复盘。

| 措施 | 当前状态 | 验证边界 / 后续触发条件 |
|---|---|---|
| 角色映射与实际库转换回归 | 已实现；4/4 通过，见 L003 | 检验消费方契约，不覆盖 Electron 启动与 IPC |
| 独立数据目录中的 Electron 全链路验收 | 已执行；见 L003 | 通过交互式自动化完成，尚未固化为仓库内一键 E2E 脚本，不能描述为持续 CI 覆盖 |
| 诊断分阶段取证检查单 | 已写入 Known Guardrails | 后续历史加载故障按检查单记录证据；无须为每次排查新增日志系统 |
| request/convert/reset 的安全错误分类 | 建议，未实现 | 下次修改该错误处理时考虑；不记录正文、原始 payload、token 或任意异常 message |

本轮仅完善复盘和验收护栏，沿用已有运行证据，没有重新执行产品测试，也没有新增错误分类或 E2E 基础设施。

## Not Generalized

普通 Chrome 没有桌面 bridge 仍是预期边界；不能据此关闭认证。交接时空数据库不代表历史转换异常由数据丢失引起，也不证明本次修复恢复了缺失的数据。

`status` 的具体角色限制属于当前 assistant-ui 契约，不能推广成所有聊天库的规则。通用经验是核验实际消费方；不要因此建立通用转换框架、扩展浏览器访问能力或迁移数据库。依赖构建警告、文档检查器命名冲突和最小窗口布局问题另有边界，不并入本次故障根因。
