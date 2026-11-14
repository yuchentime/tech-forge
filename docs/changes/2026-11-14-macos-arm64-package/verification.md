---
status: implemented
layer: change
domain: platform-packaging
last_verified: 2026-11-14
version: 1.0
acceptance_review_status: approved
---

# macOS Apple Silicon 安装包 Verification

## Test Layer Taxonomy

验证分为三层：L1 局部逻辑、L2 实际打包与产物检查、L3 人工界面验收。本变更的关键交付是实际 macOS arm64 包，因此以本机 electron-builder 打包与文件架构检查作为 L2。

## Acceptance Criteria（代码级验收规则）

### AC-01 macOS arm64 包脚本

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 根 `package.json` 的 `scripts.package:mac-arm64`；`electron-builder.yml` 的 `mac.icon`、`mac.target` 与 `dmg.artifactName` |
| 前置条件 | 在 Apple Silicon macOS 上安装 workspace 依赖 |
| 预期行为 | `npm run package:mac-arm64` 完成构建后产生 `release/TeachForge-<version>-mac-arm64.dmg` 与 `release/mac-arm64/TeachForge.app` |
| 禁止出现 | 不应调用 Windows NSIS 构建目标或 Apple 公证服务 |
| 判定方式 | 执行脚本并检查 DMG、app bundle；检查 electron-builder 的目标配置、512×512 图标与 `mac.notarize: false` |

### AC-02 staging 保留目标原生依赖

| 要素 | 内容 |
| --- | --- |
| 代码位置 | `scripts/stage-backend.mjs` 中的平台目标校验与原生文件裁剪；依赖路径 `better-sqlite3/prebuilds` 和 `onnxruntime-node/bin/napi-v6` |
| 前置条件 | staging 目标为 `darwin arm64`，生产依赖包含 Darwin arm64 prebuild |
| 预期行为 | stage 保留 `better-sqlite3/prebuilds/darwin-arm64.node` 与 `onnxruntime-node/bin/napi-v6/darwin/arm64`，并裁掉其他 better-sqlite3 prebuild 与 ONNX Runtime 平台目录 |
| 禁止出现 | 目标原生文件缺失时不得静默打包或留下只含 Windows 二进制的 stage |
| 判定方式 | 检查 `build/backend/node_modules` 文件路径及原生文件架构；核对缺文件时脚本非零退出 |

### AC-03 Windows x64 打包保持

| 要素 | 内容 |
| --- | --- |
| 代码位置 | 根 `package.json` 的 `scripts.package:win`、`electron-builder.yml` 的 `win.target` 与 `scripts/stage-backend.mjs` |
| 前置条件 | Windows x64 构建主机与现有依赖 |
| 预期行为 | Windows 脚本仍调用 NSIS x64，stage 保留 `win32-x64.node` 与 ONNX Runtime `win32/x64` 内容 |
| 禁止出现 | Windows 构建不得因新增 macOS target 而改成 DMG，或删除其运行时原生依赖 |
| 判定方式 | 配置和 staging 代码走查；Windows 主机上的完整包构建属于后续平台 L2 |

## Required Automated Checks

```bash
npm run package:mac-arm64
file release/mac-arm64/TeachForge.app/Contents/MacOS/TeachForge
lipo -archs release/mac-arm64/TeachForge.app/Contents/MacOS/TeachForge
hdiutil verify release/TeachForge-1.0.0-mac-arm64.dmg
```

- [L2] `npm run package:mac-arm64`：通过；编译、依赖 staging 与 electron-builder DMG 组装完成，产出 292 MB DMG 与 app bundle。
- [L2] `file` / `lipo -archs`：通过；主程序、better-sqlite3、ONNX Runtime binding 与 `.dylib` 均为 arm64；stage 只保留目标原生依赖。
- [L2] `hdiutil verify`：通过；DMG checksum VALID。
- Windows x64 L2 包构建需 Windows 主机，本轮不在此 macOS 主机执行。

## Required Manual Checks

- [L3] 在 macOS Finder 挂载 DMG，将 TeachForge 拖入 Applications 并首次启动。
  - 原因：Finder 安装路径和 Gatekeeper 首次启动行为依赖 macOS 桌面交互。
  - 执行人：开发者。
  - 判断标准：拖拽安装成功，应用窗口可打开，backend 健康状态正常。
  - 状态：本轮未执行；当前构建无 Developer ID 签名。

## Must-Not-Break Checks

- [ ] 现有 Windows 用户仍能安装并启动 x64 NSIS 包（本轮 macOS 主机未重建 Windows 包）。
- [x] 两个平台均继续使用同一用户数据目录语义，打包不重置或迁移用户数据。
- [x] 生成 DMG 不会触发未经配置的 Apple 公证上传（`mac.notarize: false`）。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
| --- | --- | --- | --- | --- |
| macOS Apple Silicon 打包 | DMG 与 arm64 app bundle 生成 | L2 | package 脚本 + `file` / `lipo` | 覆盖实际构建链与目标架构 |
| backend 原生依赖 staging | SQLite 与 ONNX Darwin arm64 文件保留 | L2 | 检查 `.app/Contents/Resources/backend/node_modules` | 防止安装包只含桌面壳、不含可运行后端 |
| Windows x64 配置 | NSIS x64 目标与 Windows 原生依赖筛选仍存在 | L1 走查 | 配置与 staging 代码核对 | macOS 支持不能回归当前正式安装包 |
| Finder 安装和启动 | 应用可从 DMG 安装并启动 | L3 | 手工拖拽与首次启动 | 覆盖打包命令无法证明的系统 UI 路径 |

## Known Guardrails

- 不把配置存在当成包已成功；实际 DMG 和原生二进制架构检查属于必要证据。
- 不把 arm64 构建证据推广为 Intel、Universal 或 Windows ARM64 支持。
- 不将未签名、未公证包描述为可直接对外分发。

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
| --- | --- | --- |
| 只设置 `mac.target`，继续执行 Windows 原生二进制裁剪 | DMG 能生成但后端原生模块不能加载 | 根据目标平台校验并筛选原生文件 |
| 以 electron-builder 退出码为唯一验收 | 不能证明目标原生文件在 app 包中 | 对 stage 和 `.app` 中的二进制做架构检查 |
| 将无签名 DMG 当作已公证发行包 | Gatekeeper 对外部分发有签名与公证要求 | 文档标明边界，发布前单独配置 Developer ID 与公证 |

## When To Read History

- 修改 staging 或 app bundle 运行时路径时，读取 [Windows 安装包变更](../2026-11-11-windows-installer/verification.md)。

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
| --- | --- | --- |
| AC-01 | pass | `package.json`、`electron-builder.yml` 均为现有构建配置入口；命令与配置字段为本变更新增项。 |
| AC-02 | pass | `scripts/stage-backend.mjs`、`pruneOtherPlatforms()`、两项依赖路径均已核对；目标目录中存在 Darwin arm64 候选二进制。 |
| AC-03 | pass | 根 `package:win`、`win.target` 与现有 Windows 裁剪行为已核对；本机 macOS 不执行 Windows 包构建。 |

- 评审结论：AC 已协商一致
- 评审方 / 确认人 / 时间：Codex / 用户已授权实施 / 2026-11-14

## Version History

### v2.0 — <YYYY-MM-DD>

- 触发：<开发者验收反馈，问题描述>
- 改动内容：<逐条列出，注明涉及的 AC 编号：新增 / 修订 / 删除>
- 影响范围：<受影响的验证手段、Regression Matrix、Must-Not-Break>
- 处理状态：<已重新实施 / 待实施 / 已拒绝并说明理由>
