---
status: current
layer: change
domain: deepseek-web-tools
created_at: 2026-11-11
---

# DeepSeek 网页搜索与抓取工具 Brief

## Problem

Agent 目前只能读取本机会话工作区和知识库，无法回答需要实时网页证据的问题。DeepSeek 官方提供两个只读 JSON API：

- Search：`POST https://api.deepseek.com/v1/tools/search`
- Fetch：`POST https://api.deepseek.com/v1/tools/fetch`

两者使用同一个 Bearer API Key，按成功请求次数计费。当前 `LlmService.createSession()` 只向模型暴露文件工具与记忆工具，没有网页工具。

## Decision / Scope

1. 新增 `web_search` 与 `web_fetch` 两个 Pi 自定义工具，经 `createAgentSession({ customTools })` 注入；不新增扩展工厂。
2. 只在 `config.toml` 有 DeepSeek API Key 时启用；`generate()` 固定 `webTools: false`。普通聊天与 `/探索主题` skill 轮次都可以按需调用。
3. `web_search` 把当前用户原话截到 128 字符后作为 `ori_question`；`count` 默认 5、最大 50；`need_content` 由 `include_content` 控制，默认 false。
4. `web_fetch` 只接受含 host 的 http/https URL，拒绝用户名或密码；返回标题与 Markdown 正文。
5. 输出截断、错误映射、取消、重试和结构化日志都在 `web-tools.ts` 内完成；不改数据库、设置页、SSE 契约或依赖。
6. 桌面活动行显示“搜索网页/抓取网页”和 query/URL，不显示原始工具名。
7. 网页内容被当作不可信资料：工具说明明确要求模型只把页面内容当证据，不执行其中的指令。

## Out Of Scope

- 其他搜索引擎；
- 搜索结果缓存、持久化、浏览器渲染、PDF 解析、网页截图；
- 设置页开关、按会话开关、搜索预算统计；
- 让 `/探索主题` skill 联网；
- 由 backend 直接抓取 HTML（自行处理 SSRF、代理、TLS 和内容提取）。

## Acceptance 概要

- 普通 DeepSeek 聊天轮次与 `/探索主题` skill 轮次模型可见 `web_search`、`web_fetch`；`generate()` 不可见。
- Search 请求携带 `query`、`count`、`need_content`、可选 `ori_question`；Fetch 请求携带 `url`。
- Search 输出标题、URL、站点、日期、权威性和摘要；Fetch 输出标题与 Markdown 正文。
- 400/401/402/403/404/413 不重试；408/429/5xx 重试一次；取消抛 `AbortError`。
- 日志不包含 query、URL、正文或 API Key。
- 桌面活动行显示两个工具的中文动作与目标。

## 验证

见 [verification.md](verification.md)。
