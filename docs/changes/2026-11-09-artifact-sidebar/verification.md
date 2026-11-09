# Artifact 会话文件侧边栏 — 验证

- 日期：2026-11-09

## 自动化

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端类型 | `npx tsc --noEmit -p tsconfig.build.json` | 通过 |
| 渲染进程类型 | `npx tsc --noEmit -p tsconfig.app.json` | 通过 |
| Electron 主进程与 preload | `npx tsc --noEmit -p tsconfig.electron.json` | 通过 |
| 渲染构建 | `npm run build:renderer` | 通过（Mermaid 独立 chunk，未进入首屏主包） |
| 产出文件端到端 | `npm run verify:artifacts` | 通过 |
| 历史投影回归 | `npm run test:conversation-history` | 5/5 通过 |
| 文件工具边界回归 | `node --test test/workspace-file-tools.test.cjs` | 3/3 通过 |

`verify:artifacts` 在临时数据目录中：执行新迁移 → 登记会话内文件与外部文件 → 同一路径重写保持 `id` → 列表/正文/位置 → 删除文件后 `missing` 为真 → 启动真实 HTTP 入口校验三个路由与未知 id 的 404。

## 界面

以构建产物 + 打桩的桌面桥在浏览器中验证：

- 响应消息底部出现文件 chip，点击打开右侧侧边栏，标签可关闭，关闭最后一个文件标签后侧边栏收起；
- "本会话文件"标签列出全部产出，每行右侧有文件夹图标（悬停提示"打开文件目录"）；
- Markdown 预览与内嵌 Mermaid 思维导图渲染为图形；JSON 预览为美化后的文本；
- 点击文件夹图标调用桌面桥，传入后端返回的绝对路径；
- 设置页不再出现"工作空间"输入框。

## 未覆盖

- 真实 Electron 窗口内的系统文件管理器弹出（依赖桌面环境，本次只验证到桥接调用参数）。

## 验收回归（2026-11-09，真实应用）

失败现象复现自用户数据库：会话 `dced9e47-…` 的消息行全部 `completed`，`artifacts` 有 `redis-roadmap.md`（11 132 字节），磁盘 `sessions/<cid>/workspace/redis-roadmap.md` 存在——即后端与文件写入均正常，失败发生在桌面桥。

修正后在真实 Electron 窗口（`electron .`，通过 CDP 驱动）执行同一句输入"我准备学习 redis，但是一片茫然，先给我生成一份 roadmap"：

- 回答正常完成，无"这次回答没有完成"提示；
- 回答底部出现 `redis-roadmap.md` chip 与文件夹图标；
- 点击后右侧侧边栏打开该文件标签，Markdown 预览与内容接口读到真实文件；
- 渲染进程无 `[teachforge][stream]` 错误日志。

另验证：Main 侧 `decodeChatSseMessage` 接受真实 `artifact` 帧、拒绝畸形帧并输出 `dropped_frame`；preload 在 `sandbox: true` 下正常加载（`window.teachforge` 存在）。

测试期间新建的会话已通过正式 DELETE 接口清理，用户原会话保留。

## 界面调整（2026-11-09）

- 侧边栏宽度可拖拽（320–900 px，受窗口宽度约束），拖拽后 384 → 564 px 并写入 `localStorage`，新标签页加载时恢复；`role="separator"` 支持左右方向键。
- 响应底部改为卡片：加粗"已更改 N 个文件"、右侧"打开侧边栏"、分隔的文件行（悬停 `bg-stone-100`、下行链接样式、右侧文件夹图标）。
- 真实 Electron 窗口中该卡片从历史加载渲染正常（"已更改 1 个文件"，font-weight 600）。

## 会话顶栏文件入口（2026-11-09）

需求：当前会话有产出时需要一个常驻入口，点击打开侧边栏列出本会话全部产出文件。

### 决策

| 问题 | 结论 | 依据 |
|---|---|---|
| 放哪 | 对话列顶部的轻量 header，右侧 | 消息区会滚动（入口会滚走）、输入区左下已是"附件"（输入语义，与产出文件混淆）、浮动按钮会压住首条消息；顶栏是 Artifacts/Canvas 类产品的既有惯例，且顺带补上当前会话标题 |
| 叫什么 | `文件` + 数字徽标，不放按钮文字"物料" | `物料` 是设计文档内部词（`source/data-model-design.md`"学习物料"）；界面既有文案统一用"文件" |
| 何时出现 | 数量为 0 时不渲染 | 常驻置灰按钮是死控件 |
| 怎么关 | 再点一次收起 | `本会话文件` 标签不可关闭，此前打开该标签后无任何收起路径 |

### 改动

- `artifact-store.ts`：新增 `artifactListStore`（按会话归属的列表快照 + 请求版本号，避免切换会话时旧响应覆盖）；`ArtifactTabsStore` 新增 `toggleAll()`。
- `AgentChatPage.tsx`：新增 header（标题 + `ArtifactEntry`），列表加载与刷新收口到页面，`ArtifactSidebar` 不再接收 `refreshToken`。
- `ArtifactSidebar.tsx`：改为消费 `artifactListStore`，删除自带 fetch；点击"刷新"重取列表。
- `ArtifactSidebarParts.tsx`：新增 `ArtifactEntry`；卡片按钮"打开侧边栏"改为"查看全部"。

### 验证

`npx tsc --noEmit -p apps/desktop/tsconfig.app.json` 通过；`npm run build:renderer` 通过。

以构建产物 + 打桩桌面桥（`window.teachforge.request` 返回 1 个会话、1 条回答、1 个 artifact）在 Chromium 中核对：

- 顶栏显示会话标题，右侧出现 `文件 1`；关闭会话（新建课题）后标题为"新对话"、入口消失。
- 点击入口：侧边栏展开到"本会话文件"列表，入口 `aria-expanded=true` 并转为选中态；再次点击收起，页面无侧边栏。
- 点击列表中的文件：打开文件标签并渲染预览，入口保持展开。
- 卡片按钮文案已是"查看全部"。

### 未覆盖

- 运行中产出新文件时徽标自增：依赖 SSE `artifact` 事件，本次以静态桩验证，未跑真实模型回合。触发路径与改动前一致（`liveActivity.artifacts` 变化即重取列表）。

## 侧边栏关闭入口（2026-11-09）

需求：标签条右端（用户标注的红框）需要一个整面板关闭入口。

- `ArtifactTabs` 拆成"可横向滚动的标签区 + 固定的关闭按钮"，关闭按钮放在滚动容器外，标签溢出时才不会被滚走；`ArtifactTabsStore` 新增 `hide()`，收起时保留已打开标签（`toggleAll()` 复用 `hide()`）。
- 验证（同一打桩构建）：关闭按钮位于 `x=1536..1564`、`aside` 右边界 1568，与标签条同高；点击后 `aside` 消失、顶栏入口 `aria-expanded=false`；打开文件标签后再点面板关闭按钮，整个面板收起而不是只关当前标签；再次展开落回列表标签，且先前打开的文件标签仍在。`tsc -p tsconfig.app.json` 与 `build:renderer` 通过。

