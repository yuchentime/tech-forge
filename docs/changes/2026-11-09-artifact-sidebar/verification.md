# Artifact 会话文件侧边栏 — 验证

- 日期：2026-11-09

## 自动化

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端类型 | `npx tsc --noEmit -p tsconfig.build.json` | 通过 |
| 渲染进程类型 | `npx tsc --noEmit -p tsconfig.app.json` | 通过 |
| Electron 主进程与 preload | `npx tsc --noEmit -p tsconfig.electron.json` | 通过 |
| 渲染构建 | `npm run build:renderer` | 通过（Mermaid 独立 chunk，未进入首屏主包） |
| 产出文件端到端 | `npm run verify:artifacts` | 通过 |
| 历史投影回归 | `npm run test:conversation-history` | 5/5 通过 |
| 文件工具边界回归 | `node --test test/workspace-file-tools.test.cjs` | 3/3 通过 |

`verify:artifacts` 在临时数据目录中：执行新迁移 → 登记会话内文件与外部文件 → 同一路径重写保持 `id` → 列表/正文/位置 → 删除文件后 `missing` 为真 → 启动真实 HTTP 入口校验三个路由与未知 id 的 404。

## 界面

以构建产物 + 打桩的桌面桥在浏览器中验证：

- 响应消息底部出现文件 chip，点击打开右侧侧边栏，标签可关闭，关闭最后一个文件标签后侧边栏收起；
- "本会话文件"标签列出全部产出，每行右侧有文件夹图标（悬停提示"打开文件目录"）；
- Markdown 预览与内嵌 Mermaid 思维导图渲染为图形；JSON 预览为美化后的文本；
- 点击文件夹图标调用桌面桥，传入后端返回的绝对路径；
- 设置页不再出现"工作空间"输入框。

## 未覆盖

- 真实 Electron 窗口内的系统文件管理器弹出（依赖桌面环境，本次只验证到桥接调用参数）。

## 验收回归（2026-11-09，真实应用）

失败现象复现自用户数据库：会话 `dced9e47-…` 的消息行全部 `completed`，`artifacts` 有 `redis-roadmap.md`（11 132 字节），磁盘 `sessions/<cid>/workspace/redis-roadmap.md` 存在——即后端与文件写入均正常，失败发生在桌面桥。

修正后在真实 Electron 窗口（`electron .`，通过 CDP 驱动）执行同一句输入"我准备学习 redis，但是一片茫然，先给我生成一份 roadmap"：

- 回答正常完成，无"这次回答没有完成"提示；
- 回答底部出现 `redis-roadmap.md` chip 与文件夹图标；
- 点击后右侧侧边栏打开该文件标签，Markdown 预览与内容接口读到真实文件；
- 渲染进程无 `[teachforge][stream]` 错误日志。

另验证：Main 侧 `decodeChatSseMessage` 接受真实 `artifact` 帧、拒绝畸形帧并输出 `dropped_frame`；preload 在 `sandbox: true` 下正常加载（`window.teachforge` 存在）。

测试期间新建的会话已通过正式 DELETE 接口清理，用户原会话保留。

## 界面调整（2026-11-09）

- 侧边栏宽度可拖拽（320–900 px，受窗口宽度约束），拖拽后 384 → 564 px 并写入 `localStorage`，新标签页加载时恢复；`role="separator"` 支持左右方向键。
- 响应底部改为卡片：加粗"已更改 N 个文件"、右侧"打开侧边栏"、分隔的文件行（悬停 `bg-stone-100`、下行链接样式、右侧文件夹图标）。
- 真实 Electron 窗口中该卡片从历史加载渲染正常（"已更改 1 个文件"，font-weight 600）。
