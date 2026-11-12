# 验收记录

- 日期：2026-11-12
- 状态：**自动化与视觉核对已通过**
- 设计：[design.md](design.md) · 简报：[brief.md](brief.md)

## 已执行

### 1. 类型与构建

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit --project tsconfig.app.json`（`apps/desktop`） | 通过 |
| `npm run build --workspace @teachforge/desktop` | 通过；产物内可查 `.bg-brand-700{background-color:var(--color-brand-700)}`、`.text-ink-500`、`.tf-canvas`，动图输出为 `dist/assets/rehearsal-preparing-DmPOmJVx.gif` |

### 2. 回归

| 套件 | 结果 |
|---|---|
| `npm run test:rehearsal` | 12/12 通过，含恢复的 `estimatePreparingPercent` 断言（5s < 45、20s > 80、60s > 88、全程 ≤ 90 且单调） |
| `npm run test:layout-budget` | 19/19 通过（未改动布局逻辑，确认皮肤迁移没有触碰几何） |
| 色板残留 | `grep -rn "emerald-\|stone-" apps/desktop/src apps/desktop/index.html` 结果 0 |

顺带修复：`apps/desktop/test/rehearsal-store.test.cjs` 的 bridge stub 缺 `pickChatAttachments`/`ensureContentWidth`/`releaseContentWidth`，导致 `hasDesktopBridge()` 恒为 false，最后一个用例在 `HEAD` 就已失败（用 `git stash` 回到 `HEAD` 复现确认）。补齐三个桩后 12/12 通过。

### 3. 视觉核对

环境：用户既有 dev server（`http://127.0.0.1:5173`），浏览器视口 1566×1005（对话界面）与 1400×1220（准备画面），临时入口截图后已删除。

| 检查 | 观察 |
|---|---|
| 应用外壳 | 画布紫罗兰晨光 + 右上暖光；侧栏 `brand-50/60` 与底部山脊/旗帜/星点可见；页头玻璃态透出渐变；输入框为无投影白卡（仅 1px 边框），发送按钮 `brand-700` |
| 模式切换 | 默认「对话模式」填充紫；点击后「演练模式」填充紫，另一侧回落为静默文本；两个页签各自带 16px 图标（`Chats` / `GraduationCap`），`aria-pressed` 与图标随状态同步 |
| 空对话首屏 | 计算样式：容器 `background: rgba(0,0,0,0)`、`border-width: 0`、`box-shadow: none`；截图确认图标与两段文案直接落在画布渐变上 |
| 准备画面 | 动图逐帧变化（人物动作、猫睁眼）；进度条 3s ≈ 28%、10s ≈ 62%，未越 90% |
| 动图无背景框 | `getBoundingClientRect` 后 `elementFromPoint(box+6,box+6)` 命中 `<img>` 本身；`borderRadius: 0px`、`boxShadow: none`、`mixBlendMode: normal`、无 `mask-image`；书堆底边、猫尾、耳机弧线完整 |
| GIF 透明通道 | 页面内 `drawImage` 采样：四角均为 `rgba(0,0,0,0)`，四周 8×8 网格点全透明，右中部为猫/书本体 |
| 输入框聚焦 | 计算样式：`border-color: rgb(140,102,242)`（brand-500）、`border-width: 1px`、`border-radius: 24px`、`box-shadow: none`；3× 放大截图四角与四边均匀，无外发光、无切边 |
| 输入框底部 | 逐行像素采样：1px 紫边以下全部是画布白，无投影残留；4× 放大截图底部只剩紫边，无灰色横带；容器回到 `pb-1`，卡片与面板几何与改动前一致 |
| 侧栏背景图（宽屏） | 计算样式 `background-size: 100% auto`、`background-position: 50% 100%`、`background-color: rgb(233,228,253)`；侧栏 256×1005，图片按 256 宽等比显示约 455 高，上方由同色天空补满，截图无接缝、无横向裁切 |
| 旗色保真 | 资源改用全彩 RGB 原件后，山顶三角旗采样为 `rgb(254,171,156)` 珊瑚色（原调色板副本中红系像素为 0，旗面呈灰白） |
| 侧栏背景图（窄屏 700px） | 媒体查询生效为 `cover`，侧栏 700×192，显示云海/地平线切片，导航文字对比度正常 |
| 侧栏「设置」 | 页脚计算样式 `background: rgb(255,255,255) / 0.45`、`backdrop-filter: blur(16px)`、`border-top: 1px` 白色；按钮 `color: rgb(51,47,69)`、`font-weight: 500`；4× 放大截图文字与画面可区分 |
| 表单字体层 | 修复前 `font-medium` 计算值为 400（`font: inherit` 在 layer 外压过工具类）；移入 `@layer base` 后「设置」= 500、发送按钮 = 600、输入框仍 400/14px |

### 4. 文档

- 新增 [docs/current/platform/desktop-skin.md](../../current/platform/desktop-skin.md)：色阶表、画布、装饰组件、动图约束与验证方式。
- [docs/current/index.md](../../current/index.md) 与 [docs/current/platform/index.md](../../current/platform/index.md) 加入入口。
- [docs/current/domains/rehearsals/index.md](../../current/domains/rehearsals/index.md) 更新准备画面事实：动图主图、五段清单、进度条与清单的信号边界、完成态文案。
- `docs/manifest.yaml` 新增 `desktop-skin` 路由（`apps/desktop/src/assets/**` 已入 code_globs），并修正 `rehearsal-start-latency` 路由描述里"progress bar"的表述。

## 未覆盖 / 残留风险

- 未在安装包中逐帧核对 GIF 播放（渲染层与开发环境同一套构建产物，风险低）。
- GIF 动画不受 `prefers-reduced-motion` 控制，需要静态降级时须另出静态帧资源。
- 准备画面的真实阶段清单只在 mock 的 `phase: 'plan'` 与 store 单测下验证；真实 start 的相位跳变未在本次人工复核中逐段观察。
