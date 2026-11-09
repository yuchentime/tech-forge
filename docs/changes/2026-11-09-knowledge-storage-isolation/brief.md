---
status: current
layer: change
domain: documents
created_at: 2026-11-09
---

# 知识库存储目录隔离 Brief

## Problem

导入资料时另存的用户可见副本位于 `<workspace>/knowledge/<documentId>/`，即 Agent 的工作目录内。模型只要在 workspace 里跑一次默认 `grep`，就能读到用户上传的教材原文——而这正是知识库上下文注入刻意避免的事（`/知识库` 命令才提供正文）。

## Decision

1. 位置改为 `<configDir>/knowledge/<documentId>/`，`configDir` = `TEACHFORGE_CONFIG_DIR`（默认 `~/.tech-forge`），即用户要求的 `~/.tech-forge/knowledge`。暂存目录 `<configDir>/knowledge/.importing/<uuid>/`，删除路径同步修改。
2. 归属：`SettingsService.getKnowledgeDirectory()` 是唯一路径来源（与 config.toml / SOULS.md 同目录），`DocumentsService` 消费，不再读 `getWorkspacePath()`。
3. 真正的隔离靠默认拒绝，不只靠位置：`WorkspaceFileToolPolicy.guardedDirectories` 把知识库根交给 `workspace-file-tools.ts`，该子树**默认**拒绝读取（含绝对路径与 `..` 别名）；仅移出 cwd 只能挡住默认 `grep`，挡不住显式路径。
4. 例外归用户：当前用户请求里唯一命名该子树内路径并表达读取意图（"读/查看/打开…"）时，`deriveGuardedReadGrant` 生成一次性读取许可；否定措辞（"不要读…"）不产生许可，模型自己编出的路径永远不产生许可。这与已有的外部写授权同形（`ExternalPathGrant`）。config.toml / SOULS.md 仍是无例外的硬拒绝。
4. 旧数据迁移：`DocumentsService.onModuleInit` 在 `<configDir>/knowledge` 不存在时把 `<workspace>/knowledge` 整体 `rename` 过去；目标已存在则不动，失败只记日志（导入仍写入新位置）。
5. 契约改名：`ImportDocumentResult.workspacePath` → `storedPath`（新位置不在 workspace，旧名会撒谎）。

## Out Of Scope

- `<dataDir>/documents/<id>/v<n>/` 入库快照位置不变（Electron 下 `dataDir` = `app.getPath('userData')`，本来就在 workspace 之外）；转换后的 `<baseName>.md` 也存放在这里，因此不在被守卫的知识库目录内——只有用户显式要求时才读得到，默认仍不会被 grep 扫到。
- 知识库目录的 UI 展示（桌面端目前不消费 `storedPath`）。
- 已存在的 `dist` 产物：`nest build` 期间被运行中的 dev 后端占用，未重建。

## 验证

见 [verification.md](verification.md)。
