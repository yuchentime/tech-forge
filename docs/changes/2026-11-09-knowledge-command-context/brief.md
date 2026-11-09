---
status: current
layer: change
domain: knowledge-retrieval
created_at: 2026-11-09
---

# `/知识库` 斜杠触发与整篇文档注入 Brief

## Problem

检索能力已可用，但消费侧没有结论：

- 检索曾以 `search_documents` 工具暴露给模型，"模型是否主动调用"始终未验证，且不调用时用户看不出资料未被查阅，滥调时每轮白付延迟与 token。
- 注入单位是 500-token 分片，模型看不到论证上下文，也缺乏"继续读下一篇"的入口（选择天花板）。
- 会话资料范围（`conversation_documents` + `isShared`）只存在于设计文档，代码里 `conversation_documents` 从未被写入或读取，`messages.contextRefsJson` 永远写 `null`。

## Decision / Scope

1. 触发权归用户：`POST /api/chat/stream` 的 `prompt` 以 `/查询资料库 `（旧别名 `/查询知识库 `、`/知识库 `）开头时，本轮固定检索一次；否则完全不检索。命令从用户消息与模型输入中剥掉。桌面端输入 `/` 弹出「查询资料库」菜单（浮层，不改变输入框高度）；回车/点击后命令变成输入区内的标签，草稿只留问题，发送时由适配器拼回 `/查询资料库 `。知识库说明只出现在输入框占位符。
2. 删除检索工具：`llm/tools/document-search-tool.ts`、`LlmService` 中的注册与 `RetrievalModule` 依赖、`test/document-search-tool.test.cjs` 一并删除。演练/落差检测等后端流程直接调用 `RetrievalService`，不需要工具。
3. 注入单位是**分片**（2026-11-09 修订）：整篇文档方案因性能与窗口代价被否决。一次检索取 24 个候选，重排后注入前 `KNOWLEDGE_CHUNK_LIMIT = 8` 个分片，每片带资料名、章节与页码。
4. ~~预算 16000 / 单篇 8000 / 3 篇~~：随整篇方案一并删除。当前成本约为 8 × 500 = 4k tokens 上限。
5. 范围归数据：`conversation_documents` ∪ `isShared`，皆空时回退全部资料。
6. 去重持久化：注入的 `documentId@documentVersionId` 写入该轮 user 行的 `messages.contextRefsJson`；下一轮从历史反推，进程重启不失效。
7. 查询扩展在注入路径关闭（`expand: false`），省掉 800 ms 模型往返。
8. 重排：`LlmChunkReranker` 用本机 Provider 对 24 个候选排序，超时 1500 ms；失败或无 Key 时保留 RRF 顺序。

## Out Of Scope

- ~~`conversations.metadata_json`~~：已实现（migration `1793970000000`），随「资料范围」选择器一起落地：`GET/PUT /api/conversations/:id/knowledge-scope`，显式选择覆盖默认范围。
- 章节级装载（超预算时按 `headingPath` 展开命中章节）与文档选择 rerank：先积累失败样本。
- 输入框斜杠补全、未查阅资料的界面标记、引用展示。
- ~~`.md` 解析产物落盘~~：已于同日完成（`DocumentsService.writeConvertedMarkdown`）。注入仍以 `document_chunks` 为唯一正文来源；落地文件是同一拼装规则的派生物，测试断言两者逐字相等。

## Acceptance 概要

- 有/无命令两条路径行为确定，命令文本不出现在入库消息与模型输入里。
- 同会话第二轮相同分片不重复注入，且重启后仍然成立。
- 注入 ≤ 8 个分片，每片带资料名、章节与页码；分片 id 都能在索引里查到。
- 重排改变注入顺序，重排失败时退回 RRF 顺序。
- 空库、无命中、已加载三种降级都有明确通知文案，不让模型假装查过。

## 验证

见 [verification.md](verification.md)。
