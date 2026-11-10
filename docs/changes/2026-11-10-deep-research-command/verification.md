---
status: current
layer: change
domain: deep-research
canonical_for:
  - deep-research-command-verification
last_verified: 2026-11-10
version: 1.0
---

# `/探索主题` 验证

验证以真实 backend 进程 + 真实 SQLite + 真实内置 embedding + 真实 DeepSeek Provider 为准。

## AC

| AC | 断言 | 证据 |
|---|---|---|
| AC1 命令解析 | 单独的 `/探索主题`、`/探索主题化 …`、句中命令都不触发；有主题时剥掉命令 | `test/deep-research.test.cjs` · `the deep-research command is a leading-token switch` |
| AC2 命令组合 | `/探索主题 /查询资料库 主题` 与反序都得到 `research=true`、`knowledge=true`、纯主题 | 同上 · `knowledge and research commands compose in either order` |
| AC3 skill 安装并可发现 | 模板安装到临时 `<configDir>/skills`；已有 `SKILL.md` 时再次安装不覆盖用户文件；与运行时相同的 `noSkills: true` + `additionalSkillPaths` 能加载 `deep-research`，`baseDir` 指向安装目录 | 同上 · `the bundled deep-research skill installs into the config skills root and is discoverable` |
| AC4 固定检索 | `/探索主题 光合作用` 调一次 `KnowledgeService.buildContext`，query 是纯主题；模型收到 `promptContext` | `test/agent-stream.test.cjs` · `deep research forces knowledge retrieval and loads the bundled skill` |
| AC5 普通轮次不检索 | 普通主题不调 `buildContext`，`skillName` 为 `undefined` | 同上 · `a plain turn does not retrieve knowledge or load a skill` |
| AC6 skill 作为首 token | 模型 prompt 为 `/skill:deep-research <context>\n\n## 用户输入\n<主题>`，`expandPromptTemplates: true` | 同上 · `a requested skill becomes the first token of the model prompt` |
| AC7 skill 缺失显式失败 | `createSession()` 在 reload 后查找 skill，不存在时抛 `Pi skill not found: <name>.` | 代码审查；`llm.service.ts` |
| AC8 真实产物 | 真实 backend 一轮生成 `知识文档.md` 与 `知识地图.svg`，均登记为 `session` artifact | 端到端 smoke（见下） |
| AC9 文档质量门 | 文档含证据与来源表，引用资料库分片 10 处 | 端到端 smoke（见下） |
| AC10 SVG 自包含 | `viewBox` 存在；无 `<script>`、无 `<foreignObject>` | 端到端 smoke（见下） |
| AC11 产物归属 | 两个 artifact 的 `external=false`，位于会话工作区 | 端到端 smoke（见下） |

## 自动化命令

| 命令 | 结果 |
|---|---|
| `npm run build --workspace @teachforge/backend` | 通过 |
| `npm run test:deep-research --workspace @teachforge/backend` | 3/3 通过 |
| `npm run test:agent-stream --workspace @teachforge/backend` | 17/17 通过 |
| `npm run verify:artifacts --workspace @teachforge/backend` | `artifact verification passed` |
| `npm run build --workspace @teachforge/desktop` | `tsc` + `vite build` 通过 |

## 端到端 smoke

环境：临时 `TEACHFORGE_CONFIG_DIR` / `TEACHFORGE_DATA_DIR`，真实 SQLite migration、真实 `bge-small-zh-v1.5` 分块与向量、真实 DeepSeek `deepseek-flash`。

1. 入库一份 1 分片的 Markdown《生物讲义》，内容覆盖光合作用、光反应、暗反应和“工厂用电与原料”教学类比。
2. 启动真实 `dist/main.js`，POST `/api/chat/stream`：
   ```json
   {"prompt":"/探索主题 光合作用"}
   ```
3. 结果：

| 项 | 观测 |
|---|---|
| 会话 | `879c43d6-3404-4599-bbc0-af94a57cc34e` |
| 检索 | 日志 `"knowledgeOutcome":"injected"`，1 个分片 |
| 命令 | 日志 `"researchCommand":true` |
| skill | 日志 `"skillName":"deep-research"` |
| artifact 1 | `知识文档.md`，markdown，`external=false`，5201 字符 |
| artifact 2 | `知识地图.svg`，svg，`external=false`，7458 字符 |
| 文档 | 含 `证据与来源`，`[资料库：` 引用 10 处 |
| SVG | 含 `<svg` 与 `viewBox`；无 `<script>`、无 `<foreignObject>` |
| 落盘路径 | `deep-research/photosynthesis/知识文档.md`、`deep-research/photosynthesis/知识地图.svg` |

本轮真实模型还执行了多轮 `write`/`read` 工具（事件序列含多次 `tool_execution_start/end`），说明 skill 的阶段门与自检步骤实际运行，而不是一次性输出文本。

## 人工与视觉限制

- 桌面端只做了类型检查与生产构建，未在 Electron 窗口内用鼠标完成“输入 `/` → 选择探索主题 → 发送”的人工点击验收。菜单项与 chip 的渲染由现有 assistant-ui composer 结构保证：新增项进入同一个 `SLASH_COMMANDS` 列表，chip 通过 `getSlashCommand()` 读取标签与图标。
- 真实模型的产物质量仍依赖 Provider：本地 smoke 证明流程、文件、登记和 SVG 自包含约束可被遵循；但模型仍可能在其它主题上漏写 SVG 或写出过密的分支，skill 只能通过阶段门与自检降低概率，不能从代码上强制。
- 检索深度沿用 8 分片预算；资料库覆盖不足时，文档会以 `[补充背景]` / `[待核实]` 标注，而不是自动扩大检索。

## 回归

- 既有 `/查询资料库` 路径未变：命令解析、注入、去重、artifact 与 workspace 边界测试全部通过。
- `ArtifactsService.registerArtifact()` 现在用 canonical path 判断文件是否在会话工作区，修复了“配置目录含符号链接祖先（如 macOS `/var` → `/private/var`）时，Agent 写出的会话文件被误标为 external”的问题；`verify:artifacts` 通过。
- 实际安装位置已核对：`~/.tech-forge/skills/deep-research/SKILL.md` 存在；用同一 `DefaultResourceLoader` 配置读取时，`deep-research` 的 `baseDir` 为 `/Users/heyuchen/.tech-forge/skills/deep-research`。
