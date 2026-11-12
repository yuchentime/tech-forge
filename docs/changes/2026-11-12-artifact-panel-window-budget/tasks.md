# 实施任务（二版）

- 日期：2026-11-12
- 状态：已实施（T1–T3、T4、T5 完成；应用内目测项见 verification.md）
- 设计：[design.md](design.md)

## 顺序

### T1 宽度预算与分配规则（纯函数，先测通）

- 新增 `apps/desktop/src/features/agent/layout-budget.ts`：常量、`clampRequestedPanelWidth`、`planArtifactLayout`（单公式：窗口优先 → 面板收窄 → 悬浮）。
- 新增 `apps/desktop/test/layout-budget.test.cjs`；`package.json` 加 `test:layout-budget`（沿用"先 `build:electron` 再 `node --test dist-electron/..."）。
- 覆盖 [verification.md §1](verification.md) 的 8 条断言，含 1077/1136/1008 三个边界。

### T2 窗口几何（纯函数 + Main 接线）

- 新增 `electron/main/window-layout.ts`：`planWindowGrowth`、`isSnappedHeuristic`、`clampContentWidthRequest`、`resolveRestoredBounds`（T4 复用）。
- 新增 `apps/desktop/test/window-layout.test.cjs`。
- `electron/main/main.ts`：`ipcMain.handle('window:ensure-content-width' / 'window:release-content-width')`、`grownFrom` 记录、`will-resize` + `resize` 作废、`screen.getDisplayMatching`、跳过最大化/全屏/吸附。

### T3 面板接入（体验落点）

- `src/types/desktop-bridge.ts` + `electron/preload/preload.ts`：两个桥函数与 `hasDesktopBridge` 检查。
- `ArtifactSidebar.tsx`：
  - 删除 `RESERVED_LAYOUT_WIDTH` 与 `applyWidth` 的窗口算术；`requestedPanelWidth` 成为唯一真值，**存储只写意图、不写夹紧值**。
  - 订阅 `innerWidth`；`maxContentWidth` 状态来自扩窗回包；渲染期用 `planArtifactLayout` 求 `mode/panelWidth`。
  - 打开/挂载可见时 `ensureContentWidth(requiredContentWidth)`；拖拽结束与键盘调整只在意图变大时申请一次。
  - 隐藏/卸载时 250ms 后 `releaseContentWidth()`（可取消）。
  - 按 `mode` 切 split / overlay 模板；overlay 补 `Esc` 收起、`z-30`、左缘阴影，不加遮罩。

### T4 窗口尺寸记忆（建议同批，可拆分）

- 为什么：用户"喜欢小窗口"，每次启动回到 1280×820 同样是重复手工调整。
- 做法：`resize`/`move` 去抖保存 `getBounds()` 到 `userData` 的 JSON；`createWindow` 读取后用 `resolveRestoredBounds` 按当前显示器 `workArea` 回夹（屏幕变小/拔掉外接屏不会跑到屏幕外）。
- 细节：关闭窗口时若 `grownFrom` 存在，保存**扩展前**的宽度，避免把"打开过文件面板的临时宽窗"固化成默认尺寸。

### T5 文档同步

- `docs/current/domains/artifacts/index.md` 前端章节：补"宽度预算与窗口扩展"与"面板宽度是意图"两条，并注明旧 `innerWidth - 560` 算术已删除。
- `docs/current/platform/architecture-and-code-placement.md`：preload 接口表补窗口能力，写明"Renderer 只提需求、Main 决定几何"边界（与现有"不暴露任意 IPC"一致）。
- `docs/changes/README.md`、`docs/manifest.yaml`：状态与描述改为实施结果。

## 完成定义

- [verification.md §0](verification.md) 的 4 条体验验收全部通过：连续 10 次开关零手动、收起即还原、偏好不被改写、用户尺寸不被回抢。
- 默认 1280 窗口打开面板 `getBounds()` 不变。
- 1077 内容宽的屏（1366@125%）仍保持拆分，不落悬浮。
