# 课堂模式与 16:9 窗口 — 简报

- 日期：2026-11-12
- 状态：已实施并验收
- 关联：[design.md](design.md) · [verification.md](verification.md) · [current 课堂模式](../../current/platform/classroom-mode.md)

## 用户诉求（验收标准）

> 在「知识掌握」的下方新增一项菜单——课堂模式。点击后打开一个界面，该图作为界面的背景图。图片比例 16:9，因为为了保证效果，需要确保主界面的宽高刚好也是这个比例，但考虑到界面可以动态调整，用户可以拉伸，因此进入这种模式后，强制进入 16:9 的宽高比例。用户可以让整体界面更大，但是不能单独拉伸宽度和高度。

拆成可验收项：

1. 侧栏「知识掌握」下方新增「课堂模式」入口。
2. 点击后打开课堂界面，提供的教室图作为背景。
3. 进入后窗口（内容区）比例恒为 16:9，背景图不被拉伸、不被裁切。
4. 用户可以整体放大或缩小，但不能只拉伸宽或高；拖动任一边都等比变化。
5. 退出后窗口恢复正常可自由拉伸，且用户进入前的窗口尺寸得到还原（除非用户在模式内改过尺寸）。

## 范围

| 层 | 位置 |
|---|---|
| 侧栏入口与视图切换 | `features/agent/ConversationSidebar.tsx`、`features/agent/AgentChatPage.tsx` |
| 舞台组件与样式 | `features/classroom/ClassroomMode.tsx`、`src/styles.css`、`src/assets/classroom/bg-classroom.png` |
| 窗口比例 | `electron/main/main.ts`、`electron/main/window-layout.ts`、`electron/preload/preload.ts`、`src/types/desktop-bridge.ts` |

## 不在本轮

- 课堂状态机（讲解 → 学生轮转提问 → 报告）、学生立绘、气泡与降级列表，仍按 [学习趣味性设计讨论](../../source/学习趣味性设计讨论.md) 3.7 节立项实施。
