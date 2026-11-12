# 桌面端皮肤与演练准备等待体验 — 简报

- 日期：2026-11-12
- 状态：已实施并验收
- 关联：[design.md](design.md) · [verification.md](verification.md) · [current 皮肤事实](../../current/platform/desktop-skin.md)

## 用户诉求（验收标准）

> 优化应用的桌面皮肤，让学习不那么枯燥，学习前先给人提供一些预约的情绪。参考这张图，对齐主题色。

随后两轮具体指令：

1. 演练模式点「开始演练」等待第一道题时，主图换成提供的 AI 耳机女孩与熟睡小猫 GIF。
2. 还原进度条。
3. 主图要自然融入背景，不要再有单独的背景框。

拆成可验收项：

- 全应用配色向参考图的紫罗兰主题对齐，界面不再出现两套色系。
- 进入演练前的等待画面有情绪化主图与明确的"正在为你准备"叙事，而不是干等。
- 准备画面同时给出：情绪层（动图）、真实阶段（后端 phase 清单）、等待节奏（进度条）三者，且互不冒充。
- 动图不带卡片、描边、投影或混色遮罩，直接叠在画布上。

## 范围

| 层 | 位置 |
|---|---|
| 主题 token 与全局样式 | `apps/desktop/src/styles.css`、`apps/desktop/index.html` |
| 应用外壳 | `App.tsx`、`components/PageHeader.tsx`、`components/SidebarScenery.tsx` |
| 会话界面 | `features/agent/AgentChatPage.tsx`、`ConversationSidebar.tsx`、其余 agent 视图 |
| 演练界面 | `features/rehearsal/RehearsalPreparing.tsx`、`RehearsalStart.tsx`、`rehearsal-preparing-progress.ts`、`assets/rehearsal-preparing.gif` |
| 资源 | `apps/desktop/src/assets/rehearsal-preparing.gif`（427×409，约 340 KB，自带 alpha） |

## 非目标

- 不改任何后端接口、状态机、持久化或提示词。
- 不改布局结构（侧栏、面板、窗口几何）；只换皮肤与准备画面内容。
- 不为动图做静态降级版本；`prefers-reduced-motion` 只关闭 CSS 动画。
- 不引入第二套主题机制（不做暗色模式、不做用户可选皮肤）。

## 决策记录

| 决策 | 理由 |
|---|---|
| 用 Tailwind v4 `@theme` 定义 `brand`/`ink`/`honey` 三组语义色阶，并把全部 `emerald-*`/`stone-*` 机械迁移 | 迁移后仓库无原始色板名；换肤只改一处，避免组件里再出现"第二主题来源" |
| 准备画面拆成三个信号：动图（情绪）、五段清单（真实 phase）、进度条（预计节奏） | 清单只能来自后端 `phase`，不许出现后端无法上报的阶段；进度条封顶 90%，只有真实完成才补满 |
| 中途曾删除进度条（认为与清单重复），随后按用户要求还原 | 用户明确要"等等有反馈"的节奏感；两个信号并存是明确取舍，已在 design 中写明职责边界 |
| 丢弃自绘 SVG 插画，改用用户提供的 GIF | 用户指定主图；自绘 SVG 在观感上达不到要求，留着就是死代码 |
| 动图不加圆角卡片/描边/投影/`mix-blend-multiply`/`mask-image` | GIF 自带 alpha（逐点采样四角均为 `rgba(0,0,0,0)`）；加框会把透明区读成面板，遮罩 74% 起裁掉书堆与猫的轮廓 |

## 遗留

- GIF 自身动画不受 `prefers-reduced-motion` 控制；如需静态降级要另出静态帧资源（本次不做）。
- 资产 340 KB 打进渲染包，可接受；若后续换更大动图，应评估是否改 `public/` 懒加载。
