---
status: current
layer: platform
domain: tech-stack
canonical_for:
  - current-tech-stack
related:
  - docs/current/platform/index.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/platform/agent-runtime.md
  - docs/current/domains/documents/index.md
  - docs/current/domains/retrieval/index.md
  - docs/current/domains/system-settings/index.md
  - docs/source/后端架构设计.md
last_verified: 2026-11-09
---

# 技术栈当前事实

本页只列**仓库里已安装并在运行链路上被使用**的技术。版本列是仓库声明的范围，括号内是 2026-11-09 在本机 `node_modules` 实际解析到的版本；行为细节以对应 `current/` 页面为准，本页不重复。

## 1. 运行时与工程

| 项目 | 事实 |
|---|---|
| Node.js | `engines.node >= 22.19.0`（本机运行 25.9.0）；后端已按 CommonJS 编译，Pi SDK 等 ESM 包经 `new Function("import")` 动态加载 |
| 包管理 | npm workspaces（`apps/backend`、`apps/desktop`），单一根 `package-lock.json` |
| TypeScript | 5.9.3（根声明，`@types/node` 24.19.2） |
| 构建工具链 | Nest CLI 11.0.24；桌面端 Electron 主进程用 `tsc`，渲染层用 Vite |
| 开发编排 | `concurrently` 10.0.6、`wait-on` 9.5.1、`cross-env` 10.1.0（根 `package.json` 脚本） |

## 2. 进程与构建产物

| 环节 | 事实 |
|---|---|
| 后端编译 | `nest build`（tsc）→ `apps/backend/dist`，CJS；启动 `node dist/main.js` |
| 后端托管 | 开发态 Electron Main 用 `spawn('node', [entry])`；`app.isPackaged` 时改用 `utilityProcess.fork`（`apps/desktop/electron/main/main.ts`） |
| 桌面主进程 | `tsc -p tsconfig.electron.json` → `dist-electron`，`module: commonjs`，`lib ES2024 + DOM` |
| 渲染层 | Vite 8.3.6 + `@vitejs/plugin-react` 6.2.1 + Tailwind 4.3.4（`@tailwindcss/vite`） |
| 测试构建 | 后端用例用 `tsc -p tsconfig.build.json --outDir .test-dist`；桌面用例读取 `dist-electron`（`tsc -p tsconfig.electron.json`）后由 `node --test` 运行 |

## 3. 后端

| 依赖 | 声明（安装） | 用途 |
|---|---|---|
| `@nestjs/common` / `core` / `platform-fastify` | ^12.3.3（12.3.3） | 模块、DI、HTTP（Fastify 适配器） |
| `fastify` | ^5.12.8（5.12.8） | HTTP/SSE 服务器 |
| `typeorm` + `@nestjs/typeorm` | ^1.1.2 / ^12.0.2（1.1.2 / 12.0.2） | 实体映射与 migration（`migrationsRun`、`migrationsTransactionMode: all`） |
| `better-sqlite3` | ^13.0.3（13.0.3） | 原生 SQLite 驱动；本机安装在 `apps/backend/node_modules`，未提升到根 |
| `class-validator` / `class-transformer` | ^0.15.1 / ^0.5.1 | DTO 校验与转换 |
| `reflect-metadata` / `rxjs` | ^0.2.2 / ^7.8.2（0.2.2 / 7.8.2） | 装饰器元数据（`main.ts` 首行导入）；`rxjs` 由 Nest 运行时使用，源码只有 `llm.service.ts` 一处未使用的 `of` 导入 |
| `typebox` | ^1.3.27（1.3.27） | 工具参数 schema 类型：由 Pi SDK 与 `pi-memory` 实际构造，本仓库声明用于对齐 SDK 的 `ToolDefinition` 类型，源码无直接 import |

后端没有 `devDependencies`，共享工具链全部来自根 `package.json`。

## 4. 存储、检索与文档解析

| 依赖 / 机制 | 事实 |
|---|---|
| SQLite 配置 | `journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`（`database.options.ts`） |
| 词法索引 | FTS5 虚拟表 `chunk_fts` + `bm25(...)` 权重，代价与参数见[知识库检索](../domains/retrieval/index.md) |
| 向量检索 | 向量存于 `chunk_embeddings`，按 `embeddingModel + embeddingDim` 过滤后在**进程内**点积；未使用 `sqlite-vec`（无该依赖） |
| `@huggingface/transformers` | ^4.3.2（4.3.2）：ONNX `feature-extraction` 管线，`allowRemoteModels = false`，模型来自 `apps/backend/assets/models/bge-small-zh-v1.5` |
| 嵌入模型 | `bge-small-zh-v1.5`，`dtype: q8`，512 维（模型不支持降维） |
| `@huggingface/tokenizers` | ^0.2.0：分块时统计 token 数 |
| `pdfjs-dist` | ^6.5.438：PDF 文本解析（纯 ESM，经 `load-esm.ts` 运行时导入） |
| `mammoth` | ^1.13.0：DOCX → Markdown（其 `.d.ts` 缺 `convertToMarkdown` 声明，代码内做了运行时收窄） |
| 纯文本 | Markdown / TXT 由 `plain-text.parser.ts` 直接读取 |

## 5. Agent 与模型接入

| 依赖 | 声明（安装） | 用途 |
|---|---|---|
| `@earendil-works/pi-coding-agent` | ^1.5.0（1.5.0） | session、工具循环、资源加载器；扩展文件由内置 jiti 编译 |
| `pi-memory` | ^0.4.2（0.4.2） | 记忆扩展：`memory_*` / `scratchpad` 工具与系统提示词记忆注入，装载方式与边界见 [Agent Runtime](agent-runtime.md) |
| 外部 LLM | 无 SDK 依赖 | DeepSeek 与自定义 Provider 由 `DeepseekLLMAdapter` / `CustomLLMAdapter` 注册进 `ModelRuntime`，配置来源 `~/.tech-forge/config.toml` |

## 6. 桌面端

| 依赖 | 声明（安装） | 用途 |
|---|---|---|
| `electron` | ^45.2.3（45.2.3） | 主进程、Preload、`utilityProcess` |
| `react` / `react-dom` | ^19.3.1（19.3.1） | 渲染层 |
| `@assistant-ui/react` + `@assistant-ui/react-markdown` | ^0.15.32 / ^0.14.24（0.15.32 / 0.14.24） | 对话线程、消息渲染 |
| `remark-gfm` | ^4.0.1（4.0.1） | Markdown 表格等 GFM 语法 |
| `@phosphor-icons/react` | ^2.1.10（2.1.10） | 图标 |
| `vite` / `@vitejs/plugin-react` / `tailwindcss` / `@tailwindcss/vite` | ^8.3.6 / ^6.2.1 / ^4.3.4（同） | 渲染层构建与样式 |

## 7. 已声明但未接入运行链路

| 依赖 | 安装 | 现状 |
|---|---|---|
| `billion-context-pi` | 0.1.83 | 只有 `llm.service.ts` 中的类型别名 `BillionContextPi`（无任何调用），`DefaultResourceLoader` 也未装载 |
| `pi-subagents` | 0.86.0 | 同上，仅类型别名 `PiSubagents`；`subagent` 工具未启用 |

这两项是遗留声明，既不代表已生效能力，也不代表已被评估否决；上下文压缩是否由 `billion-context-pi` 负责仍属未结论事项，见 [Agent Runtime 待办问题](../../source/agent-runtime-open-questions.md)。按现状不要假设扩展会自动压缩历史。

## 8. 升级与兼容约束

- `pi-memory` 的 peer 要求是 `@earendil-works/pi-ai` / `pi-coding-agent >= 0.81.1`；它只发布未编译的 `index.ts`（`type: module`），升级后必须确认经 `additionalExtensionPaths` 仍能被 jiti 装载，并且工具名/`before_agent_start` 钩子签名未变（否则 allowlist 与记忆注入会静默失效）。
- `better-sqlite3` 与 `@huggingface/transformers` 是原生/ONNX 依赖，安装位置在 `apps/backend/node_modules`；Electron 打包后的 ABI 与加载路径仍属待验证项，风险记录见[后端架构设计](../../source/后端架构设计.md)。
- 渲染层与主进程共享的类型放在 `apps/desktop/src/types/`，主进程编译目标固定 CommonJS；引入仅 ESM 的包需沿用后端的动态导入做法。

## 代码入口

- 依赖声明：`package.json`、`apps/backend/package.json`、`apps/desktop/package.json`
- SQLite 连接与 pragma：`apps/backend/src/database/database.options.ts`、`database/migrations/`
- 文档解析适配器：`apps/backend/src/platform/document-parser/parsers/`
- 本地嵌入：`apps/backend/src/embedding/embedding.service.ts`
- Agent 与扩展装载：`apps/backend/src/llm/llm.service.ts`
- 桌面进程管理：`apps/desktop/electron/main/main.ts`
