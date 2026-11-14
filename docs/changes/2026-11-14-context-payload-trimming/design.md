---
status: implemented
layer: change
domain: context-payload-trimming
canonical_for:
  - context-payload-trimming-design
created_at: 2026-11-14
related:
  - docs/changes/2026-11-14-context-payload-trimming/brief.md
  - docs/current/platform/agent-runtime.md
  - docs/current/domains/artifacts/index.md
  - docs/current/domains/conversations/backend-behavior.md
---

# 上下文载荷裁剪（落盘后不再重放文件正文）— 设计

- 日期：2026-11-14
- 状态：**已实施（v1 简化版）**。范围收敛为：图片类产物的 `write` 正文在保存快照时换成占位串；`read` 遇到图片只回一行"存在但无法加载"的说明，**不提供视觉通道**（曾设计后按复杂度否决，见 §4）。`read` 文本裁剪、`edit` 入参、哈希守卫留到下一版。
- 关联：[简报](brief.md)

## 1. 问题

会话上下文里常驻的"文件正文"有三处来源，只有第一处是用户肉眼能看到的：

| 来源 | 数据结构 | 为什么留在上下文里 |
|---|---|---|
| 模型写文件 | `assistant.toolCall.arguments.content` | 模型自己产出的入参，随快照落库并逐轮重放 |
| 模型读文件 | `toolResult` 的 text 块 | `read` 返回整份文件文本 |
| 模型看图 | `toolResult` 的 image 块（base64） | `read` 一个 SVG/PNG 时返回图片内容 |

第三行不是"用量可以优化"的问题，而是违反硬约束：图片不允许进入上下文，唯一允许的路径是一次独立的视觉 API 调用（见 §3.0）。这一条决定了本变更不只是事后裁剪，还必须改 `read` 工具本身。

实测（本机 `~/.tech-forge/db/teachforge.db` 的 `pi_session_snapshots`，2026-11-14 取样）：

| 会话 | 快照全文 | `toolCall` 入参 | `toolResult` 文本 | `toolResult` 图片 | thinking | assistant 正文 |
|---|---|---|---|---|---|---|
| `3b0dba0e`（两张 SVG） | 51.7 KB | **13.9 KB**（全是 `write`） | 1.6 KB | 0 | 21.0 KB | 0.9 KB |
| `b183c84b`（最长对话） | 543.6 KB | 74.1 KB（`write` 40.6 + `edit` 30.3） | **156.9 KB** | 0 | 127.6 KB | 70.2 KB |
| `2b79bc9f`（图文件对话） | 426.1 KB | 38.7 KB | 86.2 KB | **185.9 KB（占 44%）** | 60.7 KB | 11.2 KB |

`b183c84b` 最后一轮的真实 usage：`input 144 + cacheRead 130_816`，`output 1_994`，`reasoning 1_040`，`totalTokens 132_954`。也就是说这条对话每发一次请求就重放约 13 万 prompt token，其中上表后三列的"文件正文"占了主要部分。

那张 156.9 KB 的 `toolResult` 文本并不都该裁：按工具名拆开是 `web_fetch` 110.6 KB + `web_search` 17.4 KB + `read` 30.0 KB + `edit` 15.0 KB + 其余 0.6 KB。前两者没有磁盘副本，不在裁剪范围（拆解见 1.2）。

用户最初提出的"把 tool result 换成 `<status>文件已写入本地…</status>`" 解决不了问题：`write` 的 result 就是一行 `Successfully wrote to <abs path>`（约 120 B，`dist/core/tools/write.js` 与快照原文一致）。SVG 正文不在 result 里，在入参里。

为什么现在不会自己瘦下来：

| 机制 | 现状 | 后果 |
|---|---|---|
| compaction | `deepseek-flash` 上下文 1,000,000 token，默认 `reserveTokens 16_384` → 触发阈值 ≈ 983,616 | 这条对话（约 131k）离触发还差 7 倍，安全阀形同不存在 |
| 快照清洗 | `replaceInjectedUserText()` 只清 user 消息里注入的附件/知识块 | 只处理 user 侧，不碰 toolCall 与 toolResult |
| `checkSessionEntries()` | 只修剪"半配对"的 toolCall/toolResult 链 | 不因体积裁剪 |

### 1.1 示例：同一段会话的消息列表，裁剪前后

真实快照 `3b0dba0e`（"讲状态机、顺手出两张图"那一轮），共 10 条 entry。裁剪发生在**下一轮开始前**——这一轮自己仍算当前轮，不会被裁——所以下面把整轮当作"历史轮"来看：

| # | entry | 内容 | 裁剪前 | 裁剪后 |
|---|---|---|---|---|
| 0 | `model_change` | Pi 元数据 | 154 B | 154 B |
| 1 | `thinking_level_change` | Pi 元数据 | 140 B | 140 B |
| 2 | `message/system` | 系统提示 | 11,251 B | 11,251 B |
| 3 | `message/user` | "讲一下状态机…"（14 字） | 216 B | 216 B |
| 4 | `message/assistant` | thinking 18,646 字 + `toolCall(read)` + `toolCall(ls)` | 20,351 B | 20,351 B |
| 5 | `message/toolResult` | `read` 回的资料目录（1,320 字） | 1,664 B | 1,664 B |
| 6 | `message/toolResult` | `ls` → `(empty directory)` | 328 B | 328 B |
| 7 | `message/assistant` | thinking 131 字 + **`toolCall(write)` 里的整段 SVG（13,629 B）** | **14,729 B** | **1,295 B** |
| 8 | `message/toolResult` | `write` → `Successfully wrote to …` | 467 B | 467 B |
| 9 | `message/assistant` | 收尾正文 857 字 | 3,012 B | 3,012 B |
| | **合计** | | **52,332 B** | **38,898 B（−25.7%）** |

（合计是整行 JSON 序列化后的长度，比逐条相加多 20 B 的数组包装；裁剪只发生一次，两条对应的正是同一个数组。）

只有第 7 条变了，其余 9 条逐字节相同。改的也只是那个字符串：

```jsonc
// 裁剪前（第 7 条里的 toolCall，共 13,877 B）
{ "type": "toolCall", "id": "call_…", "name": "write",
  "arguments": { "path": "…/workspace/state-machine-core-principles.svg",
                 "content": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1600\" …>…12,156 字符…</svg>" } }

// 裁剪后（共 1,295 B 的 entry；占位串 193 B）
{ "type": "toolCall", "id": "call_…", "name": "write",
  "arguments": { "path": "…/workspace/state-machine-core-principles.svg",
                 "content": "[content omitted: 13629 B, sha256:4c012f7b; read …\\state-machine-core-principles.svg to see it]" } }
```

`path` 原样保留，模型下一轮照样能说"我写了哪个文件"；要看内容就读回来。`sha256:4c012f7b` 是落盘文件的真实哈希前缀，也是这条 stub 的守卫凭证。

### 1.2 另外三类载荷的真实裁剪量

同一批快照里量出来的单条样本：

| 载荷 | 来源会话 | 裁剪前 | 裁剪后 | 说明 |
|---|---|---|---|---|
| `read` 回一张 PNG | `2b79bc9f` 一条 `toolResult` | 186,205 B（base64 185,808 字符） | 341 B | 图片已展示给用户，模型要再看就再 `read` |
| `read` 回一篇长文 | `2b79bc9f` 一条 `toolResult` | 23,029 B（50,328 B 文本） | 435 B | 文件在磁盘上，可重读 |
| `write` 的入参 | `3b0dba0e` 一条 `toolCall` | 13,877 B | 1,295 B 的 entry（stub 193 B） | 见 1.1 |
| `edit` 结果的 diff | `b183c84b` 一条 `toolResult` | 10,831 B（`content` 74 + `details` 10,758） | 87 B | `details` 是 diff 渲染元数据 |

最后一行值得单独说明：`edit` 的 `content` 只有一句 `Successfully replaced 1 block(s) in …`，真正的 diff 存在 `message.details` 里；而 DeepSeek 走的 openai-completions 序列化只读 `content`（`dist/api/openai-completions.js` 的 `toolResult` 分支），`details` 从头到尾没进过模型 prompt。它在快照里是纯死重，`b183c84b` 这一条会话里累计 56,733 B。

按工具名拆开 `b183c84b` 的 toolResult 文本，才能看出该裁谁：

| 工具 | 文本体量 | 是否在裁剪范围 |
|---|---|---|
| `web_fetch` | 110,612 B | 否：没有磁盘副本可比对，且是回答引用的证据 |
| `read` | 30,052 B | 是（>1 KB 的部分） |
| `web_search` | 17,373 B | 否（同 `web_fetch`） |
| `edit` | 15,022 B | 内容是成功行；`details` 里的 diff 丢弃 |
| `write` | 512 B | 结果本来就小，只有入参要裁 |

## 2. 后端现状：这条链路长什么样

### 2.1 快照是"下一轮的模型上下文"

```
chat.service
  └─ llm.stream()                        ← 一轮请求
       ├─ CommonAgent.createSession()
       │    ├─ restoreEntries()          ← 读快照 → checkSessionEntries() → 必要时先落库修复
       │    └─ sdk.createAgentSession({ cwd, sessionManager, customTools })
       └─ 回合结束
            └─ CommonAgent.saveConversationSnapshot()
                 ├─ replaceInjectedUserText(getEntries(), prompt, userTextById)
                 └─ PiSessionSnapshotsService.saveSnapshot(conversationId, entries)
```

- 存储：`pi_session_snapshots(conversation_id TEXT PRIMARY KEY, entries_json TEXT)`；每个会话一行，整行覆盖写。
- 消费者：只有 `CommonAgent`。桌面端转录读的是 `messages` 表与 `generatedFiles`（`conversations.service.ts:371`、`artifact-store.ts`），**不读快照**。因此修剪快照不会影响任何已显示的内容。
- 恢复：`restoreEntries()` 走 `pickSessionEntries(rebuilt, snapshot)`，用 SQLite 历史重建的 entries 与快照比较后取新者；`checkSessionEntries()` 负责让 toolCall/toolResult 成对，落库前会把修复结果存回。

### 2.2 快照里到底有什么

`SessionEntry` 是 `type: 'message'`（`role: user | assistant | toolResult | system`）加少量 Pi 元数据 entry。本轮相关的是两类：

| 角色 | 关键字段 | 本轮要处理的部分 |
|---|---|---|
| `assistant` | `content: [{type:'text'} \| {type:'thinking'} \| {type:'toolCall', name, arguments}]` | `toolCall.arguments.content`（write）、`toolCall.arguments.edits[].oldText/newText`（edit） |
| `toolResult` | `toolCallId, toolName, content: [{type:'text'} \| {type:'image'}], details` | 大于阈值的 text 块、image 块、`edit` 的 `details`（diff） |

工具入参 schema 来自 SDK：`write = {path, content}`，`edit = {path, edits: [{oldText, newText}]}`（`dist/core/tools/edit.js`、`write.js`）。

### 2.3 已有的可复用底座

| 能力 | 位置 | 本轮复用方式 |
|---|---|---|
| 快照重写且保持 id/parentId 不变 | `llm/session-entries.ts`（`replaceInjectedUserText` 已证明该形状可行） | 新增同形状纯函数 |
| 文件事实（`byteSize`、`fileHash`，≤2 MiB 才算哈希） | `artifacts/artifacts.service.ts:292 readFileInfo` + `artifacts` 表列 | 抽成共享模块，裁剪与登记同源 |
| 会话工作区边界判断 | `SettingsService.getSessionWorkspaceDirectory()` + `isPathWithin` | 用于"外部路径不裁剪" |

## 3. 解决方案

### 3.0 硬约束：图片不进入上下文

**规则**：任何把图片字节放进 `user` 消息或 `toolResult` 的行为都不允许。图片只能交给一次独立的视觉 API 调用，只有它返回的**文字**可以进入对话。这不是"尽量少用"，是禁止项。

| 现状 | 是否合规 | 依据 |
|---|---|---|
| `read` 一个 PNG → `toolResult` 里带 `image` 块 | **违例** | `workspace-file-tools.ts:223 detectImageMimeType` → Pi 的 `read` 分支返回 image 块；`2b79bc9f` 里一条 `read` 就带了 185,808 字符 base64 |
| 用户上传附图 → 当轮 `LlmInputImage` 注入 | 合规 | 一次 API 调用的输入；`replaceInjectedUserText()` → `replaceContent()` 在保存快照时把内容替换成纯文本，图片块不落库（`session-entries.ts:219`） |
| `read` 一个 SVG 文件 | 合规（文本） | SVG 是文本，按文本返回；只有渲染成位图才涉及视觉 |

因此 v1 只做一件半事：

1. **源头禁止**：`read` 永不返回 `image` 块。给 Pi 的 `read` 提供自定义 `readOperations`：`detectImageMimeType` 仍做路径解析与策略校验，但**从不把 mime 交回 Pi**；`readFile` 自己嗅探类型，命中图片时返回一行说明文本，于是 Pi 走文本分支，结果里没有 base64。
2. **不设视觉通道**：不做"读图 → 调视觉 API → 回描述"那条路。判据是复杂度：它要新增一次嵌套 `generate()` 调用、一个只在聊天轮生效的开关、一套失败降级与独立日志，而当前产品根本不需要 Agent 看图片（产物是 SVG 文本，用户要看图用侧边栏预览）。需要看图时用户以附件形式带进来（见 §3.0 表第二行）。

### 3.1 原则（v1）

1. **只裁图片类产物的 `write` 入参**：`.svg`/`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp`/`.avif`。文本类写作文档、`edit` 入参、`read` 的文本结果这一版都不动（§4 说明为什么先不做）。
2. **文件是唯一事实来源**：能不能裁由磁盘状态决定——路径解析后仍在会话工作区内、且文件仍存在。文件被移走或删掉时保留原文，因为那是上下文里唯一的副本。
3. **占位串必须可行动**：`[content omitted: <N> B; read <path> to view it]`，`path` 原样保留，模型据此 `read` 或触发视觉调用。
4. **只改内容，不改形状**：`id`、`parentId`、`timestamp`、entry 数量、toolCall/toolResult 配对、toolResult、assistant 正文一律不动；唯一改动是某个 `toolCall.arguments.content` 字符串。
5. **幂等**：占位串带 `[content omitted:` 前缀，重复扫描直接跳过，所以每轮保存都跑一次也不会持续改写历史。

### 3.2 裁剪规则（v1）

| 目标 | 处理 | 守卫（全部满足才裁） |
|---|---|---|
| `toolCall` name=`write`，`arguments.content`，且 `path` 扩展名属于图片类 | → `[content omitted: {bytes} B; read {path} to view it]` | 路径解析后仍在会话工作区内；文件仍存在（`statSync` 为普通文件） |
| 其余一切（`edit` 入参、`read`/`grep`/`web_*` 结果、`edit` 的 `details`、thinking、assistant 正文、`write` 的成功行） | 不动 | — |

判定与改写都在 `apps/backend/src/llm/snapshot-image-prune.ts` 的 `pruneImageWritePayloads()` 里，纯函数、可注入 `isPrunableFile`，因此测试不需要真实文件系统。

这版没有哈希校验：守卫只比对"路径仍在工作区内 + 文件存在"。代价是文件被用户原地改写后，占位串依旧成立（而原文已被丢掉）；收益是实现只有几十行，且丢掉的正文都还能用 `read` 重新拿到（SVG 是文本；位图读只会得到说明，见 §3.3）。哈希守卫留到下一版与 `read` 文本裁剪一起做。

### 3.3 图片读取：只回一条说明

Pi 的 `read` 会先问 `detectImageMimeType`，命中就自己读二进制、`processImage` 后返回 `{type:'image', data}`（`dist/core/tools/read.js`）。我们在 `workspace-file-tools.ts` 接管了 `readOperations`，于是：

| 环节 | 实现 |
|---|---|
| `detectImageMimeType` | 只调 `resolveReadableFile` 完成策略校验与日志（守卫/受保护路径照常报错），然后**永远返回 `undefined`** |
| `readFile` | 自己调 `detectSupportedImageMimeTypeFromFile` 嗅探；命中图片时返回一行 UTF-8 说明：`[image not loaded: image/png. Images are never read into the conversation.]`；其余路径照常返回文件字节 |
| 工具描述 | 覆盖 `read` 的 `description` 与 `promptGuidelines`（Pi 默认写着 "Images are sent as attachments"），明说读图片只得到"文件存在但无法加载"，不要反复重试 |

为什么不做"读图 → 调视觉 API → 回描述"：要新增一次嵌套 `generate()` 调用、一个只在聊天轮生效的开关、失败降级与独立日志，而当前产品并不需要 Agent 看图（产物是 SVG 文本，看图由用户在侧边栏预览）。需要把图片给模型时，用户以附件形式带入那一轮即可。取舍记录在 §4。

### 3.4 实现落点（已实施）

```
apps/backend/src/llm/snapshot-image-prune.ts    ← 新增，纯函数
  export function pruneImageWritePayloads(
    entries: readonly SessionEntry[],
    isPrunableFile: (writtenPath: string) => boolean,
  ): { entries: SessionEntry[]; prunedWrites: number; bytesRemoved: number }

apps/backend/src/llm/tools/workspace-file-tools.ts  ← 修改
  readOperations.detectImageMimeType              ← 只做策略校验，不返回 mime
  readOperations.readFile                         ← 自己嗅探；图片返回说明文本
  createWorkspaceFileTools 返回的 read 工具        ← 覆盖 description/promptGuidelines
  export isPathWithin                             ← 供裁剪守卫复用

apps/backend/src/llm/agents/CommonAgent.ts      ← 修改
  isPrunableSessionFile()                         ← 工作区边界 + statSync 守卫
  saveConversationSnapshot()                      ← replaceInjectedUserText 之后执行裁剪
```

唯一的裁剪调用点是保存路径：`saveConversationSnapshot()` 在 `replaceInjectedUserText()` 之后、`saveSnapshot()` 之前跑一次 `pruneImageWritePayloads()`。恢复路径不再裁剪——被裁内容已经是占位串，`restoreEntries()` 里再跑一次也只会命中幂等分支，没有收益。

`isPrunableSessionFile()` 的实现：以 `settings.getSessionWorkspaceDirectory(conversationId)` 为根，相对路径按其解析，`isPathWithin` 通过且 `statSync(..., { throwIfNoEntry: false })?.isFile()` 为真才裁。

### 3.5 可观测（已实施）

裁剪事件 `llm.session_snapshot.image_payload_pruned`（`writeStructuredEvent`，`log` 级，只在真的裁到时记录）：

```
{ conversationId, requestId, prunedWrites, bytesRemoved, …请求日志上下文 }
```

验收依据（按 1.1/1.2 的实测值折算）：`3b0dba0e` 那类"两张 SVG"的会话，从第二轮起每次请求应少 13 KB 左右；`2b79bc9f` 那类看图会话不再出现 `image` 块，一次 `read` 的 185,808 字符 base64 变成一行说明。

### 3.6 测试（已实施）

新增脚本 `npm run test:image-context`（`apps/backend/test/snapshot-image-prune.test.cjs`，默认 `.test-dist`）；图片读取用例追加在既有 `test/workspace-file-tools.test.cjs`：

| 用例 | 断言 |
|---|---|
| SVG write 正文 | 换成占位串，`path` 保留，`prunedWrites`/`bytesRemoved` 正确 |
| 形状不变 | entries 数量、`id`、`parentId`、`timestamp`、toolCall id 全部不变 |
| 文件不在磁盘 | 原文保留，`prunedWrites` 为 0 |
| 非图片写入 | 原文保留 |
| 幂等 | 第二次扫描 `prunedWrites` 为 0 且结果对象逐字相同 |
| `edit` 与非 assistant entry | 不动 |
| 逐条独立 | 混合快照只改命中的那几条 |
| `read` 一张 PNG | 结果里没有 `image` 块、没有 base64，只有 `[image not loaded: image/png. …]` 一行（长度 < 200） |
| SVG 读取 | 仍走文本分支，返回 `<svg …` 原文 |

## 4. 未采纳方案

| 方案 | 不采纳原因 |
|---|---|
| 把 `write` 的 tool result 换成 `<status>文件已写入本地…</status>`（用户原提案） | result 已只有 ~120 B，零收益；且它是模型确认落盘路径的唯一信号 |
| 依赖 compaction 兜底 | 阈值 983k token，实际对话到不了；compaction 是有损摘要，裁掉整段历史而不是定向去载荷 |
| 每请求临时裁剪、不落库 | 每轮重算且每轮都改历史，prefix cache 反复失效（实测 `cacheRead` 130k 正是靠前缀稳定） |
| 裁剪历史 thinking | 快照里 84 个 thinking 块签名全为 `reasoning_content`，Pi 会把它们写回 assistant 的 `reasoning_content` 字段；但 DeepSeek 对输入里的该字段是否计入 token 未经验证，先不动 |
| 在 prompt 里要求"别写大文件" | SVG 本身就是要产出的大文件，把约束加在提示词上等于降低产出质量 |
| 丢弃全部 `read` 结果，只保留最后一次 | 模型常靠"上一版改了什么"做增量（`edit` 的 `oldText`），保留最后一次读是合理的，但"全删"会强迫它每轮重读多个文件 |
| 把图片 base64 直接放进 `toolResult` 交给模型（当前 `read` 的行为） | 违反硬约束；一条 `read` 就把 185,808 字符 base64 写进上下文，之后每轮重放，还按 vision token 计费 |
| 只靠事后裁剪清图片、不堵源头 | 图片在被读出的那一轮就已进入上下文并计费，裁剪只能救后面的轮次；且 `imageResultsDropped` 长期不为 0 说明入口没堵住 |
| 视觉通道：`read` 一张图就调一次视觉 API、回一段描述 | 实现成本与收益不成比例：一次嵌套 `generate()`、一个 chat-only 开关、失败降级与独立日志；而且当前产品不需要 Agent 看图（产物是 SVG 文本，看图由用户预览）。v1 只封堵入口，回一句"无法加载" |
| v1 不裁 `read`/`grep` 的文本结果 | 需要体积阈值 + 哈希守卫 + "同一路径保留最后一次"三条规则，先把图片这条硬约束落地；文本裁剪留到下一版 |
| v1 不裁 `edit` 入参与 `edit` 结果的 `details` | `details` 从不进模型 prompt（openai-completions 只读 `content`），属于纯存储问题；`edit` 入参在图片场景里几乎不出现 |
| 一并裁剪 `web_fetch`/`web_search` 结果（`b183c84b` 里占 128 KB，是最大单项） | 网页正文没有磁盘副本，无法用哈希守卫证明"还能取回"；它同时是回答引用的证据，丢了模型只能瞎编来源。要裁只能按 URL 去重并保留最近一次，另立变更 |

## 5. 风险与回退

| 风险 | 影响 | 处理 |
|---|---|---|
| 模型想再改同一张图，但历史里只剩占位串 | 多一次 `read`（SVG 取回文本） | 占位串明写 `read <path> to view it`；文件本身与 `artifacts` 行都在 |
| 文件被用户原地改写，占位串仍成立（无哈希校验） | 模型看到的"已写入 N B"与当前内容不一致 | 占位串只声明"content omitted"，不断言内容；模型要精确内容必须 `read` |
| 文件被移走或删除 | 模型失去唯一副本 | 守卫要求路径仍在会话工作区内且文件存在，否则保留原文 |
| Agent 读不了任何图片 | 用户让它"看一下这张截图"时只能得到说明 | 刻意取舍：把图当附件发能看（附件图仍在允许路径上）；不为此引入视觉通道 |
| 大 SVG 仍以文本形式进上下文 | 未被本版覆盖 | 属于 v2 的 `read` 文本裁剪（已列入 §4） |

回退：把 `createWorkspaceFileTools` 里 `detectImageMimeType`/`readFile` 的图片分支还原（返回 mime 与原始字节、去掉描述覆盖），并从 `saveConversationSnapshot()` 删掉 `pruneImageWritePayloads()` 调用即可恢复旧行为。纯函数无 schema 变更；注意旧行为本身违反硬约束，只作排障用。
被裁内容无法从快照还原，但文件与 `artifacts` 索引仍在，模型可 `read` 重新拿到文本。
