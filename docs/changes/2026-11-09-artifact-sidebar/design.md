# Artifact 会话文件侧边栏 — 设计与取舍

- 日期：2026-11-09
- 状态：已实现，验证见 [verification.md](verification.md)

## 目标

让用户在对话之外直接看到"这一轮/这次会话生成了哪些文件"，不必翻历史消息或到磁盘里找；点击即可预览，Markdown、纯文本、JSON/JSONL 与思维导图（Mermaid）在同一处打开。

## 关键决定

| 议题 | 决定 | 理由 |
|---|---|---|
| 采集点 | `write`/`edit` 的 `writeFile` 成功后回调 | 工具事件里没有解析后的路径；外部授权目标与相对路径都在 operations 闭包里确定 |
| 工作目录 | 每会话 cwd = `sessions/<conversationId>/workspace` | 相对路径天然落在会话内，删除会话即删除产出；避免为"产出物该放哪"增加模型可感知的目录规则 |
| 与 attachments 同级的取舍 | 加一层 `workspace/`，而非直接用会话目录 | `write`/`grep` 的根是 cwd；直接放会话目录会让模型可覆盖 `attachments/<id>/text.md`，并把附件正文扫进上下文 |
| 路径存法 | 会话内相对路径 + `external` 绝对路径；两列均非 NULL | 配置目录可搬迁（`TEACHFORGE_CONFIG_DIR`），绝对路径会失效；SQLite 唯一索引不合并 NULL |
| 旧数据 | 不迁移 | 历史会话在旧 workspace 下的产出不再进入应用视野，与新语义一致 |
| 工作区设置 | 设置页移除该输入框，后端字段可选、缺省保留原值 | Agent 不再使用全局 workspace；把已无作用的设置留在界面上会误导 |
| 实时 vs 历史 | 实时由 SSE `artifact` 事件驱动；历史由 assistant DTO 的 `generatedFiles` | 前端拿不到本轮 DB userMessageId（新消息 id 由渲染层生成），无法按 id 反查 |
| 缺失文件 | 保留行、点击弹 toast，不删除索引 | 文件可能被用户移动；索引删除会让"这个会话产出了什么"变得不可知 |
| 外部目标 | 沿用既有"当轮消息中出现绝对路径"的授权模型 | 授权是安全边界，不因预览需求放宽 |

## 数据

`artifacts` 表被重建（旧表从未写入）：

`id`、`conversationId`、`userMessageId`、`pathKind('session'|'external')`、`relativePath`、`absolutePath`、`fileName`、`contentFormat`、`mimeType`、`byteSize`、`fileHash`、`createdAt`、`updatedAt`；唯一键 `(conversationId, pathKind, relativePath, absolutePath)`。

## 传输

- SSE 新增 `{ type: 'artifact', artifact: {...} }`，在本轮 Pi 运行结束后逐条发出；桌面桥的严格校验同步接受该形态。
- 历史消息 DTO 的 assistant 行新增 `generatedFiles`；后端用"下一条 user 消息的 sequenceNo 为右边界"定位该轮最后一条 assistant，页内找不到则跳过（翻页后自然显示）。

## 已知限制

- 每条用户消息只能出现一个绝对路径，否则外部写入授权整体失效（既有实现）。
- 单轮内跨页的最后一条 assistant 不在当前页时不显示底部文件列表。
- Mermaid 为按需加载的独立 chunk；语法错误时回退为源码。

## 验收失败与修正（2026-11-09）

现象：真实应用里模型写出了 `redis-roadmap.md`（`sessions/<cid>/workspace/` 有文件，`artifacts` 有行，消息行全部 `completed`），但界面显示"这次回答没有完成，请检查模型配置或网络后重试"，且没有文件列表。

根因：`electron/preload/preload.ts` 里有一份**独立的**事件校验器副本（因为 preload 运行在 `sandbox: true`，不能 require 本地模块），只加了 `artifact` 事件的另一端（`src/types/chat-stream-event.ts` 与 main 侧的 `stream-protocol.ts`），preload 副本没有。端口收到 `artifact` 帧后判定非法 → 立即发 `error` 事件并关闭端口 → `done` 永远到不了渲染层 → assistant-ui 把消息标记为未完成，同时 artifact 从未进入前端状态。

修正：preload 不再复制事件契约，只做"对象且带字符串 type"的形状检查；**Main 是唯一校验边界**（`decodeChatSseMessage` 使用共享校验器）。任何一侧新增事件类型只需改 `src/types/chat-stream-event.ts` 一处。

顺带补的日志（此前这三处全静默）：

| 位置 | 新增日志 |
|---|---|
| Main `stream-protocol.ts` | `[teachforge][stream] dropped_frame`（`invalid_json` / `validator_rejected` + 键名） |
| preload | `[teachforge][stream] invalid_event`（type + keys） |
| 渲染 `agent-chat-adapter.ts` | `[teachforge][stream] ended_without_terminal` |
| 后端 `chat.service.ts` | `chat.artifacts.emitted`（数量、id、格式、缺失数） |
