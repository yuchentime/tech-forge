---
status: implemented
layer: change
domain: platform-packaging
created_at: 2026-11-14
landed_in: L001
---

# macOS Apple Silicon 安装包 Brief

## Problem

当前 Electron 打包配置只生成 Windows x64 NSIS。后端 staging 脚本也只保留 Windows x64 的 `better-sqlite3` 和 ONNX Runtime 文件，因此即使在 Apple Silicon 上运行 electron-builder，也不能得到可运行的 macOS 安装包。

## Decision / Scope

增加 `npm run package:mac-arm64`，在 macOS arm64 构建 DMG；staging 显式接收目标平台和架构，校验并保留 Darwin arm64 原生依赖。为复用现有产物布局，后端仍放在 `resources/backend`，桌面主进程与渲染层仍进入 `app.asar`。

## Out Of Scope

- Developer ID 签名、公证、Mac App Store 发布和官网下载发布。
- Intel Mac、Universal、Linux 或 Windows ARM64 产物。
- 桌面运行时、业务功能和应用数据目录迁移。
