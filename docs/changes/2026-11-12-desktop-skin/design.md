# 桌面端皮肤与演练准备等待体验 — 设计

- 日期：2026-11-12
- 关联：[brief.md](brief.md) · [verification.md](verification.md)

## 1. 主题 token

`apps/desktop/src/styles.css` 的 `@theme` 块定义三组色阶，Tailwind v4 会生成 `bg-brand-700`、`text-ink-500` 这类工具类并输出为 CSS 变量：

| 色阶 | 取值（节选） | 用途 |
|---|---|---|
| `brand-50…900` | 50 `#f7f4ff`、600 `#6f43dd`、700 `#5b33b8`、900 `#35206b` | 主按钮、选中态、链接、焦点环、进度条、插画 |
| `ink-50…900` | 50 `#fbfaff`、200 `#eae7f4`、500 `#6f6a85`、900 `#221f31` | 文本、边框、次级文字、占位 |
| `honey-100…500` | 100 `#fff1d8`、300 `#ffc978`、500 `#f5a441` | 星点、旗帜、顶光等暖点缀 |

另定义 `--shadow-card` / `--shadow-float`；`rose-*` 继续承担错误语义，与 brand 不冲突。

约束：组件只使用这些语义类。`ink-500` 定为 `#6f6a85`（白底约 5.2:1）是为了不因换肤把次级文字降到 AA 以下；`ink-400` 仅用于占位与脚注。

## 2. 画布与装饰

- `.tf-canvas`：左上 `brand-100` 径向光、右上 `honey-100` 径向光、下半渐白，替代原来的纯白底，让玻璃态页头与浮动卡片有依托。
- `.tf-float` / `.tf-twinkle` / `.tf-rise`：插画漂浮、星点闪烁、内容淡入；三者在 `prefers-reduced-motion: reduce` 下全部关闭。
- `SidebarScenery`：侧栏底部山脊 + 旗帜 + 云 + 星点，绝对定位、向上渐隐，列表容器留 `pb-24` 防遮挡；纯 SVG、`aria-hidden`。
- 全局滚动条改为 10px `ink-300` 滑块，`::selection` 用 `brand-200`。

## 3. 界面约定

| 表面 | 设计 |
|---|---|
| 页头 | `bg-white/70` + `backdrop-blur-md` + `border-ink-200/80`，高度仍固定 `h-16` |
| 模式切换 | 胶囊分段控件：选中项 `brand-700` 白字，「演练模式」恒带 `GraduationCap`；未选中 `ink-500` |
| 会话侧栏 | `bg-brand-50/60`；选中行 `brand-100/80` + `brand-200` 内描边；导航项激活态为 `brand-100`/`brand-800` |
| 输入区 | 无投影白卡 `rounded-3xl` + `border-ink-200`；聚焦态只把边框换成 `brand-500`（1px，`transition-colors`），无 ring、无光晕、无 box-shadow；发送按钮 `brand-700` |
| 空对话首屏 | 白色圆角卡片 + 渐变图标 + 引导句，替代虚线占位框 |
| 演练开始页 | 品牌徽章、三枚价值标签（检验理解/发现盲点/练表达）、圆角卡片与主 CTA |

## 4. 演练准备画面

### 4.1 三个独立信号

| 信号 | 来源 | 职责边界 |
|---|---|---|
| 动图主图 | 本地 GIF 资源 | 只表达情绪，`alt=""` + `aria-hidden`，不承载信息 |
| 五段清单 | 后端 `GET /api/conversations/:id/rehearsals/preparing` 的 `phase` | 唯一对"真实进度"的声明；`repair` 归入「生成演练题目」；没有后端无法上报的阶段 |
| 进度条 | `estimatePreparingPercent(elapsedMs)` | 只安抚等待：指数逼近、封顶 90%，start 返回后补到 100% |

阶段映射：`history` → 读取学习内容；`prior_summaries` → 回顾演练记录；`session` → 加载上下文；`plan` + `repair` → 生成演练题目；`saving` → 保存计划。

版式自上而下：动图 → 标题（`正在为你准备演练题目…`）→ 两行说明 → 进度条 → 清单胶囊 → 状态文案（`role="status"`，`aria-live="polite"`）→ 慢等待提示（>45s）→ 底部说明。

完成态：进度条 100%、清单全部打勾、标题换成「准备完成，马上开始演练」、状态行「准备完成，正在进入演练…」，约 450ms 后切换。

### 4.2 动图处理

- 经 `import` 引入，Vite 按 `base: './'` 生成哈希路径（`dist/assets/rehearsal-preparing-*.gif`），打包后可用。
- GIF 自带 alpha（逐点采样四角与四周均为 `rgba(0,0,0,0)`），因此**不加**圆角卡片、`ring`、`shadow`、`mix-blend-multiply`、`mask-image`：描边/投影会把透明空白读成面板，遮罩在 74% 处就开始半透明并裁掉书堆、猫的轮廓。
- 显示尺寸 `h-52 md:h-64`（等比），不设固定宽高比容器。

## 5. 未采纳方案

| 方案 | 未采纳原因 |
|---|---|
| 保留自绘 SVG 插画并只换色 | 用户已指定主图，且自绘插画观感达不到参考图要求 |
| 只在准备画面加清单、去掉进度条 | 用户明确要求还原进度条；两者边界已在上表划清 |
| 动图套圆角卡片 + 投影 | 用户明确不要单独背景框；实测读成独立面板 |
| 输入框聚焦用硬 `ring-4` | 环画在盒外，被面板 `overflow-hidden` 在底部切断，且外扩半径与卡片圆角不重合，底角看起来半径变了 |
| 输入框聚焦用模糊外发光 | 在纯色边框的扁平卡片上会读成不自然的「污渍」；用户要求只高亮边框 |
| 输入框保留 `shadow-card` | 投影向下约 10px，余量不足会被面板 `overflow-hidden` 切出灰色横带；补足余量又会抬高输入区。用户要求只留边框，故彻底移除投影 |
| `mix-blend-multiply` 去白底 | GIF 背景本就是透明像素，混合模式只会让画布暖光把插画染色 |
| 覆盖 Tailwind 内置 `stone` 变量 | 会让"stone"含义隐晦；改为显式 `ink-*` 迁移，语义直白 |
