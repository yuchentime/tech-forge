# Worklog: macos-arm64-package

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 增加 macOS arm64 DMG 构建并核验产物 | 增加目标平台 staging、Mac DMG 配置与 512×512 Mac 图标；同步当前打包事实文档 | 首次构建发现原图 256×256 不满足 Mac 最低尺寸；补充专用图标后构建成功，DMG checksum VALID，主程序及 SQLite/ONNX native files 均为 arm64；`git diff --check` 通过。文档检查报告 7 个其他页面错误和 48 个 warnings，本次路由未告警 | `pending review` | Finder 安装与首次启动仍需人工验收 | DMG 跳过 Developer ID 签名并关闭公证；尚未 Finder 安装并首次启动 | `not committed` | `n/a` |
