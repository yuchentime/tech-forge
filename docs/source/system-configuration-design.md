# TeachForge 本地系统配置设计草案

- 状态：候选设计，尚非实现基线
- 更新日期：2026-11-06
- 责任单元：本机系统设置、工作空间路径与模型 Provider 配置
- 关联：[个人学习数据建模草案](data-model-design.md)、[数据表字段草案](data-model-fields.md)

## 1. 结论

设置页中的工作空间、模型厂商、模型名称和兼容端点属于本地运行配置，不进入业务 SQLite，也不新增 settings、workspace 或 provider 数据表。

普通配置写入单个 config.toml；API Key 写入操作系统安全存储。设置页负责编辑两类存储，并对用户呈现统一的配置体验。

## 2. 配置文件与位置

### 配置文件位置

Windows 建议在当前用户可写的应用配置目录中保存 config.toml，例如 Electron 的 userData 目录。安装或首次启动时创建目录和默认配置文件。

不建议默认把可变配置放在安装目录：程序可能安装到只读目录，升级也可能覆盖用户修改。若以后提供可写的便携版，再单独考虑应用目录旁的 config.toml。

### 默认工作空间

Windows 默认工作空间为当前用户目录下的 `C:\Users\{username}\.tech-forge`；安装/首次启动时从当前 Windows 用户目录解析真实路径，不把占位名写入配置。

工作空间是所有业务数据文件的根目录：原始上传文件、Agent 生成的物料文件、SQLite 数据库及其 WAL/SHM 文件，以及需要持久化的派生索引/缓存均放在工作空间内部。Agent 物料的结构化正文可以保存在工作空间内的 SQLite 数据库；导出的 PDF 等文件保存在工作空间的物料目录。候选目录布局如下，具体子目录名可在实现时确定。

| 数据 | 候选相对路径 |
|---|---|
| SQLite 主库及 WAL/SHM | database/teachforge.db |
| 上传的原始资料 | documents/originals/ |
| Agent 生成的物料及导出文件（如 PDF） | artifacts/ |
| 持久化派生索引或模型缓存 | derived/ 或 models/ |

config.toml 是应用运行配置，不属于业务数据文件，保存在工作空间之外的稳定 per-user 配置目录；这样切换工作空间时仍能找到配置。业务表保存工作空间内的相对文件路径，避免更改根目录时改写每条路径。文件访问仍由后端校验路径位于工作空间内。

## 3. config.toml 配置项

| 配置项 | 必填/默认 | 用途 |
|---|---|---|
| workspace.root | 默认解析为当前用户的 .tech-forge 目录 | SQLite、原始资料、Agent 生成物料及持久化派生数据的共同根目录 |
| llm.provider | 默认 deepseek | 当前选用 deepseek 或 openai_compatible |
| llm.model | deepseek 默认 deepseek-flash | 当前 Provider 使用的模型名 |
| llm.baseUrl | OpenAI 兼容 Provider 必填；DeepSeek 固定端点时不配置 | 自定义兼容服务的 API 根地址 |

config.toml 不保存 apiKey、secret 或其他可直接使用的凭据。当前无需保存温度、超时、Token 上限等额外选项，待产品需要时再扩展。

## 4. 模型 Provider 与凭据

| Provider | 用户设置 | 默认/规则 |
|---|---|---|
| DeepSeek | API Key、可选模型选择 | 厂商固定；默认模型 deepseek-flash；API Key 放操作系统安全存储 |
| OpenAI API 兼容 | Base URL、模型名、API Key | Base URL 和模型名进入 config.toml；API Key 放操作系统安全存储 |

设置页不把 API Key 回显到普通文本配置，不写入 SQLite、普通日志或 SSE 内容。读取或写入系统安全存储失败时明确提示，不降级为明文落盘。

DeepSeek 当前固定端点与两类 Adapter 的详细映射以现有 Provider 技术设计为依据；本草案补充用户设置来源，不表示该设置流程已实现。

## 5. 设置页行为边界

- 工作空间设置只修改 workspace.root，并验证目录可创建、可读写。
- 用户选择新工作空间时，切换后续数据库和内容文件的根目录；不自动复制旧工作空间，检测到已有数据时先让用户选择打开、创建或显式迁移。
- DeepSeek 页面提供 API Key 输入和模型选择，模型默认 deepseek-flash。
- OpenAI 兼容页面提供 Base URL、模型名和 API Key。
- 保存普通设置时更新 config.toml；保存凭据时更新操作系统安全存储。两者均不写入业务数据库。
- 保存完成后让当前 Provider 配置生效；当前运行中的模型请求继续使用启动时/请求开始时读取的配置，避免中途切换配置影响结果。

## 6. 与既有资料及代码的差异

- 功能设计文档描述 DeepSeek 和自定义兼容端点通过 DEEPSEEK_API_KEY、CUSTOM_LLM_BASE_URL、CUSTOM_LLM_API_KEY、CUSTOM_LLM_MODEL 等环境变量配置。此草案将安装后用户设置改为 config.toml + 操作系统安全存储；环境变量是否继续作为开发环境覆盖项尚未决定。
- 功能设计文档建议 Electron 将 app.getPath('userData') 传给后端作为应用数据目录；当前 database.options.ts 使用 TEACHFORGE_DATA_DIR，未提供时回退到当前工作目录下的 .data。最新用户要求明确 SQLite 主库也属于工作空间；实现时应由工作空间配置确定数据库目录，替代前述 userData/.data 目标。
- 2026-11-10 用户要求 SQLite 数据库文件默认放在用户主目录 `~/.tech-forge/`。当前实现已按此回落（配置根与数据根同为 `~/.tech-forge`，`TEACHFORGE_DATA_DIR` 可覆盖）。Electron 不再传入 `app.getPath('userData')`，而是以 `TEACHFORGE_LEGACY_DATA_DIR` 报告旧目录；backend 在目标还没有数据库时一次性迁移旧 `teachforge.db`（含 WAL/SHM）与 `documents/`。这与「由工作空间配置确定数据库目录」的草案目标仍不一致：数据目录不随 `workspace.root` 变化，该草案项尚未实现。
- API Key 使用操作系统安全存储已在功能设计文档中提出；本草案沿用该安全要求。

## 7. 待决定事项

| 问题 | 当前建议 |
|---|---|
| config.toml 的最终路径 | 优先采用用户可写的 per-user 应用配置目录；不默认使用安装目录 |
| 工作空间子目录命名 | 当前候选 documents/originals |
| 改变工作空间时的数据处理 | 默认只切换路径，不自动搬迁；如需搬迁提供显式操作 |
| 工作空间子目录布局 | SQLite、原始资料、生成物料和派生数据均位于工作空间；最终子目录名待定 |
| 环境变量配置 | 确认是否保留为开发环境覆盖项；避免与用户配置形成难以理解的多层优先级 |
| DeepSeek 模型列表 | 先支持默认 deepseek-flash，并确定可选模型列表来源及验证方式 |
| 配置热更新 | 已发起请求使用其开始时读取的配置；保存后新请求使用新配置 |


