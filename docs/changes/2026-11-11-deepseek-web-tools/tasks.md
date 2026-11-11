---
status: current
layer: change
domain: deepseek-web-tools
created_at: 2026-11-11
---

# DeepSeek 网页搜索与抓取工具任务

## Backend

- [x] 新建 `web-tools.ts`：`WEB_TOOL_NAMES`、TypeBox 参数、启用条件、HTTP 调用、输出格式化、错误映射、重试/取消、结构化日志。
- [x] 新建 `web-tools.test.cjs`，覆盖请求形状、`ori_question`、输出截断、URL 校验、HTTP 状态、重试、取消、超时和隐私日志。
- [x] `llm.service.ts` 注入 `customTools` 与 `toolAllowlist`；`generate()` 传 `webTools: false`；session 完成日志记录 `webToolsEnabled`/`webToolCount`。
- [x] `package.json` 增加 `test:web-tools`。

## Desktop

- [x] `tool-activity-label.ts` 增加 `web_search`/`web_fetch` 文案与 query/URL 展示，长度截断。
- [x] `tool-activity-label.test.cjs` 覆盖两个工具与长 URL 截断。

## Skill

- [x] 更新 `apps/backend/assets/skills/deep-research/SKILL.md`：工具列表、网络补充规则、`[网络：标题 · URL]` 证据标签、网络来源表、阶段门与最终摘要。
- [x] 移除 skill 轮次的 web 工具禁用；`areWebToolsEnabled()` 只判断 API Key 与显式开关。
- [x] `deep-research.test.cjs` 增加安装后包含 `web_search`/`web_fetch`/`[网络：` 且不再声明“没有联网”的断言。
- [x] 同步已安装副本 `~/.tech-forge/skills/deep-research/SKILL.md`（确认与模板一致后复制）。

## Docs

- [x] `docs/current/platform/agent-runtime.md`：运行职责、工具启用条件、日志、扩展边界、skill 网络补充、代码入口。
- [x] `docs/current/index.md` 更新 Agent Runtime 摘要。
- [x] `docs/manifest.yaml` 增加 `deepseek-web-tools` 路由并关联设计文档。
- [x] `docs/changes/README.md` 增加变更记录。

## Verification

- [x] `npm run test:web-tools --workspace @teachforge/backend`：16 passed。
- [x] `npm run test:conversation-history --workspace @teachforge/desktop`：13 passed。
- [x] `npx tsc --project tsconfig.build.json --noEmit`：通过。
- [ ] 真实 DeepSeek Search/Fetch 冒烟：本次未执行，避免消耗用户账号额度；请求/响应契约由 fake transport 测试覆盖。
