---
status: current
layer: platform
domain: desktop-skin
canonical_for:
  - desktop-skin-tokens
related:
  - docs/current/platform/index.md
  - docs/current/index.md
  - docs/current/domains/rehearsals/index.md
last_verified: 2026-11-12
---

# 桌面端皮肤与语义颜色

本页描述 `apps/desktop` 渲染层实际生效的皮肤事实：主题 token、环境光背景、装饰元素和组件用法约束。皮肤只影响展示，不改变任何接口、状态机或持久化行为。

## 主题 token

Tailwind v4 的 `@theme` 块在 [apps/desktop/src/styles.css](../../../apps/desktop/src/styles.css) 中定义三组语义色阶，渲染进程生成的工具类直接引用这些 CSS 变量：

| 色阶 | 语义 | 取值 | 用途 |
|---|---|---|---|
| `brand-50…900` | 学习主色（紫罗兰） | 50 `#f7f4ff`，600 `#6f43dd`，700 `#5b33b8`，900 `#35206b` | 主按钮、选中态、链接、焦点环、进度与插画 |
| `ink-50…900` | 中性色（同调偏紫，非暖灰） | 50 `#fbfaff`，200 `#eae7f4`，500 `#6f6a85`，900 `#221f31` | 文本、边框、次级文字、占位 |
| `honey-100…500` | 暖色点缀 | 100 `#fff1d8`，300 `#ffc978`，500 `#f5a441` | 顶光、星点、旗帜、情绪标记 |

另有 `--shadow-card`、`--shadow-float` 两级柔和投影，对应 `shadow-card`、`shadow-float` 工具类。

约束：组件只使用上述 token 类；不引入 `emerald`/`stone` 或其它原始色板名，避免同一界面出现两套主题来源。语义错误色仍用 `rose-*`，它与 brand 不冲突。

## 环境与装饰

- `.tf-canvas`：应用根节点背景，左上紫罗兰晨光、右上暖光、中部近白的线性渐变。`App.tsx` 的 `<main>` 使用它代替原来的纯白底。
- `.tf-glow`：局部柔光层，供需要"准备/期待"情绪的画面叠加。
- `.tf-float`、`.tf-twinkle`、`.tf-rise`：插画漂浮、星点闪烁、内容淡入上升。三者都在 `prefers-reduced-motion: reduce` 下关闭。
- 滚动条全局改为 10px、`ink-300` 半透明滑块；`::selection` 用 `brand-200` 底色。
- `index.html` 的 `theme-color` 与画布起始色一致（`#f7f4ff`）。

装饰组件：

| 组件 | 位置 | 行为 |
|---|---|---|
| 侧栏背景图 | [apps/desktop/src/assets/sidebar-dreamy-peak.png](../../../apps/desktop/src/assets/sidebar-dreamy-peak.png) | `.tf-sidebar-art`：底对齐、`background-size: 100% auto`（不改宽度、不拉伸），上方空白用图片自身的天空色 `#e9e4fd` 平铺，接缝不可见；窄屏堆叠布局（`max-width: 767px`）改用 `cover`，避免只剩一片天空。必须使用全彩原始文件（RGB PNG）：调色板量化过的副本会丢掉山顶三角旗的珊瑚色 |
| 准备动图 | [apps/desktop/src/assets/rehearsal-preparing.gif](../../../apps/desktop/src/assets/rehearsal-preparing.gif) | 演练准备画面的主图（427×409 动图，约 340 KB），由 `RehearsalPreparing` 以 `import` 引入，Vite 按 base `./` 生成哈希路径；`alt=""` 且 `aria-hidden` |

侧栏背景图由 CSS 提供，不占 DOM 节点、`aria-hidden` 天然成立、无交互；它不受主题 token 控制，换图或换色调时只替换该 PNG 或改 `.tf-sidebar-art` 的 `background-color`。列表容器保留 `pb-24`，让最后几行不压在旗帜与云层上。

准备动图自带 alpha 通道（四角与四周均为透明像素），所以直接叠在画布上即可：不加圆角卡片、描边、投影或 `mix-blend-multiply`，也不用 `mask-image` 收边——任何"背景框"或边缘遮罩都会读成独立面板或裁掉书堆、猫的轮廓。动图不受主题变量控制，展示尺寸固定（`h-52 md:h-64`，等比缩放），换肤时只需替换图片文件。

## 界面约定

- `PageHeader` 为玻璃态：`bg-white/70` + `backdrop-blur-md` + `border-ink-200/80`，让画布渐变透出。
- 会话模式切换是胶囊分段控件：选中项填 `brand-700` 白字；两个页签都恒带 16px 图标——「对话模式」用 `Chats`（两个对话气泡），「演练模式」用 `GraduationCap`；未选中项为 `ink-500` 图标＋文本，`gap-1.5`；不可用的页签（当前会话还没有完成一轮对话时的「演练模式」）改用 `ink-300` + `cursor-not-allowed`，不加 `opacity`，避免和禁用主按钮的 40% 透明度混在一起；因原生 `disabled` 按钮不接收指针事件，说明文案放在外层 `span` 的 `title` 上。
- 输入框是**无投影**白卡（`rounded-3xl`、`border border-ink-200`、不加 `shadow-*`）。聚焦态只高亮边框：`ink-200` 转 `brand-500`（1px，`transition-colors`），不加 `ring`、不加外发光、不加任何 box-shadow，聚焦前后几何完全不变。三种被否掉的方案及其原因见下：
  - 外扩硬 `ring`：被面板 `overflow-hidden` 在底部切出直线，且外扩半径与卡片圆角不重合，表现为「扩散不自然、底角对不齐」。
  - 模糊外发光：扁平白卡上出现光晕显得脏。
  - 保留 `shadow-card`：第二层 `0 12px 32px -18px` 向下约 10px，容器余量不足时被 `overflow-hidden` 切出一条灰色横带，像底部没清理干净；补足余量又会把输入区整体抬高，不如直接不投影。
- 侧栏头部入口顺序固定为「新建课题 / 资料库 / 知识掌握 / 课堂模式」，图标依次为 `NotePencil`、`Books`、`Stack`、`Chalkboard`，样式与选中态一致；课堂模式占满窗口、隐藏侧栏，因此该入口只用于进入。
- 课堂模式舞台是整窗背景图 + 两枚玻璃态胶囊（左上「退出课堂模式」、右上「课堂模式」标签）：`bg-white/70–80` + `backdrop-blur-md` + `border-white/60–70`，文字 `ink-800` / `brand-800`，不加深色遮罩，避免压暗教室画面。舞台比例与窗口比例的约定见[课堂模式](classroom-mode.md)。
- 会话侧栏底色是背景图（见下），选中行 `brand-100/80` + `brand-200` 描边；底部「设置」栏是玻璃条（`bg-white/45` + `backdrop-blur-lg` + `border-t border-white/60`），把它从山峰、山道、云层那块最花的画面上分离出来，文字用 `ink-800`、`font-medium`。
- 表单控件的基础样式放在 `@layer base`：`button/input/textarea { font: inherit }` 若写在 layer 外会压过 Tailwind 工具类，而且 `font` 简写会重置 `font-weight`，导致按钮上的 `font-medium`/`font-semibold` 全部失效。
- 空状态统一由 [apps/desktop/src/components/EmptyState.tsx](../../../apps/desktop/src/components/EmptyState.tsx) 渲染：一个 `brand-400` filled 图标（36px）+ 标题 + 两行说明 + 一行提示，无卡片、无边框、无投影、无胶囊底色，避免在内容上方叠出第二块面板。现有使用者是对话首屏（`Sparkle`）、资料库空列表（`Books`）与知识掌握空列表（`Stack`）；图形取侧栏同一入口的图标，视觉重量与首屏星点一致。
- 空状态在可视区域垂直居中（外层滚动容器改为 `flex flex-col`，空状态自身 `my-auto`）；说明文字最宽 `max-w-sm`，因此每段控制在两行内，第三行只放"下一步做什么"的提示。加载态同样 `my-auto` 居中，避免加载完成时空状态从顶部跳到中间。

## 验证方式

- `npm run build:renderer --workspace @teachforge/desktop` 校验 TypeScript 与 Tailwind 产物；生成的 CSS 中应能查到 `.bg-brand-700`、`.text-ink-500` 等 token 工具类。
- 视觉核对：`npm run dev:desktop` 后打开 `http://127.0.0.1:5173/`，检查画布、侧栏装饰、模式切换和首屏卡片。
- 演练准备画面需要真实 start 才会出现，单独核对时用临时入口渲染 `RehearsalPreparing`（传入 `{ rehearsalId, phase }`），截图后删除该入口。确认动图在动、进度条在 5s 与 12s 之间明显前进但不超过 90%。
