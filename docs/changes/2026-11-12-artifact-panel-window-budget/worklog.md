# 实施记录

- 日期：2026-11-12
- 设计：[design.md](design.md) · 验收：[verification.md](verification.md)

## 落地清单

| 文件 | 变化 |
|---|---|
| `apps/desktop/src/features/agent/layout-budget.ts` | 新增：宽度预算常量、`clampPanelWidth`、`planArtifactLayout`（舒适档 / 下界档 / 悬浮） |
| `apps/desktop/electron/main/window-layout.ts` | 新增：`planWindowGrowth`（只返回 `{x,width}`）、`clampContentWidthRequest`、`isSnappedWidth`、`resolveRestoredBounds`、`sameHorizontalBounds` |
| `apps/desktop/electron/main/main.ts` | 新增 `window:ensure-content-width` / `window:release-content-width`、`windowBaselines` + `pendingGrowth`、`will-resize` 失效、窗口尺寸持久化（`userData/window-state.json`，去抖 500ms，关闭时同步写） |
| `apps/desktop/electron/preload/preload.ts`、`src/types/desktop-bridge.ts` | 桥接两个窗口宽度能力 + `hasDesktopBridge` 校验 |
| `apps/desktop/src/features/agent/ArtifactSidebar.tsx` | 删除 `innerWidth - 560` 算术；意图单一真值；渲染期用规划宽度；打开/拖宽申请扩窗、隐藏/卸载延迟 250ms 还原；悬浮模式（`absolute z-30` + `Esc`） |
| `apps/desktop/src/features/agent/AgentChatPage.tsx` | 面板所在行加 `relative` 作为悬浮定位上下文 |
| `apps/desktop/tsconfig.electron.json` | 把 `layout-budget.ts` 纳入 electron 构建，供 `node --test` 直接 require |
| `apps/desktop/test/layout-budget.test.cjs`、`test/window-layout.test.cjs` | 19 条纯函数回归；`package.json` 加 `test:layout-budget` |

## 过程中的关键修正（真实窗口实测才发现）

1. **高度漂移**：只传 `{x,width}` 时 Electron 会从 content rect 反推高度并再次补边框，125% 缩放下每轮 +2~3px（822→826→829→831）。改为每次 `setBounds` 都显式带上高度。
2. **读回值当输入**：即使显式带高度，若每轮写回"上一轮读回的 bounds"，还原宽度仍会 962→963→964、高度 823→825→826 累积。改为**每个窗口只采样一次 baseline**（`windowBaselines`），扩与还原都是它的纯函数；只有用户自己 `will-resize` 时才丢弃重采样。
3. **还原判据**：原来比较整个 rect，被 Electron 的高度取整误判成"用户动过窗口"而拒绝还原（实测第 2 轮起 `released:false`）。改为只比较 `x` 与宽度（容差 1px）。
4. **收益**：连续 6 轮扩/还原逐轮完全一致（1279×823 ↔ 962×823），上限 2048/内容 2034 也符合规划；代价是与原始 960×822 有一次性的 +2/+1 取整偏移，之后不再变化。

## 实施后回归修复

1. **拖拽手柄消失**：把 `<aside>` 改成 `flex-col` 时，位于第一个子节点的 6px 拖拽手柄（`w-1.5`）在列方向高度塌成 0，看起来像"手动拖宽功能没了"。已恢复为行布局（`flex` + 手柄在左），并加注释说明该容器不能变成 column；悬浮模式同样保持行布局。

## 已知遗留

- 应用内目测项（真机点"文件"按钮）本轮未执行，列在 [verification.md §待人工执行](verification.md)。
- `test:rehearsal` 3/12：改动前用 `git stash` 复跑结果相同，与本变更无关。
- 拖拽到显示器上限时，面板渲染宽度会先停在规划值（意图继续增长），松手后才按意图申请扩窗；这是"不追指针"的已知取舍。
