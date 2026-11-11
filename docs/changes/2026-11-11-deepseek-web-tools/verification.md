---
status: current
layer: change
domain: deepseek-web-tools
created_at: 2026-11-11
---

# DeepSeek 网页搜索与抓取工具验收

## 1. 自动化用例

| 编号 | 文件 | 覆盖 | 结果 |
|---|---|---|---|
| W1 | `web-tools.test.cjs` | 只注册 `web_search`/`web_fetch`，参数为对象 Schema | 通过 |
| W2 | `web-tools.test.cjs` | Search 请求路径、Bearer 鉴权、`query`/`count`/`need_content`/`ori_question` | 通过 |
| W3 | `web-tools.test.cjs` | 默认 `count=5`、`need_content=false`；`summary` 缺失回退 `snippet` | 通过 |
| W4 | `web-tools.test.cjs` | `ori_question` 截断到 128 Unicode 字符；无用户原话时省略 | 通过 |
| W5 | `web-tools.test.cjs` | 空结果不是工具错误；输出上限与“结果已截断” | 通过 |
| W6 | `web-tools.test.cjs` | Fetch 请求体、标题与 Markdown 正文；空正文失败 | 通过 |
| W7 | `web-tools.test.cjs` | 非 http/https、无 host、带用户名/密码的 URL 在请求前拒绝 | 通过 |
| W8 | `web-tools.test.cjs` | 400/401/402/403/404/428 不重试；429/500/504 重试一次 | 通过 |
| W9 | `web-tools.test.cjs` | 瞬时失败重试后成功 | 通过 |
| W10 | `web-tools.test.cjs` | 调用方取消抛 `AbortError`；超时返回可重试错误 | 通过 |
| W11 | `web-tools.test.cjs` | 日志含 `requestId`/工具名/条数，不含 query 或 URL | 通过 |
| W12 | `web-tools.test.cjs` | 有 Key 且未显式关闭时启用 | 通过 |
| W13 | `tool-activity-label.test.cjs` | `web_search`/`web_fetch` 中文动作与目标；长 URL 截断到 120 字符 | 通过 |
| W14 | `deep-research.test.cjs` | 安装后的 `SKILL.md` 包含 `web_search`/`web_fetch`/`[网络：` 指引，不再声明“没有联网” | 通过 |

命令：

```bash
npm run test:web-tools --workspace @teachforge/backend
npm run test:deep-research --workspace @teachforge/backend
npm run test:conversation-history --workspace @teachforge/desktop
```

结果：

| 日期 | 命令 | 结果 |
|---|---|---|
| 2026-11-11 | `npm run test:web-tools --workspace @teachforge/backend` | 16 passed, 0 failed |
| 2026-11-11 | `npm run test:deep-research --workspace @teachforge/backend` | 3 passed, 0 failed |
| 2026-11-11 | `npm run test:conversation-history --workspace @teachforge/desktop` | 13 passed, 0 failed |
| 2026-11-11 | `npx tsc --project tsconfig.build.json --noEmit` | 通过 |

## 2. 类型与构建

- `tsc --project tsconfig.build.json --noEmit` 通过，覆盖 `web-tools.ts` 与 `llm.service.ts` 的接线。
- `npm run build --workspace @teachforge/backend` 未完成：`nest build` 删除 `apps/backend/dist` 时返回 `EBUSY`，本机有运行中的 backend 进程锁住该目录。测试脚本的 `tsc --outDir .test-dist` 已成功编译同一份 `src`。
- 桌面 `build:electron` 成功，`tool-activity-label` 测试使用新编译产物。

## 3. 真实服务与手工检查

| 编号 | 场景 | 状态 |
|---|---|---|
| I1a | 无 Key `POST /v1/tools/search` | 通过：HTTP 401，端点存在且鉴权生效，不产生计费 |
| I1b | 无 Key `POST /v1/tools/fetch` | 通过：HTTP 401，端点存在且鉴权生效，不产生计费 |
| I2 | 使用真实 DeepSeek Key 调一次 Search | 未执行：避免消耗用户账号额度；请求/响应由 fake transport 按官方文档覆盖 |
| I3 | 使用真实 DeepSeek Key 调一次 Fetch | 未执行，原因同上 |
| I4 | 普通聊天问一个时效性问题，观察 `llm.web_tool.*` 与活动行 | 未执行（需要运行中的应用与真实模型） |
| I5 | `/探索主题` 轮次确认 allowlist 包含网页工具，且 skill 先检索资料库再按需联网 | 未执行（需要运行中的应用） |

## 4. 已知限制

- 真实 Search/Fetch 的可用性、限速与计费未在本机验证；失败会以工具错误返回，不阻断聊天。
- 网页内容是不可信资料；工具说明要求模型只当作证据，但无法从工程上消除提示注入风险。
- 没有每会话搜索预算或缓存；模型连续调用会连续计费。
- 搜索结果会作为普通工具结果进入既有 transcript 持久化，不新增独立缓存或表。
- 内置 skill 安装器不覆盖已有的 `SKILL.md`；本次已手动同步本机 `~/.tech-forge/skills/deep-research/SKILL.md`。要让所有已有用户获得 skill 更新，后续需要版本化迁移或显式覆盖策略。
