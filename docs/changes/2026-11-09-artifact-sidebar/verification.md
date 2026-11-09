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


## 预览全屏（2026-11-09）

需求：`.mmd` 导图在侧边栏内看不清——用户建议不引入缩放/拖拽，改为预览头部提供全屏入口（红框处替换成一个全屏图标）。

### 决策

| 问题 | 结论 | 依据 |
|---|---|---|
| 全屏还是缩放 | 只做全屏悬浮层 | 侧边栏最宽 900 px，2210 px 的导图缩到面板宽度时标签仅约 5 px 高；全屏后窗口宽度通常已接近图宽，缩放不是必需能力 |
| 悬浮层挂在哪 | `createPortal` 到 `body`，`z-40` | 侧边栏自身有 `overflow` 与拖拽宽度约束，`fixed` 留在原地会被裁切；toast 层是 `z-50`，必须保持在悬浮层之上 |
| 原"会话文件"文本 | 只在 `external` 时显示"外部文件" | 会话内文件是默认情况，重复标注占位；"外部文件"是会话删除后仍存在的例外，需要保留提醒 |
| 关闭方式 | 头部关闭按钮 + `Esc` | 悬浮层覆盖整个窗口，用户没有其它可见出口 |

### 改动

- `ArtifactSidebar.tsx`：新增 `isFullscreen` 状态与两个 ref；头部右端改为"外部文件"标记（条件渲染）+ `ArrowsOut` 全屏按钮；`createPortal` 渲染 `role="dialog"` 悬浮层（标题 + 关闭按钮 + `ArtifactPreview`）；`Esc` 监听、`body` 滚动锁、焦点进入/返回；`activeTab` 变为 `null` 时自动收起。为满足 Hook 顺序，`activeTab` 计算上移到早退分支之前。

### 验证

`npx tsc --noEmit -p apps/desktop/tsconfig.app.json` 与 `npm run build:renderer` 均通过。以构建产物 + 打桩桌面桥（1 个会话、1 个 `消息队列-核心知识点.mmd` artifact，内容为 152 节点导图）在 Chromium 1400×900 中核对：

- 预览头部出现 `全屏查看` 按钮；点击后 `[role="dialog"][aria-modal="true"]` 尺寸 1400×900 等于视口，挂在 `document.body` 下，`z-index` 为 40。
- 悬浮层内导图按自然尺寸 2210×935 渲染（滚动容器 1366 可视 / 2234 内容），面板内同一张图此前只有 384 px 宽可见。
- 打开时 `document.body.style.overflow` 变为 `hidden`，焦点落在 `退出全屏` 按钮；`Esc` 关闭后 `overflow` 复原为空串、焦点回到 `全屏查看`。
- 再点开并用头部关闭按钮关闭同样生效，可重复开关；关闭后侧边栏预览仍在。

### 未覆盖

- Electron 真实窗口（本轮用构建产物 + 打桩桥在 Chromium 验证）；渲染进程在 Vite dev server 下 mermaid 动态导入失败会落到"这段图表源码无法渲染"回退，构建产物与打包应用不受影响，未在 dev server 上复测（属既有开发态依赖预打包问题，非本次改动）。

### 缺陷与修正：关闭全屏后面板预览变空（2026-11-09）

现象：打开全屏再关闭，侧边栏里的图表变成只有一个空边框。

根因：`MermaidDiagram` 的渲染 id 用组件内部计数器（`artifact-mermaid-${++ref.current}`），面板与悬浮层同时挂载时两个实例都从 1 开始，id 相同。mermaid 的 `render(id, code)` 会先删除同 id 的既有元素，于是悬浮层渲染时把面板里已经画好的 `<svg id="artifact-mermaid-1">` 从 DOM 删掉；React 的 `dangerouslySetInnerHTML` 只在字符串变化时重写，节点被外部删除后不会补回，容器里只剩空边框。

取证（构建产物 + 打桩桥，Chromium）：全屏前 `svgIds=["artifact-mermaid-1"]`；全屏中仍只有一个 id（面板那份已被覆盖）；关闭后 `svgIds=[]` 且容器 `innerHTML.length === 0`。

修正：渲染 id 改为模块级自增序列 `artifact-mermaid-${++nextRenderSequence}`，跨实例唯一，不再依赖组件内计数。

验证：同一场景下全屏中 `svgIds=["artifact-mermaid-1","artifact-mermaid-2"]`、两张图各 2210×935；关闭后回到 `["artifact-mermaid-1"]` 且面板内图形仍是 2210×935、不再是空框。连续开关 3 轮，每轮全屏中 2 张图、关闭后 1 张图，无残留 id。

## 导图生成规则改为纵向树（2026-11-09）

需求：`customSystemPrompt` 里关于思维导图的规则改为优先 `.mmd`，形状为"根节点在左、子节点向右展开"的纵向树（即 Mermaid `flowchart LR`）。

### 决策与测量

| 形状 | 21 节点实测 | 31 节点实测 | 结论 |
|---|---|---|---|
| `mindmap`（原默认） | 2210×935（力导向，节点越多越像网） | — | 弃用，仅在用户明确要放射状时保留 |
| `flowchart TD` | 2856×251 | 4584×312 | 宽度随叶子数线性增长，超出侧栏一个数量级 |
| `flowchart LR` | 572×1251 | 612×2037 | 宽度只随层数增长（三列约 570-620 px），纵向滚动换高度 |

LR 是唯一能装进 400-900 px 侧栏的树形布局，因此规则据此改写：根在最左、三列、4-6 分支 × 2-3 叶子、约 20-25 节点、标签 ≤12 汉字，`mindmap` 与 `flowchart TD` 都排除。

### 改动

`apps/backend/src/llm/llm.service.ts` 的 `customSystemPrompt`：原"导图必须是含 `mindmap` 的 Markdown 文件"一条，替换为五条——`.mmd` + `flowchart LR` 为主；`mindmap` 仅在明确要求放射状时；按窄栏定规模；标签用纯文本（括号/引号会被当作形状语法）；用户要 `.md` 时仍用单个 ```mermaid 块；保留"不得用嵌套列表代替导图/不得只在聊天里回答"。

### 验证

以真实 Provider 跑一轮对话（临时 config 目录拷贝用户 `config.toml`，`dist` 被运行中的 dev 应用占用，故用 `tsc --outDir .tmp-dist` 的等价构建启动），prompt 为"以「Redis 知识点」为主题，生成一份 .mmd 思维导图"：

- 写入 `redis-knowledge.mmd`，首行 `flowchart LR`，无 `mindmap`、无 `subgraph`；
- 24 个节点、23 条边、6 个分支（2-3 个叶子），最长标签 `哨兵 Sentinel`（8 字符）；
- 渲染实测 592×1421：宽度窄于侧栏展开后的常见宽度，高度约两屏，符合 LR 的滚动方向。

### 未覆盖

- 规则是提示词约束而非渲染期校验，模型仍可能超规模；未加规模校验或自动重排（本轮只改提示词）。
- `.md` 分支（用户明确要求 Markdown 时）未跑真实对话验证。
- 运行中的 dev 应用持有 `apps/backend/dist`，新提示词需重启应用（重新构建）后生效。

## SVG 预览（2026-11-09）

需求：暂不支持 HTML，改为支持 `.svg` 展示。

### 决策

| 问题 | 结论 | 依据 |
|---|---|---|
| 渲染方式 | `<img>` + `data:image/svg+xml;base64`，不内联标记 | 图片上下文是静态模式：脚本不执行、外部引用不加载、无同源访问；内联或 `dangerouslySetInnerHTML` 会让 SVG 里的 `<script>` 触达 `window.teachforge`（与 HTML 同一个风险面） |
| 尺寸 | 取 `width`/`height` 像素属性；否则用 `viewBox`，坐标系窄于 480 px 时等比放大到 480；都缺则 640×400 | 与 mermaid 一致按自然尺寸显示、容器内滚动；`<img>` 对无尺寸 SVG 默认 300×150，会把标签压到不可读 |
| 解析失败 | 回退源码文本 | 与 mermaid 的失败路径保持同一套行为 |
| 扩展名 | `.svg` → `contentFormat: 'svg'`、`mimeType: 'image/svg+xml'`；查表时统一小写 | 与既有 `CONTENT_FORMATS` 约定一致，`.SVG` 同样命中 |

### 改动

- `apps/backend/src/artifacts/artifacts.service.ts`：`CONTENT_FORMATS` 新增 `.svg`。
- `apps/desktop/src/features/agent/SvgArtifact.tsx`：新增。`DOMParser`（惰性，不执行）读出 `width`/`height`/`viewBox` 决定显示尺寸，`TextEncoder` + `btoa` 生成 data URL，`onError` 与解析失败都回退源码。
- `apps/desktop/src/features/agent/ArtifactPreview.tsx`：`ArtifactBody` 增 `svg` 分支。

### 验证

后端（`.tmp-dist` 等价构建，真实 `ArtifactsService` 与 HTTP 路由）：`图示.svg` 与 `图示2.SVG` 均登记为 `contentFormat: 'svg'`；`GET /api/artifacts/:id/content` 返回 `{"contentFormat":"svg","binary":false,"byteSize":133}` 且正文与写入内容逐字一致。

渲染（构建产物 + 打桩桥，Chromium 1400×900）：

- 720×360 的 SVG 以 `<img>`（`src` 为 `data:image/svg+xml;base64,…`）显示为 720×360，等于其自然尺寸；DOM 中 `svg rect` 计数为 0（没有内联成活标记）。
- 内含 `<script>window.__svgScriptRan = true; parent.__svgParentTouched = true</script>` 的 SVG：两个标记均为 `false`，脚本未执行、也未触及父窗口。
- 只有 `viewBox="0 0 120 80"` 的 SVG：按 4 倍等比放大为 480×320。
- 语法损坏的 SVG：显示"这段 SVG 无法显示，已按原文显示。"并输出源码。
- 全屏悬浮层内同样以 720×360 渲染，脚本仍未执行。

### 未覆盖

- 模型侧未加"生成 `.svg`"的提示词规则（本轮只做展示支持）；如需要模型主动产出 SVG 物料，需另加一条 `customSystemPrompt` 规则。
- 未在真实 Electron 窗口复测（构建产物 + 打桩桥）；运行中的 dev 应用仍持有旧 `dist`，需重启后生效。

## 知识结构图默认改为 SVG（2026-11-09）

需求：SVG 的展示效果优于 `.mmd`，提示词改为优先用 SVG 做知识结构化。

### 决策

| 问题 | 结论 | 依据 |
|---|---|---|
| 默认格式 | `.svg` | mermaid 的布局由引擎决定（径向/横向长条），SVG 由模型直接控制画布、卡片与文字换行；实测同一主题下 SVG 版是"左根 + 右卡片列"的成品排版，mermaid 版是 592×1421 的纯线框树 |
| 版面 | 左侧根卡片 + 右侧分支卡片列，要点作为卡片内 `<text>` 行 | 手写 SVG 最容易出错的是连接线与坐标；把要点写进卡片、连接线只画一条竖脊加横向短线，几何出错面最小 |
| 画布 | 560-640 px 宽、高度随分支增长，`width`/`height` 与 `viewBox` 一致 | 预览按自然尺寸显示，宽度必须落在侧栏可拖拽范围（320-900）内；高度靠纵向滚动 |
| `.mmd` | 降级为用户明确要求 Mermaid / 可编辑图时 | 保留既有 `flowchart LR` 规则，`mindmap` 仍仅在用户要放射状时使用 |

### 改动

`apps/backend/src/llm/llm.service.ts` 的 `customSystemPrompt`：原五条 `.mmd` 规则替换为六条——默认 `.svg`（导出的是文件，不是聊天回答）；左根右卡的版面；画布尺寸与 `viewBox`；自包含与惰性要求（`system-ui`、无 `<script>`/`<foreignObject>`/外链、转义 `& < >`）；规模 20-25 个盒子/线、标签 ≤12 汉字；仅在用户要 Mermaid 时写 `.mmd`（`flowchart LR`，禁 `mindmap`）。

### 验证

以真实 Provider 跑一轮对话（prompt：「请把 Redis 知识点做成一份知识结构图。」；`dist` 被运行中的 dev 应用占用，故用 `.tmp-dist` 等价构建）：

- Agent 写出 `redis-knowledge-map.svg`（5740 字节），artifact 事件 `contentFormat: 'svg'`；
- 根标签 `<svg width="640" height="816" viewBox="0 0 640 816">`，`width`/`height`/`viewBox` 三者一致；
- 结构：16 个 `rect`、30 个 `text`、9 条 `path`（一条竖脊 + 8 条横向连线），无 `<script>`、无 `<foreignObject>`、无 `href` 外链；
- 几何检查（在浏览器里内联同一份源码后量 `getBBox`）：所有 `<text>` 都落在其所属卡片 `rect` 内，无越界、无互相重叠、无超出画布；
- 作为图片加载时 intrinsic size 为 640×816，与声明一致，即预览会按此尺寸显示；
- 视觉核对：左侧深蓝根卡片「Redis / 知识结构」，右侧 7 张分支卡片（数据类型、持久化、高可用架构、缓存三大问题、内存管理、性能优化、事务与锁），每张卡片 3 条要点，带彩色左侧色条与连接线。

### 未覆盖

- 提示词约束不是渲染期校验：模型仍可能写出越界或重叠的 SVG，本轮只验证了一次真实产出。
- 640 px 宽的图在默认 384 px 侧栏内需要横向滚动或拖宽/全屏；未改变"按自然尺寸显示"的既有规则。
- 运行中的 dev 应用持有 `apps/backend/dist`，需重启 `npm run dev` 后生效。

## 预览手动刷新（2026-11-09）

需求：全屏图标左侧加一个刷新按钮，点击重读当前文件。起因是模型在文件已打开的情况下改写同一路径后，预览不更新。

### 决策

| 问题 | 结论 | 依据 |
|---|---|---|
| 自动还是手动 | 手动刷新按钮 | 自动方案需要后端在每轮写回后推送"该 artifact 内容已变"事件并在前端比较 `updatedAt`/`fileHash`，还得分清本轮写入与历史回看；当前侧栏没有任何内容变更通道（SSE `artifact` 事件只带元数据），改动面明显大于一个按钮 |
| 刷新触发点 | `ArtifactSidebar` 持有 `reloadToken`，通过 prop 传给两个 `ArtifactPreview` | 文件 id 不变，`ArtifactPreview` 的取数 effect 只依赖 `[file.id]`；加一个计数器作为显式依赖即可，不必改成命令式 ref |
| 全屏内是否也要刷新 | 要，且共用同一个令牌 | 全屏覆盖整个窗口，用户在悬浮层里停留最久；共用一个令牌避免两处内容各读一半 |
| 刷新是否需要重取列表 | 不重取 | 内容接口已现算 `missing`，文件被删时刷新会拿到 404 并提示"文件已不存在，无法预览" |

### 改动

- `apps/desktop/src/features/agent/ArtifactPreview.tsx`：新增可选 `reloadToken` prop，取数 effect 依赖改为 `[file.id, reloadToken]`。
- `apps/desktop/src/features/agent/ArtifactSidebar.tsx`：新增 `reloadToken` 状态；面板头部与全屏头部各加一个 `ArrowsClockwise` 按钮（`aria-label="重新读取文件"`），点击 `reloadToken + 1`；两个 `ArtifactPreview` 都接收该令牌。

### 验证

构建产物 + 打桩桥（Chromium 1200×800），桩里的 `content` 可在运行时替换，模拟"模型原地改写"：

- `.svg`：打开后显示"版本一"，替换桩内容再点刷新 —— content 请求 1 → 2，图片 data URL 变为"版本二"，不刷新则始终停在"版本一"（复现用户报告的问题）。
- 全屏：`[role="dialog"]` 头部按钮为 `["重新读取文件", "退出全屏"]`；在悬浮层内点刷新，content 请求 3 → 5（面板与悬浮层两个实例各取一次），悬浮层与请求背后的面板都变为"版本三"。
- `.mmd`：打开后渲染 `Redis → 旧版本 → 持久化`；替换为含 `新版本`、`缓存三问` 的新源码后点刷新，content 请求 1 → 2，图上标签变为 `Redis / 新版本 / 持久化 / 缓存三问`，页面仍只有一个流程图（旧 SVG 被替换而非叠加）。
- 头部按钮顺序与位置：`重新读取文件` 在全屏按钮左侧（截图核对），`aria-label` 与 `title` 均为中文。

### 未覆盖

- 未做自动刷新：模型改写后仍需用户点一次刷新按钮，或关闭再打开该标签。
- 未在真实 Electron 窗口复测（构建产物 + 打桩桥）；运行中的 dev 应用使用 Vite 源码热更新，React 侧改动无需重启 backend。

## 缺失文件记录删除（2026-11-09）

### 决策

| 选择 | 结论 | 理由 |
|---|---|---|
| 删除范围 | 只删 `artifacts` 行 | 索引记录的是"本会话产出了什么"，不拥有磁盘文件；删文件是不可撤销的用户数据操作，用户已在资源管理器里删过 |
| 入口范围 | 只有 `missing` 行换成垃圾桶 | 文件还在时"打开目录"才是有效动作；删记录会让仍在的文件从列表消失，不该是常规入口 |
| 交互 | 点击即删，不弹确认 | 只丢一条索引记录，文件不受影响，误删可由下次写入重建；代价与确认弹窗不匹配 |
| 本地状态 | 直接改三份快照，不重取列表 | 侧边栏行、顶栏徽标、响应底部卡片读三份独立快照，改完立即一致；重取会闪一次 loading |
| 面板 | `artifactTabsStore.remove()` 不收起面板 | 复用 `close()` 会在标签清空时收边栏，等于删一行就关掉用户正在看的列表 |

### 改动

- `apps/backend/src/artifacts/artifacts.service.ts`：新增 `removeArtifact()`，按 id 查行、删行，日志 `artifacts.delete.completed` 记录 `fileExists`（删后该文件是否还在磁盘）。
- `apps/backend/src/artifacts/artifacts.controller.ts`：新增 `DELETE /api/artifacts/:artifactId`（`ParseUUIDPipe`，200 + `{ artifactId }`）。
- `apps/desktop/src/features/agent/artifact-store.ts`：`ArtifactListStore.remove()`、`ArtifactTabsStore.remove()`、`ArtifactHistoryStore.remove()`（只让文件从该消息卡片消失，卡片空了就不渲染）。
- `apps/desktop/src/features/agent/ArtifactSidebarParts.tsx`：新增 `deleteArtifact()`；`missing` 行加 `line-through`、图标置灰，右侧按钮换成 `Trash`（`disabled` 到请求返回）；响应底部卡片的 `missing` 行同样加删除线。
- `apps/backend/test/verify-artifacts.cjs`：增加服务层与 HTTP 两层删除校验；改为读取 `BACKEND_TEST_BUILD_DIR`（默认 `.test-dist`），避免 dev backend 锁住 `dist` 时无法验证。
- `apps/backend/package.json`：`verify:artifacts` 改用 `tsc --project tsconfig.build.json --outDir .test-dist`，与其它 verify 脚本一致。

### 验证

- `npm run verify:artifacts`（后端）：临时目录中登记 3 行 → 删 1 行后列表少 1、该行 404、**文件内容仍可读出**、重复删除抛 `Artifact not found`；真实 HTTP 入口 `DELETE /api/artifacts/:id` 返回 200 与 `{ artifactId }`，列表从 2 变 1，再次删除返回 404。
- `npx tsc --noEmit -p apps/desktop/tsconfig.app.json`：通过。
- 构建产物 + 打桩桥（Chromium，`window.teachforge` 在页面脚本前注入，桩里 2 个文件其一带 `missing`）：
  - "本会话文件"列表里 `消息队列-核心知识点.mmd` 的 `text-decoration-line` 为 `line-through`、颜色为 muted，右侧按钮 `aria-label="移除 消息队列-核心知识点.mmd 的文件记录"`（`title="移除记录"`）；`消息队列-基本理解.md` 无删除线、右侧仍是 `打开文件目录`。
  - 点垃圾桶后发出且只发出一次 `DELETE /api/artifacts/2222…`，该行从 DOM 消失，侧边栏保持打开（`关闭文件侧边栏` 按钮仍在），顶栏徽标由 `查看本会话生成的 2 个文件` 变为 `收起本会话生成的 1 个文件`。
  - 竞态防护：桩里让 `GET …/artifacts` 即使删除后仍返回该行（模拟早于删除提交的列表请求），删除后点"刷新"（列表请求第 3 次返回两行），该行仍不出现、徽标仍为 1 —— `removedIds` 过滤生效。

### 未覆盖

- 未在真实 Electron 窗口复测；且运行中的 dev backend 仍是旧 `dist`，需重启 `npm run dev`（会重新 `build:backend`）后 `DELETE` 路由才生效。
- 未覆盖删除失败分支的界面验证（代码路径为 toast + 按钮恢复可点）。
