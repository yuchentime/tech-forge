---
status: current
layer: change
domain: windows-installer
created_at: 2026-11-11
---

# Windows 安装包验收

## 1. 构建结果

| 编号 | 命令 | 结果 |
|---|---|---|
| B1 | `npm run build` | 通过（先删除 `KnowledgeBasePage.tsx` 中未使用的 `readyCount`，否则 `tsc --noEmit` 报 TS6133） |
| B2 | `node scripts/stage-backend.mjs` | 262 个包暂存到 `build/backend`：`dist` 1.8 MB、`assets` 24 MB、`node_modules` 626 MB |
| B3 | `npm run package:win` | 通过；产出 `release/TeachForge-0.1.0-setup.exe`（299,241,650 B，约 286 MB）、`release/win-unpacked/`、`.blockmap` |

## 2. 暂存后端独立冒烟

直接从 `build/backend/dist` 用系统 Node 启动，验证依赖闭包与资源路径：

| 检查 | 证据 |
|---|---|
| Nest 启动 | 日志出现 `Nest application successfully started` |
| 端口公告 | `TEACHFORGE_BACKEND_READY={"port":49781}` |
| 数据库与 migration | `TEACHFORGE_DATA_DIR` 下生成 `db/teachforge.db`、`-shm`、`-wal` |
| 本地嵌入模型 | 日志出现 `[MemoryService] memory.engine.ready embeddingId=local:bge-small-zh-v1.5:512`，说明 `assets/models` 与 `onnxruntime-node` 在暂存布局下可用 |

进程结束时报 `Error: kill ENOSYS`（Windows 上 Node 进程清理收到不支持的信号），不影响上述启动与查询能力。

## 3. 打包态布局

| 路径 | 事实 |
|---|---|
| `resources/app.asar` | 6.4 MB，只含 `dist`、`dist-electron`、`public`；无 `node_modules` |
| `resources/backend/dist` | 1.8 MB，入口 `main.js` 与 `database/migrations/*.js` |
| `resources/backend/assets` | 24 MB，含 `models/bge-small-zh-v1.5/onnx/model_quantized.onnx` 与 `skills/` |
| `resources/backend/node_modules` | 626 MB，204 个顶层条目；`better-sqlite3/prebuilds` 只有 `win32-x64.node`，`onnxruntime-node/bin/napi-v6` 只有 `win32` |

## 4. 打包态应用启动

`release/win-unpacked/TeachForge.exe --remote-debugging-port=9333`，`TEACHFORGE_DATA_DIR` 指向临时目录。

| 检查 | 证据 |
|---|---|
| 窗口与渲染层 | CDP 目标 `file:///…/resources/app.asar/dist/index.html`，`document.readyState=complete`，`#root` 渲染出侧栏、模式切换、输入框与发送按钮（截图已核对） |
| 后端进程 | 进程列表出现 `--type=utility --utility-sub-type=node.mojom.NodeService`，即 `utilityProcess.fork` 启动的后端 |
| 数据库 | 临时数据目录生成 `db/teachforge.db`、`-shm`、`-wal`，说明 better-sqlite3 在 Electron 的 Node 运行时下加载并跑完 migration |
| 主进程状态 | `Get-Process` 显示窗口标题 `TeachForge`、`Responding=True` |

## 5. 安装器

| 编号 | 操作 | 结果 |
|---|---|---|
| I1 | `TeachForge-0.1.0-setup.exe /S /D=<临时目录>` | 退出码 0；安装目录含 `TeachForge.exe`、`Uninstall TeachForge.exe`、`resources/{app.asar,backend}`，共 1015 MB |
| I2 | 与 `win-unpacked` 对比 | `TeachForge.exe` 与 `app.asar` 的 MD5 一致；`resources/backend` 均为 34678 个文件、682,161,552 字节 |
| I3 | 从 E: 工作目录启动安装在 C: 的 `TeachForge.exe`（跨盘，修复后） | 窗口正常渲染（CDP 目标指向 `tf-install2/resources/app.asar/dist/index.html`）；`db/` 出现 `teachforge.db`、`-shm`、`-wal`，即后端已通过 utility process 启动并完成 migration |
| I4 | `Uninstall TeachForge.exe /S` | 退出码 0；安装目录、开始菜单快捷方式与 HKCU 卸载项均已移除 |

## 6. 验收中发现并修复的问题

| 问题 | 证据 | 修复 |
|---|---|---|
| 首版 `extraResources` 合并成 `from: build/backend` 时依赖全部丢失 | `resources/backend` 只有 26 MB，缺 `node_modules` | electron-builder 的复制过滤器丢弃 `from` 根目录下名为 `node_modules` 的目录；拆成 `dist`、`assets`、`node_modules` 三条映射 |
| 安装版启动报「本地后端未能启动 / Timed out waiting for the local backend to become ready」 | 捕获主进程 stdout/stderr：`Cannot find module 'E:\C:\Users\...\migrations\1793900000000-initial-schema.js'`，TypeORM 反复 `Unable to connect to the database. Retrying` | 安装盘（C:）与启动目录（E:）不同盘时，tinyglobby 把绝对 glob 结果转成 `../../../C:/...`，TypeORM 按进程 cwd 解析成非法路径。打包态 `utilityProcess.fork` 显式设置 `cwd` 为后端目录，与开发态 `spawn` 一致 |
