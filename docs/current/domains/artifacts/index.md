---
status: current
layer: domain
domain: artifacts
canonical_for:
  - agent-generated-file-index
related:
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/domains/conversations/index.md
  - docs/current/platform/agent-runtime.md
  - docs/changes/2026-11-09-artifact-sidebar/design.md
  - docs/changes/2026-11-09-artifact-sidebar/verification.md
last_verified: 2026-11-09
---

# Artifact 会话产出文件

Agent 在一次会话里写出的文件被登记为 `artifacts` 行，供会话内文件侧边栏和"响应消息底部文件列表"读取。侧边栏只读：不提供编辑、重命名或删除。

## 当前行为

- **工作目录即会话工作区**：每个会话的 Agent cwd 是 `<configDir>/sessions/<conversationId>/workspace`，与同级的 `attachments/` 分开；相对路径写入落在这一层，删除会话时整目录一并删除。
- **登记时机**：`write` / `edit` 工具的成功写入回调（`createWorkspaceFileTools` 的 `onFileWritten`）把已解析的绝对路径交给 `ArtifactsService.registerArtifact()`；同一路径重复写入按唯一键更新同一行，保持 `id` 稳定，因此已打开的标签页不会失效。
- **路径存储**：会话内文件存 `pathKind='session'` + 相对工作区的 POSIX 路径；两个路径列都以空串占位而不是 NULL（SQLite 唯一索引把 NULL 视为互不相等，会让重复写入插入多行）。用户明确指定绝对路径时存 `pathKind='external'` + 绝对路径，便于后续预览与会话删除时区分。
- **缺失检测**：列表与预览接口现算 `missing`；文件被移走或改名后行仍保留，点击时提示"文件不存在"。
- **预览格式**：按扩展名判定 `markdown`（含 ` ```mermaid ` 块时渲染图表）、`mermaid`、`json`（≤256 KiB 且可解析则美化）、`jsonl`、`text`；正文读取上限 512 KiB，超出返回 `truncated`。
- **元数据**：`fileName` 仅用于展示，列表不显示路径；`byteSize` 与 `fileHash`（≤2 MiB 时计算）供展示与漂移判断。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/conversations/:conversationId/artifacts` | 列表，可按 `userMessageId` 限定本轮；含 `missing`、`external` |
| GET | `/api/artifacts/:artifactId/content` | 预览正文与 `truncated` / `binary` |
| GET | `/api/artifacts/:artifactId/location` | 返回目录与文件绝对路径及存在性，供桌面桥在文件管理器中定位 |

内容与位置接口只按 `artifactId` 查表后解析路径，不接受任意路径参数；会话内路径解析后仍校验落在会话工作区内。

## 前端

- 响应消息底部以卡片列出本轮产出：标题行加粗显示"已更改 N 个文件"并提供"打开侧边栏"，下方为逐条文件行（悬停高亮、行内可点击打开预览、右侧文件夹图标定位）；历史取 `generatedFiles`，实时取 SSE `artifact` 事件。
- 侧边栏有一个不可关闭的"本会话文件"标签和若干可关闭的文件标签；关闭最后一个文件标签即收起侧边栏。
- 侧边栏左缘有拖拽手柄可横向调整宽度（320–900 px，键盘方向键同样可用），宽度记在 `localStorage`。
- 侧边栏收起、切换会话或重新加载历史时清空标签，避免跨会话残留；`generatedFiles` 与实时事件两条来源互斥。

## 未实现

- `rehearsals` 等其它导出物料的登记、artifact 版本化、跨会话文件集合。
