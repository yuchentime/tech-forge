---
status: implemented
layer: change
domain: system-settings
created_at: 2026-11-07
version: 2.0
acceptance_review_status: approved
---

# 本机工作空间设置验收

> AC-01 至 AC-04 记录已交付的 v1.0 行为，作为历史验收保留。v2.0 的 AC-05 至 AC-10 定义当前实施要求，并在冲突处取代 v1.0。

## Acceptance Criteria

### AC-01 默认工作空间兼容旧配置

| 要素 | 内容 |
|---|---|
| 代码位置 | apps/backend/src/settings/settings.service.ts：SettingsService 配置目录初始化与 TOML 读取/序列化 |
| 前置条件 | 首次启动或读取未包含 workspace.path 的旧 config.toml |
| 预期行为 | 新配置默认 workspacePath 等于 config.toml 所属目录；旧配置读取时回退到同一目录 |
| 禁止出现 | 旧配置因缺少新字段而启动失败、清空 Provider 配置或改写其它路径 |
| 判定方式 | 对照默认配置、旧配置回退分支及序列化字段 |

### AC-02 设置页读取、编辑和恢复默认

| 要素 | 内容 |
|---|---|
| 代码位置 | apps/desktop/src/features/settings/SettingsPage.tsx；GET/PUT /api/settings |
| 前置条件 | 用户打开设置页，编辑工作空间或点击恢复默认目录 |
| 预期行为 | 输入框回填保存值；恢复默认将值设为 config.toml 所属目录；保存后响应回填规范化值 |
| 禁止出现 | 未提交输入因请求失败丢失；重置默认误改模型、API Key 或 SOULS |
| 判定方式 | 检查表单状态、PUT DTO 和成功响应回填 |

### AC-03 SettingsService 提供专用读取方法且不扩展 LLM 链路

| 要素 | 内容 |
|---|---|
| 代码位置 | apps/backend/src/settings/settings.service.ts：SettingsService；apps/backend/src/llm/llm.service.ts |
| 前置条件 | 后续本地业务代码从 SettingsService 读取路径 |
| 预期行为 | SettingsService 提供返回绝对工作空间路径的公开 getter；LLM 设置读取对象不包含 workspacePath |
| 禁止出现 | 本次把路径注入 LlmService、AgentService、session、工作区工具或改变 process.cwd() |
| 判定方式 | 对照公开 getter、StoredLlmSettings 类型和 LlmService diff |

### AC-04 路径格式和持久化边界

| 要素 | 内容 |
|---|---|
| 代码位置 | apps/backend/src/settings/settings.dto.ts；SettingsService.saveSettings() |
| 前置条件 | 用户提交相对路径、绝对路径或尚不存在的绝对路径 |
| 预期行为 | 相对路径返回明确 400 且保留旧 TOML；合法绝对路径可保存，即使目标目录尚不存在 |
| 禁止出现 | 保存路径时自动创建目录、迁移文件、改变 SQLite 或 Agent 当前工作目录 |
| 判定方式 | 检查 DTO 边界、路径规范化和文件 I/O 范围 |

## Required Automated Checks

- Backend、Renderer、Electron 的 TypeScript noEmit 检查均通过，详见 worklog.md。
- `git diff --check` 通过；只有仓库现有文件的 LF/CRLF 转换提示。
- 按任务约束不新增或运行测试。

## Required Manual Checks

- [ ] [L3] 尚未在 Electron 中手动确认设置页保存和重开；类型检查覆盖已完成，桌面人工检查待后续运行环境确认。
  - 原因：设置表单布局与当前运行 backend 版本需在桌面应用中确认。
  - 判断标准：路径显示正确，保存和重置不影响其它设置。

## Must-Not-Break Checks

- [ ] Provider、API Key 与 SOULS.md 可继续读取和保存。
- [ ] Agent 当前工作目录、工具范围、对话历史和 SQLite 路径保持不变。
- [ ] Renderer 仍通过受限 desktop request bridge 访问 backend，不获得文件系统能力。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
|---|---|---|---|---|
| 新安装生成配置 | workspace.path 等于 config.toml 所属目录 | L1 | 检查初始化与默认序列化 | 保持用户要求的默认位置 |
| 旧配置无 workspace.path | 设置读取返回默认目录且保留现有模型字段 | L1 | 检查兼容回退 | 防止升级导致配置失效 |
| 保存和重新打开 | workspacePath 回填为已保存绝对路径 | L3 | 桌面人工检查 | 验证 UI/API/TOML 闭环 |
| 提交相对路径 | 返回 400，原 config.toml 保持不变 | L1 | 检查验证与写入顺序 | 避免歧义或破坏配置 |
| 目标目录不存在 | 路径可保存，但不创建目录 | L1 | 检查文件 I/O 范围 | 保持设置层无目录副作用 |

## Known Guardrails

- 不把 workspacePath 混入 LlmService 的 Provider 配置对象。
- 不创建、搬移或清理用户工作空间目录。
- config.toml 写入失败时保留原文件。

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
|---|---|---|
| AC-01 | pass | 现有 SettingsService 已拥有 configDirectory 与 TOML 文件读写。 |
| AC-02 | pass | 现有 SettingsPage 和 GET/PUT /api/settings 是表单与持久化入口。 |
| AC-03 | pass | SettingsService 是当前配置所有者；LlmService 现有读取仅用于模型配置。 |
| AC-04 | pass | DTO 与 saveSettings() 是现有 API 校验和文件替换边界。 |

- acceptance_review_status: approved
- 评审结论：AC 已对照现有设置 API、文件所有权和 LLM 边界核对；实现只新增 workspace 路径契约。
- 评审方 / 确认人 / 时间：实现代理 / 2026-11-07

## v2.0 Acceptance Criteria

### AC-05 默认输出目录与旧配置迁移

| 要素 | 内容 |
|---|---|
| 代码位置 | `SettingsService.initializeFiles()`、`createDefaultSettings()`、`parseSettings()`、`normalizeWorkspacePath()`；`SettingsPage` 恢复默认操作 |
| 前置条件 | 新安装、旧 `config.toml` 缺少 `workspace.path`，或其值恰好为 `.tech-forge` 配置目录 |
| 预期行为 | 默认路径为 `<configDirectory>/workspace`；旧缺省值及旧默认路径映射到子目录；UI 恢复默认使用同一路径；配置目录本身和其祖先不能成为 Agent workspace |
| 禁止出现 | 将 Agent 写入根设置目录或其祖先；旧缺省配置导致启动失败；将自定义且不等于旧默认的绝对路径静默改写 |
| 判定方式 | 走查默认配置、旧值兼容、路径规范化与 UI 默认路径计算 |

### AC-06 Pi session 工作目录统一

| 要素 | 内容 |
|---|---|
| 代码位置 | `LlmService.createSession()` 中 `SettingsService.getWorkspacePath()`、`DefaultResourceLoader`、`SessionManager.inMemory()`、`createAgentSession()` 和 `createWorkspaceFileTools()` 调用 |
| 前置条件 | `LlmService.stream()` 或 `generate()` 创建 session |
| 预期行为 | Pi `cwd`、资源加载、恢复会话分组及自定义文件工具共用已保存 workspace；`agentDir` 仍由 `sdk.getAgentDir()` 返回 |
| 禁止出现 | 用 `process.cwd()` 作为 Pi session 的项目 workspace；改动 app 配置位置、SQLite 位置或 Pi 的独立 `agentDir` |
| 判定方式 | 对照 `createSession()` 的每个 cwd 入口及 `SettingsService.getWorkspacePath()` |

### AC-07 任意来源读取与系统文件保护

| 要素 | 内容 |
|---|---|
| 代码位置 | `apps/backend/src/llm/tools/workspace-file-tools.ts`：`createWorkspaceFileTools()` 的 read `access`、`readFile`、`detectImageMimeType` 操作；`SettingsService` 固定配置文件路径 |
| 前置条件 | Agent 读取 workspace 之外的绝对普通文件，或尝试读取 `.tech-forge/config.toml` / `SOULS.md` |
| 预期行为 | 可读取任意来源的普通文件；拒绝直接路径、符号链接别名、硬链接别名及应用设置原子替换的同目录临时文件 |
| 禁止出现 | 以任意来源读取为由暴露应用 API Key 配置；允许读取目录或特殊文件 |
| 判定方式 | 代码走查规范路径与文件身份检查，以及 read 操作调用边界 |

### AC-08 默认写入范围不可越界

| 要素 | 内容 |
|---|---|
| 代码位置 | `workspace-file-tools.ts`：`createWorkspaceFileTools()` 的 edit/write `access`、`readFile`、`writeFile` 和 write `mkdir` 操作；现有 `resolveWorkspaceFile()`、`ensureWorkspaceDirectory()`、`workspaceBoundaryError()` |
| 前置条件 | Agent 在默认工作空间内外执行创建、编辑或建目录，包括 `..`、绝对路径、符号链接或托管文件硬链接别名 |
| 预期行为 | 默认工作空间内普通路径可写；路径穿越、符号链接出界、配置文件身份别名和工作空间外写入被文件操作适配层拒绝，拒绝沿用稳定的 `EWORKSPACE` 错误码 |
| 禁止出现 | 只依赖系统提示词拦截；Pi 工具对工作空间外产生文件写入 |
| 判定方式 | 检查每个实际文件操作都在 I/O 前通过根目录、链接和托管文件校验 |

### AC-09 外部写入许可只来自本轮明确请求

| 要素 | 内容 |
|---|---|
| 代码位置 | `AgentService.stream(prompt, ...)` 到 `LlmService.stream(prompt, ...)` 的本轮输入链；`LlmService.createSession()` 创建的 workspace 文件工具 |
| 前置条件 | 当前请求明确表达写入意图并给出唯一、无歧义、当前平台有效的绝对外部目录或文件路径；含空格路径使用引号，或请求未提供该信息 |
| 预期行为 | 有效目录许可仅限该目录及其下级；有效文件许可仅限该文件且要求父目录已存在；许可只存活于本轮 session；不完整或歧义请求默认拒绝 |
| 禁止出现 | 从对话历史、读取文件内容、模型输出、工具参数或 `generate()` 推导外部授权；外部文件授权创建其父目录；系统托管文件获得例外 |
| 判定方式 | 检查授权输入只绑定当前流式 prompt、权限只传给当前 session，所有 I/O 仍由 `workspace-file-tools.ts` 校验 |

### AC-10 文件职责和安全理由有代码注释

| 要素 | 内容 |
|---|---|
| 代码位置 | `SettingsService`、`LlmService.createSession()`、`workspace-file-tools.ts` 的文件职责和权限边界 |
| 前置条件 | 阅读或后续修改本地配置、session cwd 或 Agent 文件工具 |
| 预期行为 | 注释明确指出 config/SOULS 由 SettingsService 独占、默认 workspace 是 Agent 写入根、本轮外部许可的信任来源和文件工具实际强制检查的位置 |
| 禁止出现 | 将提示词当权限边界；以含糊注释让后续调用方把配置文件交给 Agent 写入 |
| 判定方式 | 代码走查安全相关函数与调用点旁的责任说明 |

## v2.0 Required Automated Checks

- Backend、Renderer、Electron TypeScript `--noEmit` 检查通过；仅作静态类型与接口一致性证据，不宣称覆盖真实文件系统安全。
- `git diff --check` 通过；不新增或运行测试，按本任务执行约束记录。

## v2.0 Required Manual Checks

- [ ] [L3] 在桌面会话中确认 workspace 下生成文件、读取 workspace 外普通文件、拒绝默认越界写入、当前轮明确外部路径可写，以及 config/SOULS 不可由工具读写。
  - 原因：真实 Pi tool round-trip 和 Windows 文件系统链接行为依赖 Electron/backend 运行环境。
  - 执行人：开发者。
  - 判断标准：每个文件 I/O 结果符合 AC-05 至 AC-09；拒绝时工具返回可理解的安全错误。

## v2.0 Must-Not-Break Checks

- [ ] config.toml 与 SOULS.md 始终固定在 `.tech-forge/`，API Key 不进入 Agent 文件工具。
- [ ] 工作空间路径与模型设置仍由同一个本机设置流程保存，`getLlmSettings()` 投影不包含 workspace 字段。
- [ ] 任意来源读取不扩展 renderer 的文件系统权限，也不重新启用 bash/subagent。

## v2.0 Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
|---|---|---|---|---|
| 新配置或旧缺省 workspace | 默认 `<configDirectory>/workspace` | L1 | 静态检查配置默认和兼容分支 | 不让 Agent 默认写到应用配置所有目录 |
| Pi session 创建 | loader、session manager、session 和文件工具使用同一 workspace cwd | L1 | 检查 `LlmService.createSession()` 参数 | 避免资源发现与写入边界错位 |
| 读取任意外部普通文件 | 可读；config/SOULS 本体及链接/硬链接别名拒绝 | L1/L3 | 走查路径与 inode 检查；桌面手动确认 | 支持任意来源输入且保护应用凭据 |
| 默认写入越界或通过符号链接越界 | 以 `EWORKSPACE` 拒绝 | L1/L3 | 走查所有操作适配器；桌面确认工具失败 | 防止模型绕过提示写到 workspace 外 |
| 当前请求明确唯一外部目标 | 许可只覆盖本轮目标范围 | L1/L3 | 走查授权来源和 session 作用域；桌面确认 | 用户本轮明确指定时支持例外，同时防止历史/文件内容授予权限 |

## v2.0 Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
|---|---|---|
| AC-05 | pass | `SettingsService` 已存在初始化、默认配置、完整配置解析和规范化函数；GET `/api/settings` 暴露 `configDirectory` 与 `workspacePath`，`SettingsPage` 具有恢复默认控件。按此真实代码锚点新增子目录默认和兼容规则，不引入新 API 字段。 |
| AC-06 | pass | `LlmService.createSession()`、`SettingsService.getWorkspacePath()`、Pi loader/session-manager/create-session 和 workspace file tools 均为现存入口；保留现有 `sdk.getAgentDir()`。 |
| AC-07 | pass | `createWorkspaceFileTools()` 已用 Pi 原生 read operations 适配 `access`、`readFile` 和图片 MIME 检测；`SettingsService` 已持有 config 和 SOULS 固定路径；实现走查也覆盖了 `replaceFile()` 同目录临时文件。 |
| AC-08 | pass | 已有 `resolveWorkspaceFile()`、`ensureWorkspaceDirectory()`、`workspaceBoundaryError()` 和稳定错误码 `EWORKSPACE`；写入限制可在这些现存工具操作边界扩展。 |
| AC-09 | pass | `AgentService.stream(prompt, ...)` 原样传入 `LlmService.stream(prompt, ...)`，该流式入口会创建独立 session；历史只在 `conversation` 对象另传。路径解析对歧义/未加引号的空格路径失败关闭。 |
| AC-10 | pass | `SettingsService`、`LlmService.createSession()` 和 file tools 是现有代码责任点，可在实施时就近补充明确注释。 |

- acceptance_review_status: approved
- 评审结论：AC-05 至 AC-10 已逐项对照现有实现入口、字段、方法及错误码；没有依赖新增 controller 路径或未存在错误码的判定。允许进入实现。
- 评审方 / 确认人 / 时间：实现代理 / 2026-11-08

## Version History

### v2.0 — 2026-11-08

- 触发：开发者在 v1.0 交付后确认工作空间是 Agent 产物默认目录，并要求读任意来源、默认写入绝不越界、只有本轮明确指定外部路径可例外。
- 改动内容：新增 AC-05 至 AC-10，覆盖默认目录迁移、cwd 一致性、读写分离、托管文件保护及本轮授权来源。
- 影响范围：Required Checks、Manual Checks、Must-Not-Break、Regression Matrix 与实现边界。
- 处理状态：已重新实施于 L002。
