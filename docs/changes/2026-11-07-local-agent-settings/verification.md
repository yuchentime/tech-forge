---
status: implemented
layer: change
domain: local-agent-settings
created_at: 2026-11-07
version: 2.0
acceptance_review_status: approved
---

# 本机 Agent 设置验收

## Acceptance Criteria（代码级验收规则）

### AC-01 Provider 配置影响新 session

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/backend/src/llm/llm.service.ts`：`LlmService.createSession()`；`apps/backend/src/llm/adapters/deepseek-llm.adapter.ts`：`DeepseekLLMAdapter.register()`；`apps/backend/src/llm/adapters/custom-llm.adapter.ts`：`CustomLLMAdapter.register()` |
| 前置条件 | 用户在本机设置中保存 DeepSeek 或自定义 Provider 后发起新 Agent 请求 |
| 预期行为 | 新 session 使用保存的 Provider/model；DeepSeek 默认模型为 `deepseek-flash`；自定义配置将名称、Base URL、模型 ID 和可选 Key 注册到当前 runtime |
| 禁止出现 | session 固定使用 DeepSeek 常量；API Key 从源码默认值、非设置接口、Agent SSE、普通日志或 SQLite 泄露 |
| 判定方式 | 代码走查设置读取、适配器注册及运行时凭据数据流 |

### AC-02 本地配置读写和明文回显

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/backend/src/llm/llm.service.ts`：`LlmService.createSession()`；`apps/desktop/src/types/desktop-bridge.ts`：`DesktopBridge.request()`；`apps/desktop/src/features/settings/SettingsPage.tsx` |
| 前置条件 | 应用启动后打开设置并读取或提交模型配置 |
| 预期行为 | 配置保存在主目录 .tech-forge/config.toml；GET /api/settings 返回两个 Provider 已保存的 Key；设置页用普通文本控件回填明文；省略 Key 保留已存值；默认选择 deepseek 与 deepseek-flash |
| 禁止出现 | Key 进入 Agent SSE、普通日志或 SQLite；保存普通字段时意外清空已存 Key |
| 判定方式 | 代码走查文件序列化、设置 API 投影、表单回填和受限 bridge 调用 |

### AC-03 SOULS.md 作为新 session 系统提示词补充

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/backend/src/llm/llm.service.ts`：`LlmService.createSession()` |
| 前置条件 | `~/.tech-forge/SOULS.md` 存在且包含非空白内容 |
| 预期行为 | 每个新 Pi session 的系统提示词在固定 `SYSTEM_PROMPT` 之后包含文件内容；文件不存在或为空时不添加风格文本 |
| 禁止出现 | 风格内容覆盖固定工具/系统边界、影响当前已运行 session，或进入 Conversation 持久化记录 |
| 判定方式 | 代码走查文件读取与 `DefaultResourceLoader` 的 systemPrompt 组合 |

### AC-04 设置主视图切换且 Conversation 行为不回归

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `apps/desktop/src/features/agent/ConversationSidebar.tsx`；`apps/desktop/src/features/settings/SettingsPage.tsx` |
| 前置条件 | 用户点击侧栏底部设置按钮，随后返回对话或选择会话 |
| 预期行为 | 右侧切换到模型配置/风格偏好界面；侧栏保持可用；返回时原 Conversation Runtime 内容仍可见 |
| 禁止出现 | 设置界面替换或重建根 Runtime；设置操作更改历史分页、消息发送或流事件行为 |
| 判定方式 | 代码走查 React 条件渲染、可访问名称和既有 Runtime 挂载层级 |

## Required Automated Checks

- 本任务不新增或运行测试。
- L001 的 npm run build 通过；v2.0 修改后 backend、renderer、Electron 的 TypeScript noEmit 检查通过。
- v2.0 再次运行 npm run build 时，Nest build 因运行中的 backend 进程占用 apps/backend/dist 报 EBUSY，未能完成完整构建。

## Required Manual Checks

- [x] [L3] 在桌面应用打开设置、切换 DeepSeek/自定义 Provider 并返回对话。
  - 结果：已确认设置入口、右侧设置主视图、默认模型、自定义字段和返回聊天；该轮未提交设置内容。
- [ ] [L3] 保存 API Key 后重新打开设置，确认密钥以明文回填；编辑或清除后再次读取验证。
- [ ] [L3] 保存模型配置与风格偏好，并在新的真实 Provider 请求中确认后续 session 使用保存值。
  - 未执行：未提供可用于真实 Provider 请求的凭据；未以空值或伪凭据调用外部模型。

## Must-Not-Break Checks

- [ ] 对话列表、历史消息和更早消息分页继续工作（本轮未做回归操作）。
- [ ] Agent SSE 流、取消、工具活动和持久化流程保持不变（本轮未做回归操作）。
- [x] Renderer 不获得本地文件系统或 backend token 访问权；仅设置页经受限 window.teachforge.request() 收到本机 API 返回的明文 Key。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| 首次启动时无 `.tech-forge` | 创建默认 TOML 与空 SOULS 文件 | L1 / L2 | 代码走查及运行验收 | 设置无需手工初始化 |
| 保存并重启后读取配置 | Provider 字段与明文 Key 保留并回填 | L2 | 桌面手动验收 | 覆盖持久化和设置页回显 |
| DeepSeek、自定义 Provider 各发起请求 | 请求使用所选 Provider/model | L2 | 真实网络配置下手动验收 | 确认 Pi runtime 注册 |
| 空/非空 SOULS 文件 | 空文本不添加 prompt；非空内容追加 | L1 | 代码走查 | 确认 session prompt 组合 |
| 返回聊天或切换 Conversation | 原 runtime 和历史行为保留 | L3 | 桌面手动验收 | 避免设置页破坏活动对话 |

## Known Guardrails

- 仅 GET /api/settings 可向本机设置页返回 API Key；不得进入 Agent SSE、普通日志或 SQLite。
- 只允许 HTTP(S) Base URL；不改变工具工作区限制。
- TOML 读取失败时不能以默认值覆盖现有文件。

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | `register()` 与 `LlmService.createSession()` 均存在；使用这些现有入口判定新 session 与适配器配置行为。 |
| AC-02 | pass | SettingsPage 使用现存 window.teachforge.request() 调用本机 API；新增本机设置响应明文字段，不扩展 Electron IPC 或数据库契约。 |
| AC-03 | pass | `LlmService.createSession()` 已有 `SYSTEM_PROMPT` 和 `DefaultResourceLoader` 组合位置。 |
| AC-04 | pass | `ConversationSidebar` 与根 `AssistantRuntimeProvider` 当前存在；仅检查局部视图切换和挂载关系。 |

- `acceptance_review_status`: approved
- 评审结论：v2.0 AC 已复核，覆盖配置文件、设置页明文回显、prompt 注入和视图切换；API Key 返回仅限本机设置 API。
- 评审方 / 确认人 / 时间：实现代理按现有代码复核 / 2026-11-07

## 实施检查结果

- L001 的 npm run build 通过（Nest backend、Electron TypeScript、Renderer TypeScript 与 Vite production build）。
- v2.0 修改后 backend、renderer、Electron TypeScript noEmit 检查通过；完整 npm run build 因 apps/backend/dist 被运行中的 dev backend 占用而报 EBUSY。
- Electron 初版视觉检查通过（设置入口、设置主视图、默认 DeepSeek 模型、自定义 Provider 字段和返回聊天视图）；明文 Key 回填尚待应用重启后的桌面确认。
- 自动化测试：未新增或运行，遵循本任务约束。
- 未配置或发送任何真实 Provider API Key；真实凭据下的回显、编辑、清除和新模型请求未验证。