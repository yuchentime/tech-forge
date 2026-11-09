---
status: verified
layer: change
domain: documents
created_at: 2026-11-08
verified_at: 2026-11-08
---

# 知识库管理 Verification

## 1. 后端集成测试（真实 HTTP + 真实 SQLite 迁移 + 真实文件系统）

`npm run test:knowledge-library --workspace @teachforge/backend` → **6/6 通过**。

| 用例 | 覆盖点 | 结果 |
|---|---|---|
| importing a picked file… | `config.toml` 的 `[workspace].path` 生效；workspace 副本 + 存储副本都存在；`isShared=1`；`latest.byteSize/createdAt`；FTS 可命中 | ✅ |
| importing the same bytes again… | 重复导入返回 `duplicate: true`、`workspacePath: null`，行数不变、暂存目录清空 | ✅ |
| importing rejects unsupported types… | `.xlsx` 400 `UNSUPPORTED_FILE_TYPE`（中文文案）；相对路径 400；缺失文件 400 `SOURCE_UNREADABLE` 且 `message` 不含 `ENOENT`（技术原因只在 `detail`）；多余字段 400 | ✅ |
| a PDF without a text layer… | 422 `NO_TEXT_LAYER`，`message` 为中文可执行文案、`detail` 保留技术码；版本 `failed`；无分片；**再次导入同样字节返回 200 `duplicate: true` + `status: 'failed'`** | ✅ |
| deleting a document… | 六张表归零、`chunk_fts MATCH` 归零、两份文件删除、`fileCleanup: 'complete'`、二次删除 404、非法 id 404 | ✅ |
| deleting a document that is still processing… | 409 `DOCUMENT_PROCESSING`，行与文件保留 | ✅ |

回归（全部通过）：`test:document-ingest` 11/11、`test:retrieval` 11/11、`test:document-tool` 5/5。

## 2. 构建

- `npm run build`（backend + electron + renderer）通过。

## 3. 真实 Electron 应用（隔离数据目录，CDP 驱动）

| 场景 | 观察 |
|---|---|
| 侧栏 | "新建课题"下方"知识库"，`aria-pressed` 随视图切换；对话/设置/知识库三态互切正常 |
| 文件选择器 | 点击"导入资料"打开系统对话框并成功导入过真实 PDF（1.7 MB / 29 段） |
| 列表文案 | 行内显示 `1 段 · 83 B · 11/8 23:09` 与"可以搜索"，无"分片/向量/索引"字样 |
| 失败尝试 | 无文字层 PDF 在列表中显示"导入失败"行，可删除；删除后回到空状态 |
| 阻断错误渲染 | 打开删除确认后由外部删除该资料，再确认 → 红色提示条"没有找到这份资料，它可能已经被删除。" |
| 非阻断失败渲染 | 独占句柄锁住 workspace 副本后再删除 → 行已消失、列表清空，同时出现黄色提示"资料已删除，但有一个文件没能删掉，可以到工作空间里手动删除。" |
| 接口文案 | `UNSUPPORTED_FILE_TYPE` / `NO_TEXT_LAYER` / `SOURCE_UNREADABLE` 均返回中文 `message`，技术原因只在 `detail`，日志另有 `documents.import.*` / `documents.file.cleanup_failed` 记录 |

## 4. 未覆盖与已知限制

- **导入反馈面板的文案未在自动化中渲染**：`contextBridge` 暴露的 `window.teachforge` 既不可写也不可配置，Playwright 无法替换 `pickImportFiles`，而原生文件对话框也不可脚本化。因此导入按钮只能验证到"打开对话框并真实导入"，面板里的成功/失败文案由同一套 `describeFailure` / `getWarningCopy` 映射保证，且已由接口断言覆盖。
- 与 Agent 的联调（导入后由模型调用 `search_documents`）：需要已配置的模型 Key，本次未执行。
- 大 PDF（300+ 页，~40 s）在真实 UI 中的耗时可观测性：同步请求 + 1.5 s 列表轮询。
