---
status: implemented
layer: change
domain: agent
created_at: 2026-11-06
canonical_for:
  - agent-streaming-loop-verification
related:
  - docs/changes/2026-11-06-agent-streaming-loop/design.md
  - docs/changes/2026-11-06-agent-streaming-loop/tasks.md
  - docs/current/platform/architecture-and-code-placement.md
last_verified: 2026-11-07
version: 5.0
acceptance_review_status: pending review
---

# Agent 单轮流式闭环 Verification

## Test Layer Taxonomy

本变更按三层证据验收，避免把编译通过当成真实流式链路已通过：

- **L1 — Local Logic Verification**：Node `node:test` 验证 Agent 输入委托、SSE 编码/解析、输入规则和取消清理等局部行为。只证明局部逻辑。
- **L2 — Automated Real-World Verification**：启动真实 Nest/Fastify 本地进程验证 HTTP 认证、输入边界及既有 health/Course API；显式启用后再调用 DeepSeek Provider，验证真实模型响应与 HTTP 增量传输。
- **L3 — Human-Aided Verification**：通过实际 Electron 窗口验收 Assistant UI 的增量显示、取消交互及 Course 原型回归。当前仓库没有桌面 UI 自动化脚手架，视觉与窗口操作由开发者人工确认。

> 能自动化的真实联动问题优先放在 L2。L1 不证明实际网络响应；L2 不替代 Electron 界面的视觉与交互验收。

## Acceptance Criteria（代码级验收规则）

> 新 API 路径、请求字段和事件名称是 `design.md` 明确的目标契约，目前尚不存在于代码中。本节把新增目标和当前已存在的锚点分开标注；当前事实核对只对现有代码成立。开发者已确认沿用当前 Pi 扩展工具能力；工具调用不通过 SSE 呈现。

### AC-01 本地 HTTP 认证边界

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 现有 `apps/backend/src/main.ts` Fastify `onRequest` hook；新增流式 API 路径按 `design.md` 实现 |
| 前置条件 | 对目标流式 API 发请求时省略/提供错误的 `x-teachforge-token`，或请求带有任意 `Origin` |
| 预期行为 | 沿用现有 hook：无效/缺失 token 返回 HTTP 401；带 `Origin` 返回 HTTP 403；本地有效请求才进入 Agent 用例 |
| 禁止出现 | 未通过认证的请求不得调用 `LlmService.stream()` 或接收模型内容；token 不进入 Renderer bridge 契约 |
| 判定方式 | L2 HTTP 集成断言状态码；代码走查确认新增路径仍受全局 hook 保护、Preload 类型没有 token 字段 |

### AC-02 Prompt 请求校验

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 现有 `apps/backend/src/main.ts` `ValidationPipe` 配置；新 DTO/流式 API 按 `design.md` 定义 |
| 前置条件 | `POST /api/agent/stream` 的 JSON body 缺少 `prompt`、只含空白、超过 10,000 个 Unicode 字符，或含 DTO 未声明字段 |
| 预期行为 | HTTP 400，响应不进入 SSE；有效 `prompt` 去除首尾空白后进入 Agent 用例 |
| 禁止出现 | 无效输入不得开始 provider 请求；额外字段不得被静默接受（当前全局 `whitelist: true`、`forbidNonWhitelisted: true`） |
| 判定方式 | L1 DTO/规范化规则测试（`MaxLength` 按 Unicode 码点计数）与 L2 HTTP 状态/响应头断言 |

### AC-03 Agent 到 LLM 的流式委托

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 已存在的 `AgentService` 类（`apps/backend/src/agent/agent.service.ts`，当前无业务方法）；已存在的 `LlmService.stream(prompt, options?)` 和 `DeepseekLLMAdapter` |
| 前置条件 | 有效 prompt；`DEEPSEEK_API_KEY` 已由后端进程环境提供；使用设计指定的 `deepseek` / `deepseek-chat` 选项 |
| 预期行为 | Agent 用例将同一个规范化 prompt 交给 `LlmService.stream()`；逐个按原顺序转发 text delta；仅在模型正常结束后发送 `done`。沿用当前 `LlmService` session 中已装载的 `billion-context-pi` 与 `pi-subagents` 扩展工具 |
| 禁止出现 | 不得改用 `generate()` 缓冲完整回答；不得加入此前聊天历史、Conversation/Message 写入或检索上下文；本次不得新增扩展工具或把工具事件加入 SSE/UI |
| 判定方式 | L1 使用替身验证 prompt/options 与 delta 顺序，并走查 AgentService 未替换现有 session/tool 配置；L2 使用真实 Provider 确认在 `done` 前收到至少一个 `delta` |

### AC-04 Electron 流桥接与 JSON 兼容

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 已存在的 `DesktopBridge.request()`（`apps/desktop/src/types/desktop-bridge.ts`）、`registerBackendIpc()` 中的 `backend:request`（`apps/desktop/electron/main/main.ts`）；新增 `streamAgent` 按 `design.md` 定义 |
| 前置条件 | Renderer 提交一条 Agent prompt；或执行现有 JSON `request()` |
| 预期行为 | 流式请求经 Preload 专用 bridge 进入 Main；Main 携带 token 向固定本地 Agent 路径读取 SSE，并按序转发 delta/done/error；普通 `request()` 仍返回完整 `{ status, data }` |
| 禁止出现 | Renderer 不直接请求本地 HTTP、不获取 token、不接触任意 IPC 或裸 MessagePort；流式请求不得等待整段响应后再一次性返回 |
| 判定方式 | L1 测试 Main 的 SSE 帧解析/事件关联；L3 检查真实窗口能在模型完成前呈现增量，代码走查确认 bridge 是窄接口 |

### AC-05 取消、失败与资源释放

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 已存在的 `LlmService.stream()` `finally` 中 `unsubscribe()` 与 `session.dispose()`；新增 Electron 流桥接和 HTTP 流按 `design.md` 传递取消 |
| 前置条件 | 生成期间用户取消、Renderer 关闭，或 Provider 抛出异常 |
| 预期行为 | 取消向 Main 的请求 AbortController 和后端响应流传播；异步迭代器关闭后执行现有 session dispose（Pi dispose 会 abort 当前 Agent）；Provider 失败产生可读 `error` 事件 |
| 禁止出现 | 取消后继续向该运行发送 delta；下一次请求收到上一运行的事件；error payload 带出密钥、认证 token、堆栈或原始 Provider 响应 |
| 判定方式 | L1 验证事件订阅/迭代清理；L3 操作 Stop 并检查下一次发送无旧事件 |

### AC-06 单轮且无业务持久化

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 已存在的 `apps/backend/src/llm/llm.service.ts` `createSession()` 使用 `SessionManager.inMemory()`；当前 `AgentService` 类无 Repository 依赖 |
| 前置条件 | 连续提交两次不同 prompt，或关闭并重新打开桌面应用 |
| 预期行为 | 每次新建的 Pi session 只接收本次 Agent prompt；聊天消息只留在当前 Renderer runtime 内存；Agent 用例不创建 Conversation/Message/AgentRun 记录。当前扩展工具可执行自身动作，但不形成对话历史 |
| 禁止出现 | 第二次 prompt 自动拼接此前聊天记录；关闭应用后从后端恢复本次消息 |
| 判定方式 | L1 检查 Agent 委托输入；L2 比较请求 prompt；L3 关闭重开应用确认聊天不恢复 |

### AC-07 现有启动、健康与课程路径回归

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `HealthController.getHealth()`；`CoursesController.list()` / `create()`；`DesktopBridge.request()`；Electron `startBackend()` 和 `registerBackendIpc()` |
| 前置条件 | 启动 Electron 桌面端并执行原有健康检查、课程列表和创建操作 |
| 预期行为 | 主窗口仍在 backend ready 后打开；`GET /api/health` 返回健康状态；`GET /api/courses` 与 `POST /api/courses` 继续经 JSON bridge 正常工作 |
| 禁止出现 | 新增流式 IPC 改变普通 JSON 请求返回形状、启动时序或 Course 原型入口 |
| 判定方式 | L2 API 回归 + L3 Electron 原窗口操作 |

### Code Grounding 自检（编码前）

已逐项核对现有落点：`AgentService`、`LlmService.stream()`、`DeepseekLLMAdapter`、`ValidationPipe`、认证 hook、`DesktopBridge.request()`、`registerBackendIpc()`、`HealthController.getHealth()`、`CoursesController.list()` 和 `create()` 均在当前代码中存在。现有 `AgentService` 为空壳、无 Agent Controller、无 stream bridge，且 package scripts 没有 test 命令；新增路径、字段、事件和 bridge 方法因此作为设计目标明确标注，没有表述为当前事实。`LlmService.createSession()` 当前装载两个 Pi 扩展并仅禁用 builtin 工具；开发者确认保留该能力。

## Required Automated Checks

```bash
# L1：现有编译检查
npm run build:backend
npm run build --workspace @teachforge/desktop

# 以下 L1/L2 脚本需由本变更的自动化验证任务新增
npm run test:agent-stream --workspace @teachforge/backend
npm run test:agent-stream --workspace @teachforge/desktop
npm run verify:agent-stream --workspace @teachforge/backend
npx cross-env TEACHFORGE_AGENT_LIVE_TEST=1 npm run verify:agent-stream --workspace @teachforge/backend
```

- [L1] 后端 Node `node:test`：验证 AgentService 委托参数与异步流顺序、DTO 输入边界、SSE 帧编码，以及取消后 listener/迭代清理。证明本地逻辑，不证明 Provider 或 Electron 网络链路。
- [L1] 桌面端 Node `node:test`：验证 Main 的增量 SSE 解析、分段 UTF-8 处理和 request ID 事件隔离。证明帧解析逻辑，不证明渲染器真实视觉更新。
- [L2] `verify:agent-stream` 默认以随机本地 token 和临时 `TEACHFORGE_DATA_DIR` 启动后端，验证 401/403、无效 prompt 400、health 和 Course 列表/创建；不会请求模型。
  - 适用场景：验证真实 Nest/Fastify 进程、本地认证 hook、DTO 与现有 JSON API 联动；L1 mock 无法证明这些 HTTP 边界。
  - 已执行结果：通过；临时进程和数据目录在脚本结束时清理。
- [L2 Provider] 使用 `TEACHFORGE_AGENT_LIVE_TEST=1` 开启相同脚本中的一次真实 DeepSeek 请求，并断言至少一个 delta 在 done 前到达。
  - 适用场景：证明真实 Provider、Nest/Fastify SSE 响应流和认证 hook 的联动行为；L1 mock 和本地 HTTP 检查无法证明这些外部边界。
  - 前提条件：仅当显式设置 `TEACHFORGE_AGENT_LIVE_TEST=1` 运行；需要配置 DeepSeek adapter 和可访问 DeepSeek 的网络。执行时从当前已配置 adapter 向测试子进程提供凭据，不打印凭据值。
  - 已执行结果：通过，真实响应收到 436 个 `delta`，之后收到 `done`；子进程与临时数据库已清理。
  - 预计耗时：约 10–60 秒，取决于 Provider 响应时间。
  - 副作用：一次真实模型调用，产生 Provider 费用；在系统临时目录创建 SQLite 数据库和后端子进程。
  - 清理策略：测试结束或失败时终止后端子进程并删除专属临时数据目录；不会写入用户默认工作目录或业务数据。

> L1 只能证明局部代码路径，不能证明真实 Provider 响应或网络流式行为。本变更无过期、签名、缓存失效逻辑。

## Required Manual Checks

- [L3] 在已配置 `DEEPSEEK_API_KEY` 的开发环境打开 Electron，切换 Agent/Course 页面后再回到 Agent，发送一段要求多句回答的文本。
  - 原因：仓库当前没有 Electron UI 自动化工具；标签切换时 Runtime 存活、消息逐步呈现和 Stop 状态需要真实窗口观察。
  - 执行人：开发者。
  - 判断标准：Assistant UI 显示用户输入；模型完成前回答已经逐段增长；完成态和取消态清晰；切换 Course 再回来时本进程内的临时聊天仍在；Course 列表/创建入口可用。
  - 本轮状态：部分通过。Electron 实际启动、本地服务健康状态、Course 页面打开和 Agent 长回答完成均已确认；生成期间观察到 Stop 控件，但没有触发取消。关闭并重开后的内存状态也未检查。因窗口检测到用户输入，未继续操作该窗口。生产 renderer 1440、768、390 像素截图检查仍为 0 个告警。

## Must-Not-Break Checks

- [x] Electron 等待本地 backend ready 后打开窗口，启动成功路径已在实际窗口确认；启动失败对话框路径未触发。
- [x] 健康 endpoint 经本地 HTTP 回归返回 200；Electron Main JSON bridge 代码未更改。
- [x] Course 原型的列表与创建经隔离临时数据库 HTTP 回归通过。
- [x] Renderer bridge 类型不包含 `x-teachforge-token`；token 只由 Main 注入。

## 本轮执行记录（L002）

- 后端与桌面 L1 测试分别 4/4、5/5 通过；本地 HTTP 回归通过。
- 显式启用的 DeepSeek Provider 检查通过，436 个增量先于 `done` 到达。
- Electron 实际窗口启动成功，health 显示已连接；提交较长中文问题后，Assistant UI 显示完整流式回答；Course 标签可打开且列表正常显示。
- 生成中可见 Stop 控件，但停止动作和关闭重启后的内存验证尚未执行。
- 当前开发窗口保持运行，供用户继续检查。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| 缺失/错误 token 或请求带 Origin | 分别收到 401/403，不触发 LLM | L2 | 受保护的本地 HTTP 集成断言 | 验证新增流入口仍在现有本地安全边界内 |
| 空白、超长或含未知字段的 prompt | HTTP 400 且无 SSE/模型请求 | L1 / L2 | DTO 单测及 HTTP 集成断言 | 阻止无效输入进入昂贵外部调用 |
| 正常真实模型流 | 一个或多个 delta 在 done 前到达，顺序保持 | L2 | opt-in DeepSeek 实时验证 | 证明真实 HTTP/Provider 流不是完整响应缓冲 |
| Assistant UI 取消生成 | 请求停止，状态显示取消/未完成，后续请求不收旧事件 | L1 / L3 | 清理测试与 Electron 手工操作 | 覆盖跨进程取消和 listener 生命周期 |
| Pi 工具事件及公开字段边界 | UI 显示工具名称/参数；结果、partial result、完整消息和未知字段不会到达 Renderer | L1 / L2 / L3 | 事件投影与校验测试、本地 HTTP、Electron 窗口观察 | 确保活动提示有用且不泄露工具输出 |
| 活动状态与最终文本流并行 | 工具状态更新独立于 Assistant 正文；text delta 仍按序累积，终态清理状态 | L1 / L2 / L3 | EventBus/Adapter 测试、SSE 联动、Electron 窗口观察 | 验证状态提示没有打断答案流 |
| 桌面端健康与 Course 原型回归 | ready 状态、健康、课程列表/创建仍工作 | L2 / L3 | HTTP 回归与 Electron 手工操作 | 防止扩展 IPC 时破坏现有 JSON 路径 |
| 应用关闭后重新启动 | 本轮消息不恢复 | L1 / L3 | 状态边界检查与重启观察 | 验证最小闭环没有暗中承诺持久化 |

## v2.0 Acceptance Criteria Amendments

本节是 v2.0 的有效验收补充，保留 v1.0 记录。v2.0 修订 AC-03 与 AC-04 中“只转发文本、不显示工具事件”的规则；其余 AC 继续有效。

### AC-03 v2.0 Agent 到 Pi 事件流

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentService.stream()`；`LlmService.stream()`；Pi SDK `AgentSessionEvent` 与 `AgentSession.subscribe()` |
| 前置条件 | 有效 prompt；DeepSeek 配置可用；Pi session 产生 lifecycle、tool 或 text delta 事件 |
| 预期行为 | AgentService 按原顺序投影 `agent_start`、`turn_start`、`turn_end`、`tool_execution_start`、`tool_execution_end`、`agent_end` 和 text-only `message_update`；`tool_execution_start` 保留工具名和参数，文本增量仍逐段发送 |
| 禁止出现 | 不把所有 Pi 事件原样透传；不暴露 `tool_execution_update.partialResult`、`tool_execution_end.result`、`turn_end.message/toolResults`、`agent_end.messages` 或非 text delta 内容；不拼入历史 prompt |
| 判定方式 | L1 对真实 `AgentSessionEvent` 形状做投影断言；真实端点检查 delta 顺序与终态；代码走查确认仅 allowlist 穿过 AgentService 边界 |

### AC-04 v2.0 事件桥接、UI EventBus 与 JSON 兼容

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentSseEvent` / `encodeAgentSseEvent()`；Electron `decodeAgentSseMessage()`、`routeAgentStreamEvent()`、Preload `isAgentStreamEvent()`；Renderer Agent EventBus / `agent-chat-adapter` |
| 前置条件 | Renderer 提交一轮 Agent prompt，后端连续产生工具/lifecycle/text 事件；或执行现有 JSON `request()` |
| 预期行为 | SSE 以对应 Pi `type` 为事件名；Main 按原顺序投递到请求独立的 MessagePort；Preload 只转发通过校验的事件；Renderer EventBus 更新进度状态，Assistant UI 累积 `message_update/text_delta`；health/Course 仍走 JSON bridge |
| 禁止出现 | 不新增 `progress` 语义事件；不跨 request ID 串流；Renderer 不接触 HTTP token、任意 IPC 或裸 MessagePort；工具/lifecycle 事件不写进助手正文 |
| 判定方式 | L1 逐层断言事件名、字段 allowlist、顺序、request ID 隔离、EventBus 状态和 delta 累计；L2 检查 SSE 连续帧；L3 检查窗口中的工具状态与答案增量 |

### AC-08 Pi 事件公开字段边界

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `AgentService.stream()` 的 Pi 事件投影；`AgentSseEvent`；桌面桥接类型与 Preload 运行时校验 |
| 前置条件 | Pi 发出包含工具参数、工具结果和 message 内容的事件 |
| 预期行为 | `tool_execution_start` 暴露 `toolCallId`、`toolName`、`args`；`tool_execution_end` 只暴露 `toolCallId`、`toolName`、`isError`、可选 `durationMs`；生命周期事件只暴露 UI 所需字段；文本更新只暴露 `text_delta` |
| 禁止出现 | `partialResult`、`result`、`toolResults`、完整 `messages`、模型 reasoning/non-text delta 或未列入 allowlist 的 Pi event type 不进入 SSE、MessagePort 或 Renderer EventBus |
| 判定方式 | L1 使用含敏感哨兵字段的 Pi event fixture 检查序列化 payload；Main/Preload 对未知 event 和字段形状拒绝转发 |

### AC-09 单轮事件顺序、终态和取消清理

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `LlmService.stream()` 异步事件队列；`AgentController.stream()`；Main SSE reader 与每请求 MessagePort lifecycle；Renderer EventBus |
| 前置条件 | 同一轮先后触发 Pi 工具事件和多个 `message_update/text_delta`；或在事件等待/响应写入期间取消 |
| 预期行为 | 同一 request 的事件各发送一次且保持顺序；`done`/`error` 是终态；取消停止后续事件并解除订阅、关闭端口和 Pi session；下一轮只收到自己的事件 |
| 禁止出现 | 取消后继续发送、事件跨请求串扰、终态后再收到 delta，或未关闭的订阅/端口保留回调 |
| 判定方式 | L1 使用多个请求 ID 和可控 Pi session 覆盖顺序、终态、取消与清理；L2 验证真实 SSE 写入并保持 JSON API 兼容 |

## v2.0 Acceptance Criteria Review

> Design Review v2.0 已 PASS；以下核验在 v2 编码前逐条对照当前 Pi SDK 声明与项目代码完成。

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-03 | pass | 当前 `LlmService.stream()`、`AgentService.stream()` 和 `AgentController.stream()` 均存在；安装版本导出的 `AgentSessionEvent` 包含列出的 lifecycle/tool/message 事件；`message_update` 携带 `assistantMessageEvent`，可窄化到 `text_delta`。 |
| AC-04 | pass | `AgentSseEvent`、`encodeAgentSseEvent()`、`decodeAgentSseMessage()`、`routeAgentStreamEvent()`、Preload `isAgentStreamEvent()` 和 request ID MessagePort 均是现有代码锚点；新增 Pi-native variants 与 Renderer EventBus 属于 v2 目标。 |
| AC-08 | pass | 当前 SDK 声明确认 `tool_execution_start.args`、`tool_execution_end.result`、`turn_end.message/toolResults` 和 `agent_end.messages` 的字段结构；投影可逐事件选择并剔除不公开字段。 |
| AC-09 | pass | 当前 LlmService 使用队列与 `wakeConsumer`，Controller 的 `writeSseFrame()` 等待 drain，Main/Preload 按 request ID 隔离且支持取消；这些是 v2 顺序和清理验收的现有锚点。 |

- 评审结论：AC-03、AC-04、AC-08、AC-09 已按 SDK 与现有桥接实现核验；v2 AC 均可判定，可以进入编码。
- 评审方 / 确认人 / 时间：Codex（实现方）与开发者（确认 Pi 原生事件、工具参数可见、工具结果不出站）/ 2026-11-06

## v2.0 Implementation Verification

- Backend build: PASS (`npm run build:backend`).
- Desktop build: PASS (`npm run build --workspace @teachforge/desktop`); Vite reports a non-blocking large-chunk advisory.
- Backend L1: PASS, 5/5 (`npm run test:agent-stream --workspace @teachforge/backend`).
- Desktop L1: PASS, 8/8 (`npm run test:agent-stream --workspace @teachforge/desktop`).
- Local HTTP L2: PASS (`npm run verify:agent-stream --workspace @teachforge/backend`), including Agent stream endpoint, health, and Course routes.
- L003 credential check (historical): at that point the adapter was recorded as using `DEEPSEEK_API_KEY`; the L004 live-test re-anchor found a source fallback. Do not infer that the source is currently free of a literal credential. The value is intentionally omitted from this document.
- DeepSeek v2 L2: NOT RUN; the opted-in subprocess reported `DEEPSEEK_API_KEY is required`. No credential was read or exposed by this verification attempt.
- Electron L3: PARTIAL; the desktop app and Agent page launched, but the page reported the local backend connection unavailable, so end-to-end tool activity and streamed answer display could not be observed.
- Visual inspection: development preview inspected at 1440, 768, and 390 px; 0 FAIL, 1 WARN (development server; production inspection recommended). The UI was in its empty state because the backend was disconnected.
- Remaining: repeat the DeepSeek v2 stream with the configured key available to the launched process, then verify tool activity and streamed text in Electron; exercise Stop and restart memory behavior from the v1 checklist.

## L004 Real Electron Follow-up

### Evidence

- The user corrected the configured model ID. Current provider registration and Agent request use the shared `DEEPSEEK_MODEL_ID` value `deepseek-flash`.
- Backend and desktop production builds completed successfully. Backend Agent stream tests passed 5/5; desktop Agent stream tests passed 8/8.
- Runtime inspection after `resourceLoader.reload()` showed the allowlisted tools, including `subagent` and `bg_wait`, loaded in the Agent session.
- In the Electron window, the Redis documentation request displayed `subagent` and `bg_wait` activity, including tool parameters. The task completed and created `E:\Redis-Introduction.md` (55,623 bytes; 1,418 lines; 1 H1, 11 H2, 44 H3; 53 fenced code blocks). The assistant displayed a completion response with file size and contents summary.
- During a separate no-tool Redis request, the UI was observed mid-generation with partial text, `正在生成回答`, and the Stop control. The next observation showed the completed text in the same assistant response. A direct backend stream probe also emitted multiple `message_update` events with text deltas.
- Three sequential direct `LlmService` no-tool stream probes completed successfully. This does not establish Electron backend process stability after extension tool use.
- After the tool-writing request, two additional UI prompts failed. The Electron-launched backend subprocess had exited with code 1; the captured stack pointed to the Pi SDK extension loader stale-context runtime guard. Root cause is not confirmed. Restarting the app restored the backend connection for the no-tool stream check.
- The real request used the source-level credential fallback at the user’s explicit direction. No credential value is included here. Removal and rotation are unverified.

### Result

- Tool activity visible in UI: PASS.
- Redis file written to the requested E: path and verified: PASS.
- Final assistant completion response visible: PASS.
- Assistant text visible before generation completed: PASS (mid-generation partial content and active status observed; direct backend deltas independently observed).
- Backend process remains healthy after a tool-using run: FAIL (unexpected exit code 1; stale-context guard in stack, cause unconfirmed).
- Stop/cancel behavior and restart memory behavior: NOT TESTED.
- Overall L3: PASS_WITH_WARNINGS; user-facing task completed, with a backend stability defect requiring investigation.

## L005 Pi SDK Built-in File Tools

- Pi SDK 1.5.0 provides built-in `read`, `edit`, and `write`; `createAgentSession()` enables its default built-ins unless overridden. The prior `noTools: 'builtin'` setting explicitly disabled them. See the [Pi SDK session configuration](https://pi.dev/docs/latest/sdk) and its [tools example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/05-tools.ts).
- `apps/backend/src/llm/tools/default-tools.ts` now declares `+read`, `+edit`, and `+write` tool modifiers. `LlmService` excludes `bash` while leaving extension tools enabled; the SDK file tools are reused directly rather than reimplemented.
- Backend build: PASS (`npm run build:backend`). Runtime inspection of a created Pi session showed active `read`, `edit`, and `write` plus the configured extension tools; `bash` was absent.
- The session inspection did not send a model request. Existing Agent event projection still excludes tool results from the Renderer; final assistant text remains the user-facing output.

## L006 Workspace-Scoped Pi File Tools

- Reproduced the SDK write behavior in an isolated temporary workspace: the built-in write operation calls `mkdir` for the parent even when it already exists. A write directly under a drive root can therefore attempt `mkdir E:\` and fail with `EPERM`; a write directly under the configured workspace root also needlessly attempts to mkdir that existing root.
- `createWorkspaceFileTools()` now wraps Pi's native read/edit/write definitions with operations rooted at the canonical backend `process.cwd()`. It skips mkdir on the workspace root, creates nested directories one level at a time, and rejects paths outside the workspace or through symlinks. No per-operation approval prompt is involved inside the workspace.
- The Agent system prompt supplies the resolved workspace path, asks for relative paths, and tells the model to save an outside-requested output inside the workspace under the same filename when possible. `bash`, `subagent`, and `subagents_enable` are excluded so those tools cannot bypass the file boundary. Existing UI event projection still shows allowed tool activity and arguments, while tool results remain out of the UI; final assistant output remains visible.
- Backend build: PASS (`npm run build:backend`). Workspace regression tests: PASS, 2/2; the root-write test injects an `EPERM` failure if mkdir is called on the workspace root and confirms it is never called, then verifies nested directory creation. Boundary tests confirm read/edit/write reject outside absolute and traversal paths without changing the outside file.
- Backend Agent stream suite: PASS, 7/7 (`npm run test:agent-stream --workspace @teachforge/backend`).
- Runtime session inspection confirmed `read`, `edit`, `write` remain available and shell/child-agent tools are absent. A direct attempt to write `E:\test_file.txt` returned `EWORKSPACE`; it did not write outside the configured workspace or call mkdir on `E:\`.
- Real Electron/Provider run: PASS for the workspace file outcome. The Agent wrote `E:\projects\tech-forge\apps\backend\dist\Redis-Introduction.md` (17,632 bytes; 369 lines; nine major sections). The UI showed the local backend connected, an in-progress state, then a completion response with the actual path and summary; no permission prompt appeared. The sampled UI states did not capture a tool-specific event or intermediate answer delta for this run; L004 contains the separate tool-activity and streaming observations.
- The workspace currently derives from `process.cwd()`; in development Electron launches the backend with cwd at `apps/backend/dist`. Packaged-app writability has not been verified, so a user-configurable writable workspace remains future work.

## L007 Retained Tool Activity in the Agent UI

- Diagnosis: Pi `tool_execution_start/end` events already crossed backend projection, SSE, Electron bridge, and Renderer EventBus. The UI only kept active tools; `tool_execution_end` removed each item, and the stream terminal event cleared the activity card. A short file write could therefore complete between UI observations with no visible trace.
- Change: the activity snapshot now keeps tool arguments and an explicit running/completed/failed/cancelled status for the current turn. Terminal cleanup retains that safe activity list until the next prompt starts. Tool results and full messages remain excluded; parameter details stay collapsed by default.
- Desktop regression suite: PASS, 9/9 (`npm run test:agent-stream --workspace @teachforge/desktop`), including retention through terminal cleanup and clearing at the next run.
- Real Electron/Provider check: PASS. A request wrote `E:\projects\tech-forge\apps\backend\dist\Redis-Tool-Trace.md` (903 bytes; 15 lines). After the final response appeared, the UI showed two `write` calls marked `已完成`; the tool arguments remained collapsed and no tool result appeared in chat.
- Streaming: this run did not sample an intermediate text delta. Earlier L004 UI and stream observations remain the evidence for incremental answer display.

## L008 Tool Activity Presentation

- Tool activity is rendered after the current user message and before its corresponding assistant message. Both the activity and assistant response use a shared left edge.
- While a tool runs, the activity line is concise and path-oriented: `读取文件 <绝对路径>` for `read`, or `正在编辑文件 <绝对路径>` for `write`/`edit`. The card uses a light grey background and smaller muted text than the answer.
- Once the run finishes, the activity uses a collapsed disclosure summary with the action and path. Tool counts, success labels, parameter prompts, and tool results are not shown in the collapsed view.
- Visual check: Electron HMR showed the tool summary immediately above the assistant output, aligned to the same left edge; the summary was collapsed and the answer remained unobstructed. `npx tsc --noEmit --project apps/desktop/tsconfig.app.json`: PASS.

## Known Guardrails

- 禁止把 L1 测试当作 L2/L3 的充分证据。
- 禁止伪造时间、伪造外部服务状态、伪造签名过期来让测试“跑通”。
- 高成本 L2 测试必须可开关（环境变量 / profile / tag），默认不进入 CI。
- L2 测试写入外部服务后必须说明 cleanup 策略，或明确列为已知风险。
- L2 能自动化解决的真实联动问题，不要默认推到 L3 人工处理。
- 涉及过期、签名、刷新、缓存失效的测试，至少有一层 L2；L2 成本过高或无法做到时，才退到 L3。

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
| --- | --- | --- |
| 用 mock 模拟外部服务过期，宣称验证了过期兜底 | 把 L1 当 L2 用 | 真实让服务状态过期，或走 L3 |
| 为了跑通测试，把过期时间改成 1ms 或伪造时间 | 破坏真实过程可靠性 | 要么真实等待，要么标注为 L1 逻辑测试 |
| 高成本集成测试默认开启 | 拖累 CI / 团队 | 加环境变量开关，文档说明 |
| 集成测试写入外部服务不做 cleanup | 污染真实环境 | 补充 cleanup 或列为风险 |
| 把本可 L2 自动化的真实联动测试偷懒改成 L3 人工 | 回归效率低下 | 优先用 L2 自动化覆盖 |
| 验证文档只列命令，不说明验证什么 | 无法判断覆盖度 | 每个命令都要说明“它证明了什么” |

## When To Read History

- 当前没有该功能关联的 ADR 或 postmortem。实现前读取本变更 `design.md`、`docs/current/platform/architecture-and-code-placement.md`，以及作为设计输入的 `docs/source/后端架构设计.md` 和 `docs/source/功能设计文档.md`。

## Acceptance Criteria Review

> Design Review 的 PASS_WITH_WARNINGS 已由开发者确认保留现有扩展工具能力；AC-02 与 AC-03 按实现事实修订并重新核验。以下核验在编码前完成。

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | `main.ts` Fastify `onRequest` hook 对所有 API 路由统一执行 Origin 与 token 检查；新 Agent 路径无豁免。 |
| AC-02 | revised | 将“JavaScript 字符”明确为 10,000 个 Unicode 字符；当前 class-validator `MaxLength` 使用 validator `isLength` 并按 surrogate pair 计一个字符。DTO trim 先于全局 ValidationPipe 校验。 |
| AC-03 | revised | 开发者确认允许当前已装载 Pi 扩展工具；保留“只转发助手 text delta、不新增工具或工具事件”的边界。已核对 `LlmService.stream()` 与 `createSession()` 当前真实签名/配置。 |
| AC-04 | pass | `DesktopBridge.request()`、Preload 的 invoke 与 Main `backend:request` 是现有 JSON 锚点；专用流 bridge 作为新增目标合同，token 仍由 Main 注入。 |
| AC-05 | pass | `LlmService.stream()` 的 `finally` 调用 `session.dispose()`；当前 Pi SDK 的 `dispose()` 会同步调用 `agent.abort()` 并断开事件订阅。跨层传播与隔离按设计新增并由 L1/L3 判定。 |
| AC-06 | pass | `createSession()` 使用 `SessionManager.inMemory()`；新 AgentService 不依赖 Repository，设计明确扩展工具副作用不等于聊天历史持久化。 |
| AC-07 | pass | `HealthController.getHealth()`、`CoursesController.list()` / `create()`、`DesktopBridge.request()` 和 Main JSON IPC 均存在。 |

- 评审结论：AC-02、AC-03 已按核验结果修订；全部 AC 已协商一致，可进入编码。
- 评审方 / 确认人 / 时间：Codex（实现方）与开发者（AC-03 工具范围确认）/ 2026-11-06

## Version History

本轮为 v1.0 初始验收稿；交付后反馈尚未产生版本升级记录。

### v2.0 — 2026-11-06

- 触发：开发者要求把 Pi 的处理中间事件通过 EventBus 传递给 UI，同时维持最终回答文本流。
- 改动内容：修订 AC-03、AC-04，新增 AC-08（Pi 事件字段筛选）和 AC-09（顺序、终态及取消清理）。
- 影响范围：后端事件队列与投影、SSE、Electron/Preload 事件桥接、Renderer EventBus、UI 状态和流式文本 Adapter。
- 处理状态：已在 L003 实施；L1、本地 HTTP 与构建通过。DeepSeek v2 联调及 Electron 活动态 L3 待完成。
