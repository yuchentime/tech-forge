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
last_verified: 2026-11-14
---

# 本机 Agent 设置

## 当前行为

设置入口位于 Agent 对话侧栏底部。打开后主区域显示模型配置、身份设定和风格偏好；侧栏仍可切换设置与对话。设置由本机 backend 管理，不属于 SQLite 业务数据，也不通过 renderer 文件系统访问。

backend 首次启动时在当前用户主目录创建 `.tech-forge/config.toml`、空的 `.tech-forge/PREFERENCE.md`、空的 `.tech-forge/IDENTIFY.md` 和 `.tech-forge/workspace/`；首个 Agent session 创建前还会把内置 skill 模板安装到 `.tech-forge/skills/`。设置 `TEACHFORGE_CONFIG_DIR` 可把该根目录重定向到任意绝对路径（便携部署与隔离集成测试使用，默认仍是 `~/.tech-forge`）。设置页通过受本机认证保护的 GET /api/settings 和 PUT /api/settings 读取、保存配置；响应包含 DeepSeek 已保存的 API Key 明文，供本机设置页编辑。密钥输入框默认遮蔽内容，用户可点击输入框右侧的眼睛图标临时显示或再次隐藏。全局 `workspacePath`（`[workspace].path`，默认 `.tech-forge/workspace/`）已从设置页移除：Agent 改用每会话工作区，该值只剩 skills/prompts 资源锚点与无会话 session 的回退 cwd 两处用途。旧配置中缺失路径或仍指向旧默认 `.tech-forge/` 的值会映射至新的子目录。

| 配置 | 当前行为 |
|---|---|
| 模型服务 | 仅支持 DeepSeek；自定义 Provider 配置已移除 |
| DeepSeek | 模型 ID 默认 deepseek-flash，可编辑；首次使用前需配置 API Key |
| API Key | 依用户要求以明文保存在 config.toml；设置页默认遮蔽，点击眼睛图标后才显示明文；省略或留空表示保留已存值，明确清除操作才删除；仅经本机设置 API 回传给设置页，不进入 Agent SSE、普通日志或 SQLite |
| 工作空间 | 保存在 `[workspace].path`；默认值为 `.tech-forge/workspace/`；路径必须绝对，不能是 `.tech-forge` 本身或其祖先；`SettingsService.getWorkspacePath()` 返回规范化路径，但 Pi cwd 与 Agent 文件工具已改用 `getSessionWorkspaceDirectory(conversationId)` |
| 身份设定 | IDENTIFY.md 记录用户身份、学习目标和场景说明；非空文本作为 `## User identity and goals` 追加到每个新 Pi session 的系统提示词，位置在风格偏好之前；空白内容不改变提示词 |
| 风格偏好 | PREFERENCE.md 的非空文本在每个新 Pi session 的固定系统提示词之后追加；空白内容不改变提示词 |
| Agent Skill | 安装根固定为 `<configDir>/skills`（默认 `~/.tech-forge/skills/`），与 workspace 同级；backend 首次 session 前把 `assets/skills` 模板复制进去，目标 skill 已有 `SKILL.md` 时不覆盖。`PiAgentRuntime` 把该目录与用户 `<workspace>/skills` 一起加入 Pi 显式 skill 路径；用户可直接查看和编辑，不随会话删除 |

配置文件新建时 POSIX 权限为目录 0700、文件 0600；Windows 使用用户目录继承 ACL。配置写入先写同目录临时文件，再替换目标文件。应用只识别自身定义的 TOML 字段，格式错误时不会重置已有配置。保存不会迁移或改变 SQLite 的 `TEACHFORGE_DATA_DIR`；未设置该变量时数据根与配置根同为 `~/.tech-forge`，SQLite 主库位于 `<dataDir>/db/teachforge.db`（默认 `~/.tech-forge/db/teachforge.db`）。backend 在打开数据库前把旧布局的 `<dataDir>/teachforge.db`（含 WAL/SHM）迁入 `db/`；若旧 Electron `userData` 下存在 `teachforge.db` 而新位置还没有数据库，再把它（含 WAL/SHM）与 `documents/` 迁入。`<dataDir>/db/teachforge.db` 已存在时不做任何迁移。

## 责任边界

| 责任单元 | 所有状态 / 操作 |
|---|---|
| Agent 设置界面 | DeepSeek 表单、密钥输入状态、IDENTIFY 身份文本、PREFERENCE 风格文本和加载/保存反馈（工作空间路径已移除） |
| SettingsController / SettingsService | DTO 校验、本机设置 API 响应、本机文件初始化、配置读取和替换；独占 config.toml、IDENTIFY.md 与 PREFERENCE.md，并提供独立 workspace、skills、memory 目录与托管文件路径 |
| PiAgentRuntime / workspace-file-tools | 每个新 Pi session 读取 DeepSeek 配置、身份设定与风格；Pi cwd 为会话工作区，read/edit/write 工具同根；文件工具执行读取与修改权限检查；首次 session 前把内置 skill 模板安装到 `<configDir>/skills` |
| 对话持久化 | Conversation 和消息仍归 ConversationsService / SQLite；设置不写入对话数据库 |

## 接口与文件契约

- GET /api/settings 返回 llm.deepseek 的模型 ID、明文 API Key 与 apiKeyConfigured，以及 configDirectory、workspacePath、身份文本、风格文本和本机文件路径（含 preferenceFilePath 与 identifyFilePath）。
- PUT /api/settings 接收 `llm.deepseek` 表单、preference 文本和 identify 文本；workspacePath 可选，缺省保留已存值（设置页已不提供）；密钥可省略以保留当前值，clearApiKey: true 才清除已保存密钥。GET /api/settings 返回已保存明文 Key。
- `~/.tech-forge/config.toml` 只保存 `[llm.deepseek]` 和 `[workspace].path` 字段；TOML 中的 API Key 是明文。旧文件中的 `[llm]` provider 与 `[llm.custom]` 字段会被忽略，下次保存时不再写出。缺少 workspace.path 或仍等于旧默认 `.tech-forge/` 时映射到 `~/.tech-forge/workspace/`。
- ~/.tech-forge/IDENTIFY.md 是后续新 session 的用户身份与目标提示，~/.tech-forge/PREFERENCE.md 是风格提示；两者都只在创建新 session 时读取，正在运行的 session 不受后续保存影响。
- `SettingsService.getLlmSettings()` 仍只返回模型字段；`PiAgentRuntime` 单独调用 `getWorkspacePath()`、`getIdentitySetting()` 与 `getStylePreference()`，并只取得 config.toml / IDENTIFY.md / PREFERENCE.md / `<configDir>/memory` 路径供文件工具拒绝访问，设置文件本身仍只由 `SettingsService` 读写。
- Agent 可读取任意来源的普通文件，但不可读取 config.toml / IDENTIFY.md / PREFERENCE.md 本体、符号链接或硬链接别名，也不可读取 SettingsService 原子替换时创建的同目录临时文件；长期记忆目录 `<configDir>/memory` 同样不可读写，详见[长期记忆](../memory/index.md)。创建、编辑和建目录在后端文件工具中默认限制在当前会话工作区；仅当前用户请求明确表达写入意图且给出一个无歧义绝对目标时，可在该轮临时写入授权目录或文件。外部目标的父目录必须存在；该授权不会从会话历史、文件内容或模型输出继承。

## 设计来源差异

用户本次明确要求 API Key 与其他模型配置一起保存到用户目录 config.toml。候选设计 [system-configuration-design.md](../../../source/system-configuration-design.md) 建议 API Key 存操作系统安全存储；此项按本次用户要求实施，原始草案保留为历史输入。该差异及权限边界见[变更设计](../../../changes/2026-11-07-local-agent-settings/design.md)。

## 代码入口

- Desktop 设置页：apps/desktop/src/features/settings/SettingsPage.tsx
- Agent 视图入口：apps/desktop/src/features/agent/AgentChatPage.tsx、ConversationSidebar.tsx
- HTTP DTO / Controller / 文件服务：apps/backend/src/settings/
- Session cwd、模型提示词、工具注册与 skill 安装：apps/backend/src/llm/pi-agent-runtime.ts、apps/backend/src/llm/skills.ts
- Agent 文件读写边界：apps/backend/src/llm/tools/workspace-file-tools.ts

## 验证

- 构建：npm run build
- 桌面人工检查与未执行项：见[变更验收](../../../changes/2026-11-07-local-agent-settings/verification.md)。
