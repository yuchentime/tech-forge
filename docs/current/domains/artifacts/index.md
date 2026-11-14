---
status: current
layer: domain
domain: artifacts
canonical_for:
  - agent-generated-file-index
related:
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/domains/conversations/index.md
  - docs/current/platform/agent-runtime.md
  - docs/changes/2026-11-09-artifact-sidebar/design.md
  - docs/changes/2026-11-09-artifact-sidebar/verification.md
  - docs/changes/2026-11-10-deep-research-command/design.md
last_verified: 2026-11-14
---

# Artifact 会话产出文件

Agent 在一次会话里写出的文件被登记为 `artifacts` 行，供会话内文件侧边栏和"响应消息底部文件列表"读取。侧边栏不编辑、不重命名文件：唯一的写操作是删除**索引记录**（文件本身不受影响），且只有磁盘上已不存在的文件才提供该入口。

## 当前行为

- **工作目录即会话工作区**：每个会话的 Agent cwd 是 `<configDir>/sessions/<conversationId>/workspace`，与同级的 `attachments/` 分开；相对路径写入落在这一层，删除会话时整目录一并删除。
- **登记时机**：`write` / `edit` 工具的成功写入回调（`createWorkspaceFileTools` 的 `onFileWritten`）把已解析的绝对路径交给 `ArtifactsService.registerArtifact()`；同一路径重复写入按唯一键更新同一行，保持 `id` 稳定，因此已打开的标签页不会失效。这条链依赖 `PiAgentRuntime.createSession()` 把 `workspaceFileTools` 留在 `customTools` 里：应用自己的同名工具会遮蔽 Pi 内置的 `read`/`edit`/`write`，而内置工具不回调、也不做路径守卫。缺了这一项时 Agent 仍会显示"已写入 xxx"，但 `artifacts` 表没有行，侧边栏与响应底部文件列表同时为空——症状是"文件只在消息里出现"。
- **图片产物的正文不留在快照里**：图片类文件（`.svg`/`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp`/`.avif`）的 `write` 入参在保存快照时被替换为 `[content omitted: <N> B; read <path> to view it]`（见 [Agent Runtime](../../platform/agent-runtime.md) §持久化与恢复约定）。这只影响模型上下文：文件本身在磁盘、`artifacts` 行照常登记，预览、侧边栏与响应底部文件卡片都读磁盘与索引，行为不变。
- **路径存储**：会话内文件存 `pathKind='session'` + 相对工作区的 POSIX 路径；两个路径列都以空串占位而不是 NULL（SQLite 唯一索引把 NULL 视为互不相等，会让重复写入插入多行）。用户明确指定绝对路径时存 `pathKind='external'` + 绝对路径，便于后续预览与会话删除时区分。
- **缺失检测**：列表与预览接口现算 `missing`；文件被移走或改名后行仍保留，行名置灰并加删除线，点击提示"文件不存在"。删除线替代了普通下划线，是"这条记录指向的文件已不在"的唯一视觉信号。
- **预览格式**：按扩展名判定 `markdown`（含 ` ```mermaid ` 块时渲染图表）、`mermaid`、`svg`、`json`（≤256 KiB 且可解析则美化）、`jsonl`、`text`；正文读取上限 512 KiB，超出返回 `truncated`。
- **公式渲染**：Markdown 预览与聊天正文共用一条管线（`features/agent/markdown-plugins.ts`：`remark-gfm` + `remark-math` + `rehype-katex`），`$…$` 与 `$$…$$` 由 KaTeX 渲染成排版公式，不再显示 `$\alpha$` 这类原文。`throwOnError: false` 让写错的公式以红色文本留在原位，而不是整份文件预览失败；`strict: 'ignore'` 静音 KaTeX 对夹在两个 `$` 之间的中文（如 `$100 和 $200`）的告警。代价是单 `$` 定界符按 Markdown 数学的通行语义解析：成对出现但内容其实是金额时会被当作公式，源文件需写成 `\$100` 或用反引号；未配对的 `$$` 没有闭合定界符，保持原文字面，渲染层无法补救。`$$` 块级公式在面板内横向滚动，不截断。
- **SVG**：以 `<img>` + `data:image/svg+xml;base64` 显示，不内联成活标记——图片上下文是静态模式，脚本不执行、外部引用不加载、也无法触达 `window.teachforge`。尺寸取 `width`/`height` 像素属性，缺失时用 `viewBox` 且小于 480 px 的坐标系按比例放大到 480，两者都没有则用 640×400 兜底；解析失败或解码失败回退为源码文本。`contentFormat` 为 `svg`，`mimeType` 为 `image/svg+xml`。
- **知识结构图**：普通问题、解释、学习建议和分析直接在聊天中回答；仅在用户明确要求思维导图、知识图、图表或文件产物时生成图文件。明确请求后默认写 `.svg`——左侧根卡片 + 右侧分支卡片列（分支的要点作为卡片内的 `<text>` 行）、连接线用 `<line>`/`<path>` 垫在卡片下方；画布 560-640 px 宽、按分支数向下增长，带匹配的 `viewBox`，总盒子/线约 20-25 个，标签 ≤12 汉字。SVG 要求自包含：`font-family="system-ui, sans-serif"`、无 `<script>`、无 `<foreignObject>`、无外部字体/图片/样式表。仅当用户明确要 Mermaid 或要可编辑图时才写 `.mmd`（单个 `flowchart LR`；`mindmap` 只在用户要放射状时使用，因为它按力导向铺开，节点一多就成了不可读的网）；用户明确要 `.md` 时写含单个 ```mermaid 块的 Markdown。图表与图片都按自然尺寸渲染，面板内双向滚动，不强行缩放到面板宽度（缩到 400px 时标签不可读）。聊天正文仍按普通 Markdown 渲染，`mermaid` 代码块在侧边栏才展开为图形。
- **探索主题产物**：`/探索主题 <主题>` 由内置 `deep-research` skill 写 `deep-research/<slug>/知识文档.md` 与 `知识地图.svg`，两者按普通会话文件登记，不新增 artifact 类型；SVG 走上面的静态预览，Markdown 走普通 Markdown 预览。模型若只写其中一个，列表与响应卡片也只显示实际存在的文件。
- **路径归属比较**：登记时用 canonical path 判断文件是否在会话工作区内，避免配置目录含符号链接祖先（如 macOS `/var` → `/private/var`）时把 Agent 写出的会话文件误标为 `external`；存储的仍是相对工作区路径，配置目录整体搬迁后仍可解析。
- **元数据**：`fileName` 仅用于展示，列表不显示路径；`byteSize` 与 `fileHash`（≤2 MiB 时计算）供展示与漂移判断。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/conversations/:conversationId/artifacts` | 列表，可按 `userMessageId` 限定本轮；含 `missing`、`external` |
| GET | `/api/artifacts/:artifactId/content` | 预览正文与 `truncated` / `binary` |
| GET | `/api/artifacts/:artifactId/location` | 返回目录与文件绝对路径及存在性，供桌面桥在文件管理器中定位 |
| DELETE | `/api/artifacts/:artifactId` | 删除该 `artifacts` 行，返回 `{ artifactId }`；文件本身不删，重复删除返回 404 |

内容与位置接口只按 `artifactId` 查表后解析路径，不接受任意路径参数；会话内路径解析后仍校验落在会话工作区内。删除只按 `artifactId` 删一行，同样不接受路径：索引是"本会话产出了什么"的记录，不拥有磁盘文件，因此删除记录后对同一路径再写入会重新登记一行（新 `id`）。

## 前端

- **会话顶栏入口**：对话列顶部有一条轻量 header，左侧是本会话标题（无标题显示"新对话"），右侧是本会话文件入口——`文件` 加数字徽标；数量为 0 时不渲染，因此按钮本身就是"当前会话已产出文件"的信号。点击展开右侧侧边栏的"本会话文件"列表，再次点击收起；`aria-expanded` 随面板状态变化。界面用"文件"而不用产品设计文档里的"物料"（`source/data-model-design.md` 的"学习物料"是内部词，教师用户不会把它等同于产出文件）。
- **一次取数，两处消费**：文件列表由会话页统一加载进 `artifactListStore`（按 `conversationId` 归属，切换会话不串数据），顶栏徽标与侧边栏列表读同一份快照；侧边栏不再自己发请求，也不再通过 `refreshToken` 属性触发刷新。实时产出仍由 SSE `artifact` 事件改变 id 集合，进而触发一次列表重取。
- 响应消息底部以卡片列出本轮产出：标题行加粗显示"已更改 N 个文件"并提供"查看全部"（打开侧边栏的列表标签，收敛动作结果而不是"打开侧边栏"这类布局术语），下方为逐条文件行（悬停高亮、行内可点击打开预览、右侧文件夹图标定位；`missing` 行名加删除线）；历史取 `generatedFiles`，实时取 SSE `artifact` 事件。
- **实时卡片随线程保留**：SSE `artifact` 在 Pi run 结束后、`done` 之前到达；`done` 只清空运行状态，保存本轮快照的 `artifacts` 仍按本地线程可读，所以响应结束后卡片继续显示。历史加载成功时按 `conversationId` 清空该线程的实时列表，改由 `generatedFiles` 渲染，避免同一条响应出现两份文件卡片。该交接顺序必须由 renderer 回归覆盖：`artifact → done` 后仍可读；只有历史接管后才消失。
- **缺失文件可删记录**：列表行里 `missing` 的文件名置灰加删除线，右侧动作从文件夹图标换成垃圾桶（`Trash`，`aria-label="移除 <文件名> 的文件记录"`）；文件仍存在时保持文件夹图标，因为打开目录才是那里的有效动作。点击调用 `DELETE /api/artifacts/:id`，成功后同时从 `artifactListStore`、`artifactTabsStore`（`remove()`，与 `close()` 不同：不因标签清空而收起面板）、`artifactHistoryStore` 三处快照删除该 id，所以侧边栏行、顶栏徽标计数、响应底部卡片会立即一致，不需要重新取列表；请求进行中按钮禁用，失败弹 toast 并恢复可点。删除只针对索引记录：磁盘文件从未被这一操作触碰，即使记录被删时文件其实还在，也只是从列表消失，下次写入同一路径会重新登记。`artifactListStore` 还会把已删 id 记进 `removedIds`（随会话切换清空）并在列表取数结果里过滤——否则一次早于删除提交的列表请求会把行放回来。新写入同一路径得到新 `id`，不受该集合影响。
- 侧边栏标签条右端有一个关闭按钮（`ArtifactTabs` 的 `onClosePanel` → `artifactTabsStore.hide()`），收起面板但保留已打开的标签，下次展开仍在；它独立于标签自带的关闭 `×`，且不在横向滚动容器内，标签多到需要滚动时也不会被滚走。关闭最后一个文件标签、或点击顶栏入口同样收起侧边栏。
- 侧边栏左缘有拖拽手柄可横向调整宽度（320–900 px，键盘方向键同样可用）。**存的是用户意图，不是渲染宽度**：实际宽度每次渲染由 `features/agent/layout-budget.ts` 的 `planArtifactLayout` 按"左栏 256 + 聊天列 + 面板"分配，因此窄窗口只能临时收窄面板，无法把偏好改写成一个更小的值（旧实现把夹紧后的值写回 `localStorage`，小窗口里拖一次就永久变窄）。
- **打开面板自动扩窗**：面板可见时若聊天列低于舒适档（624，正文 560），渲染层调 `ensureContentWidth()` 让主进程把窗口内容宽扩到"256 + 624 + 意图宽度"；上限是窗口所在显示器的 `workArea`，贴右边缘时窗口向左滑而不越界，高度与最大化/全屏/贴边吸附状态一律不动。显示器装不下时对话列降到下界档 496（正文 432）并收窄面板；连 1072 内容宽都没有时才改为**右侧悬浮**（`absolute` + 阴影 + `z-30`，不加遮罩，`Esc` 收起），此时对话列保持整宽、不被挤占。
- **关闭即还原**：面板隐藏或卸载（设置/资料库/演练模式/知识掌握/课堂模式）后延迟 250ms 调 `releaseContentWidth()`，主进程仅在窗口仍等于自己上一次写入的 bounds 时缩回扩展前的宽度——用户在面板打开期间手动改过尺寸则放弃还原，从不抢用户尺寸。扩窗只由"面板变可见"和"用户把面板拖宽"触发，窗口 resize 不会反向补扩。
- **窗口尺寸记忆**：`resize`/`move` 去抖 500ms 把 bounds 写入 Electron `userData/window-state.json`，启动时按当前显示器 `workArea` 回夹（换小屏或拔掉外接屏也不会恢复出屏幕外的窗口）；若关闭时面板仍处于扩窗状态，保存的是扩展前的宽度，避免把临时宽窗固化成默认尺寸。
- **全屏预览**：文件预览头部右端有一个全屏按钮（`ArrowsOut`），点击把当前文件渲染到覆盖整个窗口的悬浮层（`createPortal` 到 `body`，`z-40`，低于 toast 的 `z-50`），`role="dialog"` + `aria-modal`，标题栏复用文件名与"外部文件"标记，关闭按钮在右端；`Esc` 同样关闭。打开时锁 `body` 滚动并把焦点移到关闭按钮，关闭后焦点回到触发按钮；文件标签消失（列表刷新后该文件不再存在）时悬浮层自动收起。图仍然按自然尺寸显示、在悬浮层内双向滚动——窗口宽度通常足以容纳整图，因此不引入缩放/平移。
- **图渲染 id 全局唯一**：悬浮层与面板会同时渲染同一个文件，即两个 `MermaidDiagram` 实例并存；mermaid 的 `render(id, code)` 会删除同 id 的既有节点，所以 id 必须取自模块级自增序列（`artifact-mermaid-${++nextRenderSequence}`），不能用组件内计数器——否则打开全屏就会把面板里已画好的图从 DOM 删掉，关掉后只剩空边框。
- **手动重新读取**：预览头部右端、全屏按钮左侧有刷新按钮（`ArrowsClockwise`），点击后重新请求 `GET /api/artifacts/:id/content`。存在的原因是模型会原地改写同一路径的文件——`registerArtifact()` 复用同一行、id 不变，列表刷新只同步 `missing` 等元数据，预览拿不到任何 prop 变化，因此不会自动更新。刷新令牌由 `ArtifactSidebar` 持有并同时传给面板与全屏悬浮层两个 `ArtifactPreview`；两处都会重新取数（同一次点击触发两次 content 请求），保证全屏时看到的内容与面板一致。
- 文件名右侧的 `会话文件` / `外部文件` 文本只在 `external` 时保留（"外部文件"是需要提醒的例外，会话内文件属于默认情况，不再占用头部空间）。
- 侧边栏收起、切换会话或重新加载历史时清空标签，避免跨会话残留；`generatedFiles` 与实时事件两条来源互斥。
- **预览内关键词搜索**：文件预览头部（刷新按钮左侧）的搜索按钮打开关键词搜索（与聊天同一套 `KeywordSearch`/`dom-search`/`search-text-index`），`Ctrl+F` 打开，`Enter`/`Shift+Enter` 跳转，`Esc` 关闭；搜索框为空时焦点离开即收起（点击预览正文、切标签或点回聊天都会关闭），已有查询词时失焦保留，命中用同一组 CSS Custom Highlight 着色。只索引当前预览的文本节点：markdown/纯文本/JSON/代码块可搜；Mermaid 图与 SVG 图（以 `<img>` 渲染）没有可高亮的文本节点，整棵 SVG 子树被跳过，计数里不会出现点不到的命中；`truncated` 的大文件只搜已加载的前一部分。面板与全屏悬浮层各自持有搜索框与滚动容器 ref，`Ctrl+F` 按焦点所在面板路由；进入/退出全屏、切到「本会话文件」列表时搜索关闭，避免对着已换掉的容器保留旧 Range。

## 未实现

- `rehearsals` 等其它导出物料的登记、artifact 版本化、跨会话文件集合。
