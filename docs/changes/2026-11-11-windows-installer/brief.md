---
status: current
layer: change
domain: windows-installer
created_at: 2026-11-11
---

# Windows 安装包 Brief

## Problem

仓库只有开发态启动链路（`npm run dev` / `npm run start:desktop`），没有任何打包配置：根 `package.json` 没有打包脚本，`apps/desktop` 没有 electron-builder 依赖或配置。`apps/desktop/electron/main/main.ts` 已经按打包布局写好分支（`app.isPackaged` 时用 `utilityProcess.fork` 启动 `process.resourcesPath/backend/main.js`，并把 `NODE_PATH` 指向 `app.getAppPath()/node_modules`），但没有任何构建步骤产出这份布局，因此无法在未安装 Node.js 的 Windows 机器上运行。

## Decision / Scope

1. 用 electron-builder 26 生成 Windows x64 NSIS 安装包；配置放在根 `electron-builder.yml`，脚本为根 `package:win`。
2. 打包根 `app` 目录，`app.asar` 内只含桌面主进程产物（`apps/desktop/dist-electron`）、渲染层产物（`apps/desktop/dist`）与公共图标（`apps/desktop/public`）；生产依赖由 electron-builder 按 npm workspaces 的生产依赖图收集。
3. 后端不进 asar：`apps/backend/dist` 复制到 `resources/backend`，`apps/backend/assets` 复制到 `resources/assets`，与后端源码里的 `__dirname/../../assets` 解析保持一致。
4. 后端依赖全部是 N-API 预编译产物（`better-sqlite3` 13 的 `prebuilds/win32-x64.node`、`onnxruntime-node` 的 napi binding），因此设置 `npmRebuild: false`，不要求 C++ 工具链；`asarUnpack` 显式解包这些含原生模块的包。
5. 打包态的 `NODE_PATH` 同时指向 `app.asar/node_modules` 与 `app.asar/apps/backend/node_modules`，覆盖工作区提升与后端本地安装两种位置。
6. 桌面主进程与 Dock/窗口图标路径改为相对 `__dirname`（`../../../public`），因为打包后 `app.getAppPath()` 变成仓库根，不再是 `apps/desktop`。
7. 渲染层依赖（react、mermaid 等）由 Vite 打包，改为 `apps/desktop` 的 `devDependencies`，避免在安装包里重复携带一份未使用的副本。
8. 安装包图标由 `build/icon.png`（256×256）提供，electron-builder 自动转成 `icon.ico`。
9. 打包态 `utilityProcess.fork` 显式设置 `cwd` 为后端目录：TypeORM 的 migration glob 按进程 cwd 解析，安装盘与启动目录不同盘时会把路径解析成 `E:\C:\...`，后端会一直重试连接数据库直到启动超时。

## Out Of Scope

- 代码签名、公证、自动更新、崩溃上报；
- arm64 / ia32 目标、portable 与 MSI 目标；
- 降低安装包体积（例如把后端依赖也打进 asar 之外的精简副本）；
- 首次启动引导页、安装后集成（文件关联、开机自启）。

## Acceptance 概要

- `npm run package:win` 在干净构建后产出 `release/TeachForge-0.1.0-setup.exe`，并同时产出 `release/win-unpacked/`。
- `release/win-unpacked/TeachForge.exe` 在未安装 Node.js 的机器上能启动：Electron 窗口出现，内嵌后端通过 `utilityProcess` 启动并打印 ready，SQLite 数据库与 migration 正常工作。
- 安装器为 per-user 安装，可选择安装目录，创建桌面与开始菜单快捷方式，并有卸载项。
- 安装包内 `resources/backend/main.js`、`resources/assets/models/bge-small-zh-v1.5` 存在。

## 验证

见 [verification.md](verification.md)。
