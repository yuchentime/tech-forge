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
| `SidebarScenery` | [apps/desktop/src/components/SidebarScenery.tsx](../../../apps/desktop/src/components/SidebarScenery.tsx) | 会话侧栏底部的山脊、旗帜、云与星点，绝对定位并向上渐隐；列表容器留 `pb-24` 避免遮挡行 |
| 准备动图 | [apps/desktop/src/assets/rehearsal-preparing.gif](../../../apps/desktop/src/assets/rehearsal-preparing.gif) | 演练准备画面的主图（427×409 动图，约 340 KB），由 `RehearsalPreparing` 以 `import` 引入，Vite 按 base `./` 生成哈希路径；`alt=""` 且 `aria-hidden` |

侧栏装饰是纯 SVG，颜色全部走 token 变量，因此与色阶同步换肤；两者都 `aria-hidden`、无角色、无交互。

准备动图自带 alpha 通道（四角与四周均为透明像素），所以直接叠在画布上即可：不加圆角卡片、描边、投影或 `mix-blend-multiply`，也不用 `mask-image` 收边——任何"背景框"或边缘遮罩都会读成独立面板或裁掉书堆、猫的轮廓。动图不受主题变量控制，展示尺寸固定（`h-52 md:h-64`，等比缩放），换肤时只需替换图片文件。

## 界面约定

- `PageHeader` 为玻璃态：`bg-white/70` + `backdrop-blur-md` + `border-ink-200/80`，让画布渐变透出。
- 会话模式切换是胶囊分段控件：选中项填 `brand-700` 白字，「演练模式」恒带 `GraduationCap` 图标；未选中项为 `ink-500` 文本。
- 输入框是浮动白卡（`rounded-3xl`、`shadow-card`），聚焦时 `brand-400` 边框 + `brand-200/50` 四像素光环；发送按钮 `brand-700`。
- 会话侧栏底色为 `bg-brand-50/60`，选中行 `brand-100/80` + `brand-200` 描边；空对话首屏是带渐变图标的白色圆角卡片，而不是虚线占位框。

## 验证方式

- `npm run build:renderer --workspace @teachforge/desktop` 校验 TypeScript 与 Tailwind 产物；生成的 CSS 中应能查到 `.bg-brand-700`、`.text-ink-500` 等 token 工具类。
- 视觉核对：`npm run dev:desktop` 后打开 `http://127.0.0.1:5173/`，检查画布、侧栏装饰、模式切换和首屏卡片。
- 演练准备画面需要真实 start 才会出现，单独核对时用临时入口渲染 `RehearsalPreparing`（传入 `{ rehearsalId, phase }`），截图后删除该入口。确认动图在动、进度条在 5s 与 12s 之间明显前进但不超过 90%。
