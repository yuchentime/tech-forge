# 课堂模式与 16:9 窗口 — 设计

- 日期：2026-11-12
- 状态：已实施，验收见 [verification.md](verification.md)
- 简报：[brief.md](brief.md)

## 1. 布局：舞台占满窗口

窗口被锁成 16:9 后，若侧栏还在，舞台只能得到「宽 − 256」的内容区，比例不再等于背景图的 16:9，只能裁边或留黑边。因此进入课堂模式不渲染侧栏与聊天头，舞台直接铺满内容区：

- `AgentChatPage` 在 `activeView === 'classroom'` 时只渲染 `ClassroomMode`，其余视图包在 fragment 里；
- 退出依赖舞台自己的「退出课堂模式」按钮与 `Esc`，不再依赖侧栏入口（侧栏此时不存在）；
- 与「演练模式」不同，这里没有淡入淡出叠层：两个视图共用同一块空间会互相压缩宽度，切换瞬态里会出现非 16:9 的一帧。

舞台比例在 CSS 层单独保证，即使窗口比例锁不上也不变形：

- `.tf-classroom-viewport { container-type: size }` 提供 `100cqw` / `100cqh`；
- `.tf-classroom-stage` 取 `min(100cqw, 100cqh * 16/9) × min(100cqh, 100cqw * 9/16)`，即视口内最大的 16:9 矩形；
- 背景 `cover`；窗口锁成功时舞台与内容区同尺寸，即无裁剪、无留边。
- 舞台外使用 `ink-900` 作为留边底色，只在浏览器预览或最大化窗口时可见。

## 2. 窗口比例：自己实现，不用 `setAspectRatio`

三版候选：

| 方案 | 结论 |
|---|---|
| `win.setAspectRatio(16/9)` | **实测不满足**：125% 缩放、边框 16×39 的 Windows 上，约束的是窗口外框。窗口 1643×924（1.778）时内容区为 1628×886（1.8375），舞台左右各留 26px 黑边 |
| `setAspectRatio(16/9, frameSize)` | **实测同样不满足**：传入实测边框后拖拽结果仍是窗口外框 16:9、内容区 1.8374，`extraSize` 在 Windows 上没有把约束转到内容区 |
| `will-resize` 内自行修正 | **采用**：按实测边框把建议尺寸换算到内容区，保留位移更大的那条轴，另一轴按 16:9 推导，`preventDefault()` 阻止系统原本这次尺寸 |

采用方案的细节（`electron/main/main.ts`）：

- 进入：先退出全屏/最大化（比例只约束普通窗口），`planAspectLock` 用当前尺寸算出内容区 16:9 的 bounds（保留宽度、推导高度、夹进 `workArea`），记录 baseline 后写入。
- 拖动：`will-resize` 拿到建议 bounds 与当前内容区，`widthDominant = |Δ内容宽|×高 ≥ |Δ内容高|×宽`，决定保留哪条轴；修正后 `setBounds`。程序化 `setBounds` 不再触发 `will-resize`，不会回环。
- 离开：删除锁；`resized` 标记为真（用户在模式内拖过）或窗口已最大化/全屏时保留用户尺寸，否则写回 baseline。

### 为什么还原判断用标记而不是比较 bounds

写入的 bounds 会被 Windows 改写几像素（实测写 1684×975、读回 1686×976；另一轮写 1686×977、读回 1688×978）。用「当前 bounds 是否等于写入值」判断会把这次系统改写误判成用户缩放，从而永远不还原。改为在 `will-resize` 里置 `resized = true`：该事件只在用户手动缩放时触发，语义精确。

### 窗口尺寸记忆

模式期间保存到 `userData/window-state.json` 的是 baseline，不是临时的 16:9 尺寸；否则下次启动会把课堂模式的窗口尺寸固化成默认大小。

### 与文件面板的窗口能力共存

进入课堂模式会卸载聊天视图，`ArtifactSidebar` 的卸载回调立即 `releaseContentWidth()`。两条 IPC 顺序执行：先释放面板扩窗、再锁比例，互不覆盖。

## 3. 渲染层契约

- 新桥接能力只有 `setClassroomMode(enabled: boolean)`，`hasDesktopBridge()` 同步校验；普通浏览器预览没有该能力时舞台照常显示，仅窗口比例不锁（CSS 留边）。
- 组件 `useEffect` 在挂载时打开、卸载时关闭，覆盖按钮退出、`Esc`、窗口关闭三种离开路径。
- 挂载/卸载不写任何持久化状态，课堂模式不进 URL/本地存储。

## 4. 与设计稿的差异

[课堂模拟图像素材规格](../../source/课堂模拟图像素材规格.md) 定义 16:10 舞台与立绘素材；本轮按用户提供的 16:9 单张背景实现。若后续改用 16:10 素材，需要同步改 `CLASSROOM_ASPECT_RATIO` 与 `.tf-classroom-stage` 的两处比例，否则会出现留边或裁剪。
