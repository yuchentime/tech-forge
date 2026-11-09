---
status: current
layer: domain
domain: system-settings
canonical_for:
  - local-agent-settings
  - local-workspace-setting
related:
  - docs/current/platform/agent-runtime.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/changes/2026-11-07-local-agent-settings/design.md
  - docs/changes/2026-11-07-local-agent-settings/verification.md
  - docs/changes/2026-11-07-local-workspace-setting/design.md
  - docs/changes/2026-11-07-local-workspace-setting/verification.md
historical:
  - docs/source/system-configuration-design.md
last_verified: 2026-11-08
---

# 本机 Agent 设置

## 当前行为

设置入口位于 Agent 对话侧栏底部。打开后主区域显示模型配置和风格偏好；侧栏仍可切换设置与对话。设置由本机 backend 管理，不属于 SQLite 业务数据，也不通过 renderer 文件系统访问。

backend 首次启动时在当前用户主目录创建 `.tech-forge/config.toml`、空的 `.tech-forge/SOULS.md` 和 `.tech-forge/workspace/`；设置 `TEACHFORGE_CONFIG_DIR` 可把该根目录重定向到任意绝对路径（便携部署与隔离集成测试使用，默认仍是 `~/.tech-forge`）。设置页通过受本机认证保护的 GET /api/settings 和 PUT /api/settings 读取、保存配置；响应包含两个 Provider 已保存的 API Key 明文，供本机设置页编辑。密钥输入框默认遮蔽内容，用户可点击输入框右侧的眼睛图标临时显示或再次隐藏。工作空间默认与配置文件分开，指向 `.tech-forge/workspace/`，可在设置页编辑并保存。旧配置中缺失路径或仍指向旧默认 `.tech-forge/` 的值会映射至新的子目录。

| 配置 | 当前行为 |
|---|---|
| Provider | 可选 deepseek 或 custom；默认 deepseek |
| DeepSeek | 模型 ID 默认 deepseek-flash，可编辑；首次使用前需配置 API Key |
| 自定义 Provider | 保存名称、HTTP(S) Base URL、模型 ID 和可选 API Key；缺少名称、URL 或模型 ID 时新 session 报配置错误 |
| API Key | 依用户要求以明文保存在 config.toml；设置页默认遮蔽，点击眼睛图标后才显示明文；省略或留空表示保留已存值，明确清除操作才删除；仅经本机设置 API 回传给设置页，不进入 Agent SSE、普通日志或 SQLite |
| 工作空间 | 保存在 `[workspace].path`；默认值为 `.tech-forge/workspace/`；路径必须绝对，不能是 `.tech-forge` 本身或其祖先；`SettingsService.getWorkspacePath()` 返回规范化路径，LlmService 将它用于 Pi cwd 与 Agent 文件工具 |
| 风格偏好 | SOULS.md 的非空文本在每个新 Pi session 的固定系统提示词之后追加；空白内容不改变提示词 |

配置文件新建时 POSIX 权限为目录 0700、文件 0600；Windows 使用用户目录继承 ACL。配置写入先写同目录临时文件，再替换目标文件。应用只识别自身定义的 TOML 字段，格式错误时不会重置已有配置。保存不会迁移或改变 SQLite 的 TEACHFORGE_DATA_DIR。

## 责任边界

| 责任单元 | 所有状态 / 操作 |
|---|---|
| Agent 设置界面 | Provider 表单、工作空间路径、密钥输入状态、SOULS 文本和加载/保存反馈 |
| SettingsController / SettingsService | DTO 校验、本机设置 API 响应、本机文件初始化、配置读取和替换；独占 config.toml 与 SOULS.md，并提供独立 workspace 与托管文件路径 |
| LlmService / workspace-file-tools | 每个新 Pi session 读取 Provider、风格和 workspace；Pi cwd 与 read/edit/write 工具同根；文件工具执行读取与修改权限检查 |
| 对话持久化 | Conversation 和消息仍归 ConversationsService / SQLite；设置不写入对话数据库 |

## 接口与文件契约

- GET /api/settings 返回 llm.provider、各 Provider 字段和明文 API Key、apiKeyConfigured、configDirectory、workspacePath、风格文本及本机文件路径。
- PUT /api/settings 接收完整 Provider 表单、workspacePath 和 souls 文本；密钥可省略以保留当前值，clearApiKey: true 才清除对应密钥。GET /api/settings 返回已保存明文 Key。
- `~/.tech-forge/config.toml` 保存 `[llm]`、`[llm.deepseek]`、`[llm.custom]` 和 `[workspace].path` 字段；TOML 中的 API Key 是明文。缺少 workspace.path 或仍等于旧默认 `.tech-forge/` 时映射到 `~/.tech-forge/workspace/`。
- ~/.tech-forge/SOULS.md 是后续新 session 的用户风格提示；正在运行的 session 不受后续保存影响。
- `SettingsService.getLlmSettings()` 仍只返回模型字段；`LlmService` 单独调用 `getWorkspacePath()`，并只取得 config.toml / SOULS.md 路径供文件工具拒绝访问，设置文件本身仍只由 `SettingsService` 读写。
- Agent 可读取任意来源的普通文件，但不可读取 config.toml / SOULS.md 本体、符号链接或硬链接别名，也不可读取 SettingsService 原子替换时创建的同目录临时文件。创建、编辑和建目录在后端文件工具中默认限制在 workspace；仅当前用户请求明确表达写入意图且给出一个无歧义绝对目标时，可在该轮临时写入授权目录或文件。外部目标的父目录必须存在；该授权不会从会话历史、文件内容或模型输出继承。

## 设计来源差异

用户本次明确要求 API Key 与其他模型配置一起保存到用户目录 config.toml。候选设计 [system-configuration-design.md](../../../source/system-configuration-design.md) 建议 API Key 存操作系统安全存储；此项按本次用户要求实施，原始草案保留为历史输入。该差异及权限边界见[变更设计](../../../changes/2026-11-07-local-agent-settings/design.md)。

## 代码入口

- Desktop 设置页：apps/desktop/src/features/settings/SettingsPage.tsx
- Agent 视图入口：apps/desktop/src/features/agent/AgentChatPage.tsx、ConversationSidebar.tsx
- HTTP DTO / Controller / 文件服务：apps/backend/src/settings/
- Session cwd、模型提示词与工具注册：apps/backend/src/llm/llm.service.ts
- Agent 文件读写边界：apps/backend/src/llm/tools/workspace-file-tools.ts

## 验证

- 构建：npm run build
- 桌面人工检查与未执行项：见[变更验收](../../../changes/2026-11-07-local-agent-settings/verification.md)。
