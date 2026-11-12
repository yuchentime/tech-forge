# 文件面板与聊天列的宽度预算（窗口自动扩展）— 简报

- 日期：2026-11-12（2026-11-12 二版评审重写）
- 状态：已实施（应用内目测项待人工执行）
- 关联：[design.md](design.md) · [tasks.md](tasks.md) · [verification.md](verification.md) · [worklog.md](worklog.md)

## 用户诉求（验收的唯一标准）

> 我习惯小窗口对话。打开文件面板时，我不想再手动拖宽度，只想同时、舒适地看到对话和文件。

因此本次改动的验收不是"窗口能变大"，而是：

1. **零手动操作**：任意窗口宽度下打开文件面板，对话区与文件区都不需要用户拖拽就落在可读宽度。
2. **意图不被破坏**：用户手动调过的面板宽度是长期偏好，只在当下空间不够时临时收窄，空间回来时恢复原宽度，**不能**被窄窗口改写成新的默认值。
3. **不抢尺寸**：应用只在"打开文件面板让需求变大"时扩窗；用户自己拉的窗口尺寸永不被回抢。

## 现状为什么导致"每次都要手动调"

| 证据 | 位置 | 后果 |
|---|---|---|
| 面板宽度 = `innerWidth - RESERVED_LAYOUT_WIDTH(560)` 后**写回 `localStorage`** | `ArtifactSidebar.applyWidth` + `handleResizeEnd` | 在小窗口里拖一次，偏好被永久改成窄值；换到大窗口又得拖回去——这正是"每次都要手动调"的机制 |
| 面板是聊天列的兄弟节点，聊天列 `min-w-0 flex-1` 无下限 | `AgentChatPage.tsx` | 960 外层窗开面板 → 聊天列约 304px（`[INFERENCE]`：按 1280−16−256−384 推算边框差），正文、标题、模式切换一起被压扁 |
| 应用从不与操作系统窗口尺寸协商，也没有窗口尺寸记忆 | `electron/main/main.ts:692` | 唯一弹性资源（窗口宽度）完全没用上；每次启动都回到 1280×820 |

## 目标

- 默认 1280×820 窗口：打开/关闭面板**尺寸零变化**（现有体验不动）。
- 小窗口：打开面板时窗口自动扩到"刚够用"，关闭时自动还原成用户的窄窗口。
- 面板宽度只作为**意图**保存；每一刻实际宽度由空间分配规则决定。

## 非目标

- 不改文件面板的信息架构、预览、全屏、删除。
- 不改 `minWidth: 960`；不把 `max-width` 加到聊天正文（窗口只在不够时增长，不会被拉成超长行）。
- 不做独立预览窗口（见 design.md「未采纳方案」）。
- 窗口尺寸记忆（跨启动）单独列为 P1，可与本变更一起或分开落地。

## 范围

| 层 | 位置 |
|---|---|
| 宽度预算 + 分配规则（纯函数） | `apps/desktop/src/features/agent/layout-budget.ts`（新增） |
| 窗口几何（纯函数） | `apps/desktop/electron/main/window-layout.ts`（新增） |
| 窗口能力桥 | `electron/main/main.ts`、`electron/preload/preload.ts`、`src/types/desktop-bridge.ts` |
| 面板消费 | `src/features/agent/ArtifactSidebar.tsx` |
| 文档 | `docs/current/domains/artifacts/index.md`、`docs/current/platform/architecture-and-code-placement.md` |
