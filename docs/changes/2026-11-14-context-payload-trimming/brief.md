---
status: implemented
layer: change
domain: context-payload-trimming
canonical_for:
  - context-payload-trimming-brief
created_at: 2026-11-14
related:
  - docs/changes/2026-11-14-context-payload-trimming/design.md
  - docs/current/platform/agent-runtime.md
  - docs/current/domains/artifacts/index.md
---

# 上下文载荷裁剪（落盘后不再重放文件正文）— 简报

- 日期：2026-11-14
- 状态：**已实施（v1 简化版）**，验收命令 `npm run test:image-context` + `BACKEND_TEST_BUILD_DIR=.test-dist node --test test/workspace-file-tools.test.cjs`
- 关联：[设计](design.md)

## 起点

用户在生成 SVG 时观察到：模型先把整段 SVG 写成 `write` 的入参，文件落盘后这段正文仍留在会话上下文里。由此提出的原方案是——本轮任务完成后，把该 `write` 工具的 **result** 换成 `<status>文件已写入本地，从上下文中清除该结果</status>`。

## 结论：替换 result 无收益，要裁的是入参和读取结果

| 项目 | 实测 | 结论 |
|---|---|---|
| `write` 的 result | `Successfully wrote to <abs path>`，约 120 B（SDK `core/tools/write.js` + 快照原文） | 替换它省不下什么，而且它是模型确认落盘路径的唯一信号 |
| SVG 正文所在位置 | `assistant.toolCall.arguments.content`（快照里 13.9 KB） | 真正的常驻载荷 |
| `read` 回来的整份文件/图片 | 单个会话 156.9 KB 文本 + 185.9 KB base64 图片 | 比 write 入参更大的来源 |
| `edit` 结果的 diff | 存在 `message.details`，单条 2.4–10.8 KB，一个会话累计 56.7 KB | 从不进模型 prompt，纯死重 |

## 硬约束：图片不进入上下文

用户确认的边界：**图片不能被直接读进上下文**，既不合适，也污染上下文。此前一度按"只能经一次 API 调用交给 AI 识别"设计，后经确认该路太复杂，v1 直接封堵入口、不提供识图通道。

据此，当前 `read` 工具对图片返回 `image` 块的行为本身就是违例（`2b79bc9f` 里一条 `read` 返回了 185,808 字符 base64）。v1 只做封堵：`read` 永不返回图片块，遇到图片返回一行"存在但无法加载"的说明。**不做**"读图 → 调视觉 API → 回描述"，那条路要引入嵌套模型调用与 chat-only 开关，而当前产品不需要 Agent 看图。用户主动上传的附件图走 `LlmInputImage` 注入当轮请求、快照保存时由 `replaceContent()` 丢弃图片块，属于允许路径，保持不变。

## 目标

1. **图片类产物落盘后不再逐轮重放正文**：`.svg`/`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp`/`.avif` 的 `write` 正文在保存快照时换成占位串。
2. **模型仍能定位文件**：占位串保留 `path` 与字节数，并显式告诉模型"要看就 `read`"。
3. **不丢唯一副本**：文件已不存在或不在会话工作区内时保留原文。
4. **UI 转录零变化**：侧边栏、响应底部文件卡片、工具活动行都不读快照，不受影响。
5. **图片永不进上下文**：`read` 遇到图片不返回 `image` 块，只回一行"文件存在但无法加载"的说明；不发起任何视觉调用。
6. **不引入视觉通道**：不做"读图 → 调 API → 回描述"。需要把图片给模型时，用户以附件形式带入那一轮。

v1 明确不做的：`read`/`grep` 文本结果裁剪、`edit` 入参裁剪、`edit` 结果 `details` 清理、哈希校验（见 [design.md](design.md) §3.2 与 §4）。

## 非目标

- 不改 artifact 的语义、接口、侧边栏与预览。
- 不裁剪历史 thinking、assistant 正文、`write`/`edit` 的结果（见 [design.md](design.md)「未采纳方案」）。
- 不新增表、不新增服务、不改 Pi SDK、不改模型或 provider 配置。
- 不改"用户主动上传附图"的当轮视觉注入语义：那条路径已由 `replaceContent()` 在保存快照时丢弃图片块。
- 不以 compaction 替代：compaction 阈值在 `deepseek-flash` 上是 983k token，实际不会触发，且它是有损摘要而非定向裁剪。

## 范围

| 层 | 位置 |
|---|---|
| 裁剪纯函数（新增） | `apps/backend/src/llm/snapshot-image-prune.ts`（`pruneImageWritePayloads`） |
| 读工具禁止返回图片 | `apps/backend/src/llm/tools/workspace-file-tools.ts`（`detectImageMimeType` 只校验不返回、`readFile` 嗅探后回说明、`read` 描述覆盖） |
| 调用点 | `apps/backend/src/llm/agents/CommonAgent.ts`：`saveConversationSnapshot()`（`isPrunableSessionFile` 守卫） |
| 回归测试（新增） | `apps/backend/test/snapshot-image-prune.test.cjs`（脚本 `test:image-context`）+ `test/workspace-file-tools.test.cjs` 新增 2 例 |
| 文档 | `docs/current/platform/agent-runtime.md`、`docs/current/domains/artifacts/index.md` |
