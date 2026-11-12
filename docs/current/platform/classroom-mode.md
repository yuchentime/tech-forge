---
status: current
layer: platform
domain: classroom-mode
canonical_for:
  - classroom-mode-window-aspect
related:
  - docs/current/platform/index.md
  - docs/current/platform/desktop-skin.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/source/课堂模拟图像素材规格.md
  - docs/source/学习趣味性设计讨论.md
last_verified: 2026-11-12
---

# 课堂模式

本页描述 `apps/desktop` 当前实际生效的课堂模式：侧栏入口、沉浸式舞台，以及进入后强制的 16:9 窗口比例。课堂状态机、学生立绘、气泡与报告仍是设计草案（见[学习趣味性设计讨论](../../source/学习趣味性设计讨论.md) 3.7 节），不在当前实现内。

## 入口与布局

| 项 | 当前事实 |
|---|---|
| 入口 | 侧栏「知识掌握」下方的「课堂模式」（`Chalkboard` 图标），对应 `SidebarView = 'classroom'` |
| 布局 | 进入后不渲染侧栏与聊天头，舞台占满整个窗口内容区；因此窗口内容区的比例就是舞台比例 |
| 退出 | 舞台左上「退出课堂模式」按钮，或按 `Esc`（焦点在输入框内时除外）；没有侧栏入口可点，退出后回到对话视图。右上角仍是静态「课堂模式」标签；设计稿要求改为红色「结束课堂」+ 确认框（未实现），当前卸载即清空本轮状态 |
| 组件 | [ClassroomMode.tsx](../../../apps/desktop/src/features/classroom/ClassroomMode.tsx) 只负责挂载舞台、窗口模式开关与输入框定位 |

舞台由两层 CSS 决定（[styles.css](../../../apps/desktop/src/styles.css)）：

- `.tf-classroom-viewport`：`container-type: size`，让子元素能用 `100cqw`/`100cqh` 互相换算。
- `.tf-classroom-stage`：`width: min(100cqw, 100cqh * 16 / 9)`、`height: min(100cqh, 100cqw * 9 / 16)`，即视口内最大的 16:9 矩形并居中。只用 `max-width`/`max-height` 会夹住单轴、破坏比例并把学生图拉变形。
- 背景 [bg-classroom.png](../../../apps/desktop/src/assets/classroom/bg-classroom.png)（1568×882，恰好 16:9）按 `cover` 铺满舞台；窗口被锁成 16:9 时舞台与内容区同尺寸，不裁剪、不出现留边。
- 舞台外的 `ink-900` 底色只在窗口比例无法被约束时露出（普通浏览器预览、最大化窗口）。

### 消息输入框

舞台底部、前景课桌上的输入框是 [ClassroomComposer.tsx](../../../apps/desktop/src/features/classroom/ClassroomComposer.tsx)：**只有样式**与对话视图的输入框一致，功能是课堂专用的子集，目前是课堂流程的交互原型（MVP）。

| 项 | 当前事实 |
|---|---|
| 定位 | 舞台内绝对定位，`left/right: 0` + `bottom: 3%` 居中；宽度 `46%`（`min-w-[20rem]`、`max-w-[42rem]`），与插图上前景课桌区域（约 29%–75% 宽、76%–97% 高）对齐 |
| 卡片 | 与对话输入框同款：白卡、`rounded-3xl`、1px `ink-200` 描边、聚焦只换 `brand-500` 边框；因压在暖色课桌上，额外加 `shadow-card` 做分离 |
| 移除 | **附件选择与标签**、**斜杠命令菜单与命令胶囊**（`/查询资料库`、`/探索主题` 只属于备课对话） |
| `Esc` | 焦点在输入框内时不退出课堂模式，避免丢掉半写的草稿；点击画面后再按 `Esc` 才退出 |

两种状态（`composing → sent`，状态在 [ClassroomMode.tsx](../../../apps/desktop/src/features/classroom/ClassroomMode.tsx) 内）：

| 状态 | 输入区 | 讲稿 | 学生气泡 |
|---|---|---|---|
| `composing`（默认） | 四行文本框，固定 96px（`h-24`）+ 底栏；占位符「写下你准备讲给学生的内容…」 | 无 | 无 |
| `sent`（按 `Ctrl + Enter` 或「发送」后） | 单行回复框，40px（`h-10`），右侧内联「发送」；占位符「回答学生…Ctrl + Enter 发送」，自动获得焦点 | 先浮在输入框上方约 3 秒（`.tf-classroom-peek`，3s 保持 + 0.6s 淡出），随后只存在于消息侧栏 | 中间学生「小满」头顶出现问题气泡 |

- 发送按钮在草稿为空时禁用；`Ctrl/Cmd + Enter` 与点击按钮等价，普通 Enter 只换行。
- 淡出期间讲稿卡绝对定位在输入框上方，不占停靠区高度；`sent` 时停靠区仅 88.6%–97%，学生完全露出。
- 回复发送后：清空回复框、收起问题气泡（表示已作答），回答追加到消息侧栏。
- **原型边界**：讲稿与回复都只是本地状态，不写入会话、不调用模型；问题气泡的文案写死。接入课堂状态机后再改为真实提问/回答。

### 消息侧栏

| 项 | 当前事实 |
|---|---|
| 默认 | 折叠；右下角圆形 `ChatsCircle` 按钮，有消息时右上角显示条数角标 |
| 展开 | 右侧覆盖式抽屉：`right 2.5% / top 12% / bottom 3%`、宽 `23%`（`min 16rem`、`max 22rem`）、`bg-white/85` + `backdrop-blur-xl` + `shadow-float`；折叠时 `opacity-0` + `translate-x-3` + `inert`，不参与 Tab |
| 内容 | 按时间顺序：`老师 · 讲稿`、`小满` 的问题、`老师` 的逐次回答；列表固定高度、内部滚动，打开或有新消息时自动滚到底 |
| 关闭 | 抽屉头部 `X`；`Esc` 先收抽屉，再按一次才退出课堂模式；输入框内按 `Esc` 仍不退出 |
| 重新讲解 | 抽屉头部，清空本轮讲稿、气泡与消息，回到 `composing` |
| 尺寸影响 | 抽屉只覆盖、不挤压舞台：窗口仍是 16:9，画面不缩放、不留边；展开时遮住右侧第三名学生与书架，默认折叠因此不影响画面 |
| 滚动条 | 抽屉列表使用 `.tf-scrollbar`（同输入框），显示应用自己的 10px 条 |

### 进入动效

图片不是直接切进来：`.tf-classroom-art`（只承载背景图的那一层）用软边圆形遮罩从中心向外展开，同时从 1.06 倍轻微回落，控制胶囊延后淡入。遮罩只作用于图片层，所以控件不会被圆形边界裁切。

| 参数 | 值 |
|---|---|
| 遮罩 | `radial-gradient(circle farthest-corner, #000 var(--tf-stage-reveal), transparent calc(var(--tf-stage-reveal) + 12%))`；半径是注册过的 `--tf-stage-reveal`（`@property`），从 `0%` 到 `100%`，即从中心扩到最远角 |
| 展开时长 | 640ms，`cubic-bezier(0.45, 0, 0.55, 1)`（先慢后匀），波前是 12% 的柔化过渡而不是硬圆边 |
| 画面回落 | `tf-stage-settle` 1300ms，`scale(1.06) → 1`，让教室"稳住"而不是定格 |
| 控件 | `tf-classroom-overlay` 复用 `tf-rise`，延迟 280ms（展开过半后）淡入上浮 |
| 输入框 | `tf-classroom-composer` 复用 `tf-rise`，延迟 340ms，最后落位 |
| 降级 | `prefers-reduced-motion: reduce` 时三处动画与遮罩全部关闭，图片直接以 `--tf-stage-reveal: 100%` 的完整状态显示 |

遮罩半径必须用注册属性：未注册的自定义属性无法插值，关键帧会跳变；`farthest-corner` 让 `100%` 的语义就是"最远角"，动画结束即完全覆盖，不留暗角。

## 窗口 16:9

渲染层只声明「课堂模式是否在屏幕上」，几何全部由 main 决定：

| 层 | 事实 |
|---|---|
| `window.teachforge.setClassroomMode(enabled)` | [desktop-bridge.ts](../../../apps/desktop/src/types/desktop-bridge.ts) 的唯一新能力；[preload](../../../apps/desktop/electron/preload/preload.ts) 转 `ipcRenderer.invoke('window:set-classroom-mode', enabled)` |
| IPC 校验 | 参数必须是布尔值；窗口不可用时报错，不静默降级 |
| 进入 | `applyClassroomMode(win, true)`：先退出全屏/最大化（比例只约束普通窗口），用 `planAspectLock` 由当前窗口尺寸算出**内容区 16:9** 的 bounds，记下 baseline 后写入 |
| 拖动 | 在 `will-resize` 里按实测边框补偿修正为内容区 16:9：保留位移更大的那条轴（拖右边缘改宽度、拖下边缘改高度），另一轴按比例推导，并阻止系统原本的这次尺寸 |
| 离开 | 删除锁；用户没在模式内改过尺寸时写回 baseline，改过或窗口已最大化/全屏时保留用户当前尺寸 |

`planAspectLock`（[window-layout.ts](../../../apps/desktop/electron/main/window-layout.ts)）是纯函数：保留当前内容宽度、按 16:9 推导高度；显示器装不下时两轴一起缩小；结果夹进 `workArea`，避免窗口跑到屏幕外。

### 为什么没用 `win.setAspectRatio`

在 125% 缩放、边框 16×39 的 Windows 实测：`win.setAspectRatio(16 / 9)` 约束的是**窗口外框**，内容区变成 1.84（应为 1.7778），舞台两侧出现 26px 留边；把实测边框作为 `extraSize` 传入没有改变结果。因此改为在 `will-resize` 内按内容区自行修正，比例与舞台完全对齐。macOS/Linux 未实测，代码路径与平台无关。

### 与既有窗口能力的关系

- 进入课堂模式会卸载聊天视图，`ArtifactSidebar` 的卸载回调会立即 `releaseContentWidth()`；这与进入模式的写尺寸是同一条 IPC 序列，先释放再锁比例，不会互相覆盖。
- 模式进行中不写入 `userData/window-state.json` 的临时尺寸，保存的是进入前的 baseline，下次启动仍是用户自己的窗口大小。
- 退出后窗口与聊天视图的可拉伸行为完全恢复（不受 16:9 约束）。

## 与设计稿的差异

[课堂模拟图像素材规格](../../source/课堂模拟图像素材规格.md) 规划的是 16:10 舞台、独立学生立绘与前景课桌条；本轮按用户提供的一张 16:9 背景图实现，因此：

| 项 | 草案 | 当前实现 |
|---|---|---|
| 舞台比例 | 16:10 | 16:9（与图片和用户要求一致） |
| 素材 | BG-01 + FG-01 + 3 张立绘 | 仅背景图 `bg-classroom.png` |
| 内容 | 讲解→轮转提问→报告 | 只有沉浸式舞台与退出入口 |

立绘与背景替换时保持 16:9 即可；若改成 16:10 素材，需要同时改 `CLASSROOM_ASPECT_RATIO` 与 `.tf-classroom-stage` 的两处比例。

## 验证方式

- `npm run test:layout-budget --workspace @teachforge/desktop`：`planAspectLock` 的保留宽度、短屏缩放、屏幕边界回夹。
- 实机（`npm run dev:desktop` 后进入课堂模式）：内容区 `innerWidth/innerHeight` 应为 16:9；拖右边缘与下边缘都等比变化；退出后窗口尺寸恢复，且随后可自由拉伸；从最大化状态进入会先还原为普通窗口并锁成 16:9。
