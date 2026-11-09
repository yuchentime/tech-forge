---
status: approved
layer: change
review_type: design_review
created_at: 2026-11-09
design_path: docs/changes/2026-11-09-concurrent-conversations/design.md
verdict: PASS
confirmation_status: approved
---

# Design Review: 多会话并行（后台生成）

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-09-concurrent-conversations/design.md` |
| Verdict | PASS |
| confirmation_status | approved |
| DESIGN_REVIEW_PASS | passed |

首次评审为 FAIL。用户要求直接优化后，设计已闭合草稿身份、删除互斥、历史响应与导航边界。2026-11-09 实施请求明确授权继续；实施前以当前可安装的 `@assistant-ui/react` 0.15.33 源码复核了 `useRemoteThreadListRuntime`。其内部线程列表固定启用 `backgroundThreads: true`，已访问线程在删除或适配器替换前保持挂载；`RemoteThreadList` 以稳定 adapter 引用合并列表条目。根锁文件与清单不同步，不能声称这是 package-lock 锁定安装；该基线问题记录在 verification，不改变本设计结论。

## Scope Anchor

- Original ask: 对本变更进行功能设计评审；先评审，再按用户“直接进行方案优化”修订设计；不实现功能。
- Design goals in scope: 同一 renderer 生命周期内跨会话并行，切换不取消生成，输入/历史/活动/产物隔离，当前会话停止与运行会话删除保护。
- Design items outside ask (if any): 无明显扩张；账号、多租户、持久任务和重启续跑均不应引入。

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | G1–G6 与 brief 一致 |
| No premature new abstraction layer | pass | 共享运行注册表确有聊天与删除两个消费者 |
| No speculative generalization | pass | 不引入任务调度平台 |
| Cross-cutting surface growth justified | pass | 单例状态必须随多线程迁移 |
| Operational weight justified | pass | 当前 SDK 源码确认已访问线程的后台生命周期；常驻线程内存风险仍受设计非目标约束 |
| Alternatives Considered includes a simpler option | pass | 已比较自建池与仅解除 UI 禁用 |
| Touch/complexity budget reasonable | pass | 异步边界已补齐；按后端注册表、线程适配器、线程历史与页面迁移分层实施 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | 复用 Conversation，无新增表 |
| Alterations / migrations scoped | pass | 无 schema 迁移 |
| Cross-domain FK / shared tables justified | pass | 不新增跨域外键 |
| Rollback / backfill cost acceptable | pass | 无回填；保留既有历史 DTO |
| No speculative schema for unused futures | pass | 未引入持久任务模型 |

### Verification — Acceptance Criteria

本目录只有 brief.md 与 design.md，无 verification.md；本维度为 n/a。设计 §10 是业务验收概要，不能视为已经通过代码级 AC 评审。实施前需创建 verification.md 并完成 Acceptance Criteria Review。

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | n/a | 尚无 verification.md |
| AC 代码接地 | n/a | 新接口/注册表须区分计划新增与现有代码 |
| AC 可判定 | n/a | 必须补齐下列竞态场景 |
| AC 粒度合适 | n/a | 后续按状态边界制定 |
| 与 design.md 目标对应 | n/a | 需要覆盖 G1–G6 |
| Must-Not-Break 业务语义保留 | n/a | 保留同会话串行、停止隔离及历史分页 |

### Functionality — Identity and asynchronous lifecycle

| Check | Result | Notes |
|---|---|---|
| 草稿提升保持输入归属 | pass | CC-DR-001 已在设计闭合，待实现验证 |
| 删除与发送有确定顺序 | pass | CC-DR-002 同步占位已定义 |
| 历史回写不覆盖新状态 | pass | CC-DR-003 互斥与响应校验已定义 |
| 后台失败不抢占当前导航 | pass | CC-DR-004 源线程选择检查已定义 |
| 数据流与 SDK 证据完整 | warning | CC-DR-005 |

## Findings

### Over-design / risk findings

以下保留首次评审原文及当时行号；当前处置见本节末修订复核表，不表示修订后仍有相同缺口。

- **CC-DR-001 · P1 · 草稿提升后附件/命令取错 key。** 设计 §6.4.2（第 272–277 行）规定草稿用列表项 ID、正式会话优先 remoteId，而 §7.2 要求 run 用 unstable_threadId 读取和清理。按 §6.2 的 initialize 时序，第一次 run 前 ID 已变化；没有迁移或别名规则，首轮附件/命令会读不到，旧 key 还会残留。当前 adapter 在发送时读取两个 store 并清空（`agent-chat-adapter.ts:64–89`），因此该转换是必经路径。建议整个输入草稿生命周期使用稳定 local thread ID，由线程适配器闭包携带，remoteId 只用于后端；或定义 initialize 成功时原子迁移及失败回滚。验收：新草稿选择附件/命令后首次发送、初始化失败重试、初始化期间切到 B，内容均只发送一次且不串会话。

- **CC-DR-002 · P1 · 忙碌检查与删除没有互斥。** 设计 §6.1.2（第 152–157 行）只在事务前读 isBusy，未给删除占用同一注册表。检查后、新请求可能在删除完成前 acquire 并进入 beginTurn；“一定先删完再 404”的推论不成立。当前删除与 beginTurn 都包含异步数据库事务（`conversations.service.ts:533,775`），删除还在提交后清理目录；仅检查无法约束两条路径的顺序。建议增加同步 try-acquire 删除占位，忙碌立即 409，持有至事务与目录清理结束，finally 释放；后到 run 等待删除结束后再判断不存在。验收两种先后顺序及排队、取消、删除失败，不能删除已获运行权的会话或留下锁。

- **CC-DR-003 · P1 · 历史请求开始时的检查不足以保护响应时的 reset。** 设计 §6.3.1–2（第 205–229 行）只在发请求前检查 isRunning/messages，响应时直接 reset；§6.5.2 未明确首次加载/失败/翻页时禁止该线程发送。若历史请求未完成便开始发送，迟到历史会覆盖新消息；分页与发送重叠也有同类问题。当前页面在首次加载时替换聊天区，分页时禁用输入/发送（`AgentChatPage.tsx:455,545,566`），迁移应保留这些边界。建议定义每线程 idle/loading/ready/error 状态，加载成功前禁止发送，翻页期间禁发；响应提交同时校验线程实例、请求版本、存活状态及未开始新 run，删除后丢弃迟到响应。验收慢历史请求、失败重试、翻页与发送、加载中删除及快速切换。

- **CC-DR-004 · P2 · 后台历史 404 可以抢走用户当前会话。** 设计 §6.3.2 / §6.7 直接规定“刷新列表，切到草稿”，未要求请求对应会话仍是当前选中项。A 加载后用户切到 B，A 的迟到 404 会把正在阅读/编辑的 B 切走；异步删除活动会话后无条件切草稿亦同理。建议异步结果始终按源线程处理，仅当当前选择仍是该线程才切草稿；否则只清理 A 并提示。验收 A 请求未返回时切 B，A 返回 404/删除成功，B 选择与输入保持不变。

- **CC-DR-005 · P2 · 实施契约和独立证据待补。** §5 的图止于 Controller/SSE，缺少 ChatService、注册表、ConversationsService、SQLite 与 session 目录的关键交互；没有独立 Frontend Fetching Logic / Backend Fetching Logic、关键节点责任表及 Design Deviations。补充端到端图并明确刷新、恢复、删除失败/partial 与初始化成功但首轮失败的状态。当前 checkout 没有根或 desktop node_modules；package.json 只能证明声明 `^0.15.32`，不能复核设计援引的已安装 SDK 行号/测试结论。实施前应对锁定版本验证初始化、后台运行、reload 不取消其他 run、删除失败保留本地项、remoteId 持久化时机；本次不将这些 SDK 假设写成已验证事实。

2026-11-09 修订复核：

| Issue | 设计处置 | 复核结论 |
|---|---|---|
| CC-DR-001 | §6.3.1、6.4.2、7.2 固定 localThreadId、冻结快照、初始化 single-flight，远端 ID 不作草稿键 | resolved_in_design；验收 11/12，未验证实现 |
| CC-DR-002 | §6.1.2 同步删除占位与运行排队共用单例，覆盖提交后目录清理，finally 释放 | resolved_in_design；验收 13/14 |
| CC-DR-003 | §6.3.2 明确状态、实例代次/requestVersion/runEpoch、禁发与原子提交 | resolved_in_design；验收 15 |
| CC-DR-004 | §6.3.2–3 异步回调检查当前选择；恢复遵守用户导航代次 | resolved_in_design；验收 16/17 |
| CC-DR-005 | §5.2–4 补数据流与获取责任；§10.3 列锁定 SDK 验证；§14 记录差异 | partial：文档已补，SDK 证据仍待完成 |

补充检查：§6.6 已选择空标题流与唯一摘要来源；§6.7 明确 partial 删除与初始化响应丢失；§10.2 增加跨线程刷新不重建实例的验收。以上属于设计层静态核对，不替代运行时测试。

### Suggested cuts (thinner design)

- 保留多线程运行时方案，不追加自建任务系统。
- 输入草稿优先固定 local thread ID，减少临时 ID 与 remoteId 双向迁移状态。
- 自动标题选择一种确定策略；避免把两种相互作用的实现路径留到编码阶段才决定。

### Worth keeping (surprising but justified now)

- 每线程独立 LocalRuntime：解除全局禁用的前提，不是过度设计。
- 共享运行注册表：保留同会话串行并支撑后端删除保护，但删除必须参与互斥。
- 按消息 ID 合并活动与产物历史：可复用现有唯一消息标识，无需新表。

## Developer Decision

- Decision: approved
- Reason / accepted cuts: 用户于 2026-11-09 明确要求按本任务文档开始实施。实施前 SDK 行为已按当前安装版本源码核验；不修改 lockfile 基线问题单独记录。
- Confirmed at: 2026-11-09

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | CC-DR-001～004 已设计闭合；CC-DR-005 的 SDK 行为已按 0.15.33 实际源码核验，开始实施 |

独立核验：已读取 ChatService 的 acquire → beginTurn 顺序、ConversationsService 的 beginTurn/deleteConversation 事务、桌面 adapter 的草稿读取/清理、页面历史加载与分页守卫、artifact store 的请求版本保护。未安装依赖，未运行应用或功能测试；本评审结论针对设计缺口，不声称已复现实施后的故障。
