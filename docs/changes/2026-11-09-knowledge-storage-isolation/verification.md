---
status: current
layer: change
domain: documents
canonical_for:
  - knowledge-storage-isolation-verification
last_verified: 2026-11-09
version: 1.0
---

# 知识库存储目录隔离验收

## AC

| AC | 断言 | 证据 |
|---|---|---|
| AC1 新位置 | 导入后副本在 `<configDir>/knowledge/<documentId>/<name>`，`storedPath` 指向它；`.importing` 清空 | `test/knowledge-library.test.cjs` · `importing a picked file copies it into the app knowledge directory and indexes it` |
| AC2 不与 workspace 混用 | 整个用例只读 `config.toml` 的 `[workspace].path` 作为 Agent 工作区，副本断言全部落在 `configDirectory` 下 | 同上（`createServer` 同时给出 `configDirectory` 与 `workspacePath`） |
| AC3 删除 | 删资料同时清 `<configDir>/knowledge/<id>`，`fileCleanup = complete` | 同上 · `deleting a document clears every derived row, the FTS index and both file copies` |
| AC4 迁移 | 预置 `<workspace>/knowledge/legacy-document-id/legacy.md` 后启动，文件出现在 `<configDir>/knowledge/…`，`<workspace>/knowledge` 不再存在 | 同上 · `moves a legacy workspace knowledge copy out of the Agent workspace on boot` |
| AC5 默认拒绝 | 模型自行给出受保护目录内路径时，`read` 对绝对路径与 `..` 相对路径都抛边界错误 | `test/workspace-file-tools.test.cjs` · `guards a directory by default but honours an explicit user request` |
| AC6 用户点名放行 | `currentUserRequest` 为「请读一下 <绝对路径>」时同一路径可读并返回原文；「不要读 <路径>」仍拒绝 | 同上 |

## 运行

```
npm run test:knowledge-library --workspace @teachforge/backend   # 7/7
BACKEND_TEST_BUILD_DIR=.test-dist node --test test/workspace-file-tools.test.cjs  # 3/3
```

`workspace-file-tools.test.cjs` 原本写死加载 `../dist`；Windows 上 dev 后端占用 `dist` 时无法重建，故加入 `BACKEND_TEST_BUILD_DIR` 以便同一套用例跑 `.test-dist`（默认仍是 `dist`）。

## 未覆盖

- 真实安装升级：迁移在测试中验证过，但未在带真实 `~/.tech-forge/workspace/knowledge` 的机器上执行。
- `grep` 工具本身：隔离由受保护路径拒绝实现，用例只直接验证了 `read`；`grep`/`glob` 是 Pi 内置工具，未接入该策略，其默认 cwd 是 workspace，因此知识库移出 workspace 后不会被默认搜索到，但显式指定 `path` 仍可搜索——如需硬限制需另行包装 grep。
