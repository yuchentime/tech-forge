---
status: current
layer: change
domain: agent-runtime
canonical_for:
  - rehearsal-persona-persistence-verification
last_verified: 2026-11-10
version: 1.0
---

# 学生画像本地持久化验收

- 日期：2026-11-10

## 自动检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端类型 | `npx tsc -p apps/backend/tsconfig.build.json --outDir apps/backend/.test-dist` | 通过 |
| 演练域回归 | `node --test apps/backend/test/rehearsal.test.cjs` | 11/11 通过 |
| 桌面 store 回归 | `npm run test:rehearsal`（apps/desktop） | 8/8 通过 |
| 渲染打包 | `npx vite build`（apps/desktop） | 通过 |
| Electron 主进程编译 | `npm run build:electron`（apps/desktop） | 通过 |

> `npm run build:renderer` 仍会被 `RehearsalReport.tsx` 的既有 `onBackChat` 未使用告警拦下（本次改动之前就存在，未在本次范围内修改）。

## AC

| AC | 断言 | 证据 |
|---|---|---|
| AC1 默认空 | 文件不存在时 `GET` 返回 `{ persona: '' }` | `rehearsal.test.cjs` · `the student persona persists in one local file shared by every conversation` |
| AC2 原子写盘 | trim 后写入 `<configDir>/rehearsal-persona.txt`，内容与返回值一致 | 同上 |
| AC3 清空 | 保存空白文本后文件为空，读取仍为 `''` | 同上 |
| AC4 上限 | 1001 字符返回 400 且不改写既有文件 | 同上 |
| AC5 进入即读取 | 进入任一会话的演练模式时并行请求 `GET /api/rehearsal-persona`，写入 snapshot.persona | `apps/desktop/test/rehearsal-store.test.cjs` · `the student persona is read on entry and saved when the editor blurs` |
| AC6 失焦保存 | `PUT /api/rehearsal-persona` 携带原文；响应回来后 snapshot.persona 为服务端 trim 后的值 | 同上 |
| AC7 失败保留输入 | 保存失败时 snapshot.persona 保留用户输入，`personaError` 显示后端消息 | 同上 · `a failed persona save keeps the typed text and reports the error` |

## 界面

用 vite 起渲染进程，挂载真实 `RehearsalStart`（临时页面 + 临时入口，验证后删除），在 Chromium 中驱动：

- 初始值来自传入的画像；
- 编辑后按 Tab 失焦 → `onSavePersona` 收到新文本，父状态同步更新，计数 1；
- 不编辑再失焦 → 不再触发保存（仍为 1 次）；
- 传入 `personaError` 时输入框下方出现 `role="alert"` 的错误文本。

## 未覆盖

- 真实 Electron 窗口 + 真实后端文件的端到端（需要模型与桌面环境）；文件读写与 HTTP 契约由后端测试覆盖。
- 多窗口同时编辑同一文件：最后写入者生效，无冲突检测（设计如此）。
