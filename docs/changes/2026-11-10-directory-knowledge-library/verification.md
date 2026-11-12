---
status: draft
layer: change
domain: directory-knowledge-library
canonical_for:
  - directory-knowledge-library-verification
last_verified: 2026-11-10
version: 1.0
acceptance_review_status: approved
---

# 目录驱动的自主资料库查阅验证

## Test Layer Taxonomy

- **L1 — Local Logic Verification**：目录条目渲染、摘要 JSON 验证、状态迁移、路径授权、原子替换失败处理。
- **L2 — Automated Real-World Verification**：真实 SQLite、文件系统、Pi Agent tool lifecycle 和真实/受控 Provider 的导入到目录到读取联动。
- **L3 — Human-Aided Verification**：资料库 UI 上传、失败重试、普通聊天自主查阅与显式命令强制查阅的可见工具活动和答案依据。

## Acceptance Criteria（代码级验收规则）

### AC-01 精确创建并加载 AGENTS

| 要素 | 内容 |
|---|---|
| 代码位置 | `SettingsService.initializeFiles()`、`SettingsService.getManagedFilePaths()`、`LlmService.createSession()` 的 `DefaultResourceLoader` 配置 |
| 前置条件 | 新的或已有的 `TEACHFORGE_CONFIG_DIR`；已有 `AGENTS.md` 可含用户编辑内容 |
| 预期行为 | 缺失时以 0600 和 `wx` 创建 `<configDir>/AGENTS.md`；存在时不覆盖；loader 保持 `noContextFiles: true`，仅以 `agentsFilesOverride` 加载此精确路径 |
| 禁止出现 | 不能发现 workspace/父目录任意 AGENTS；不能将 `index.md` 内容装入该 context file；普通 Agent tool 不可读写 AGENTS |
| 判定方式 | L1 临时 config root 文件断言 + loader resource 断言 |

### AC-02 导入生成且校验结构化摘要

| 要素 | 内容 |
|---|---|
| 代码位置 | `DocumentsService.importFromPath()`、`DocumentCatalogService`、`DocumentVersionEntity` |
| 前置条件 | 支持格式的文件已成功解析；摘要 Provider 返回合法或非法 JSON |
| 预期行为 | 合法摘要的 `summary` 至多 200 Unicode 字符、关键词 3–8 个并写入该版本；处理状态走 `parsing → cataloging → ready` |
| 禁止出现 | 不能把原文/模型自由文本直接写入目录；不能继续对新版本调用 `EmbeddingService.embed()` 或 `persistChunks()` |
| 判定方式 | L1 mock Provider 的状态/调用断言；SQLite 行断言 |

### AC-03 目录原子、一致且可恢复

| 要素 | 内容 |
|---|---|
| 代码位置 | `DocumentCatalogIndexService`、`DocumentsService.libraryQueue`、`deleteDocument()` |
| 前置条件 | 连续导入、同一 document 新版本、删除、索引写入失败和显式 rebuild |
| 预期行为 | `<configDir>/knowledge/index.md` 只含每个 document 的最新 `catalogStatus=ready` 版本；条目携带相对可读文本路径（转换 Markdown 或原生文本自身）；删除/新版本后不留旧条目；rebuild 可从数据库恢复 |
| 禁止出现 | 不得 append 出重复 id、半行 Markdown 或指向 PDF/DOCX 原件的路径 |
| 判定方式 | L1 并发序列测试、临时文件/rename 失败注入、SQLite 与文件内容对比 |

目录重建不得解析或增量修改旧 `index.md`；删除后须由 SQLite 的剩余 ready 版本完整渲染。即使本地目录清理返回 `partial`，已删除 document id 也不得出现在新 index 中。

### AC-04 摘要失败保持可诊断且可重试

| 要素 | 内容 |
|---|---|
| 代码位置 | `DocumentCatalogService`、`DocumentsController` 的 retry/rebuild 端点、资料库 read model |
| 前置条件 | Provider 缺失、超时或返回非法 JSON；已有转换 Markdown |
| 预期行为 | 版本写为 `catalogStatus=failed` 与安全错误，原始副本和转换 Markdown 保留；retry 只处理目标最新版本，rebuild 仅在用户明确操作时批量调用 Provider |
| 禁止出现 | 不能把 failed 条目伪装为 ready 或静默触发启动期全库付费摘要 |
| 判定方式 | L1 端点/服务测试；L2 临时 SQLite 重启后 retry 验证 |

### AC-05 自主与强制查阅的文件权限边界

| 要素 | 内容 |
|---|---|
| 代码位置 | `LlmService.createSession()`、`workspace-file-tools.ts`、`ChatService.stream()`、`knowledge-command.ts` |
| 前置条件 | 普通 chat stream、`/查询资料库` stream、rehearsal `generate({ tools: [] })` 和模型选择的知识根路径 |
| 预期行为 | 普通 stream 可按 AGENTS 判断后读取 index 与后端从 index 解析出的转换 Markdown 白名单；`/查询资料库` 与 `/探索主题` 把 index 和 `<agent_state>` 持久化为带 revision/hash 的 `knowledge_index` custom message；相同 revision 后续轮不重复全文，只追加短状态指针；revision 改变时 context-edit 排除旧目录并追加新目录；重复 index `read` 只返回固定状态；tool activity 被持久化/投影；演练没有这些工具 |
| 禁止出现 | 不能读写 config.toml、SOULS.md、AGENTS.md；不能写知识根；默认 grep 不能保留为绕过路径，受控 grep 不能搜索 index 或白名单外文件；不能通过符号链接/路径穿越越界；Chat、slash command、deep-research 不得调用 `KnowledgeService.buildContext()` |
| 判定方式 | L1 workspace policy 测试 + L2 agent-stream 真实 tool event 测试 |

### AC-06 旧混合检索被隔离而未删除

| 要素 | 内容 |
|---|---|
| 代码位置 | `ChatModule`、`ChatService`、`DocumentsModule`、`knowledge/`、`retrieval/`、`embedding/` |
| 前置条件 | 新资料导入、普通 chat、slash chat、探索主题、应用启动 |
| 预期行为 | `ChatService`、slash command 与 deep-research 不依赖/调用 `KnowledgeService`；新资料不写 chunks/FTS/vectors；旧模块和历史表仍可编译、迁移并保留 |
| 禁止出现 | 不得删除旧模块或历史表，也不得留下 production path 对 `buildContext()` 的隐式调用 |
| 判定方式 | L1 spies/static import checks + L2 SQLite row counts和 backend build |

### AC-07 探索主题改读目录原文

| 要素 | 内容 |
|---|---|
| 代码位置 | `deep-research/SKILL.md`、`ChatService.stream()`、`LlmService.stream()` |
| 前置条件 | 用户发送 `/探索主题 <主题>`，目录有相关转换 Markdown |
| 预期行为 | Chat 后端预加载资料目录并紧随其后注入 `<agent_state>`；保持 skill 展开与 artifact 产物；模型读取目录中原文，产物引用资料标题/路径 |
| 禁止出现 | 不得再要求注入的知识分片或使 rehearsal 获得文件工具 |
| 判定方式 | L2 agent-stream/deep-research 测试 + L3 真实 Provider smoke |

### AC-08 目录策略可替换且职责不交织

| 要素 | 内容 |
|---|---|
| 代码位置 | catalog、directory、context coordinator、file access policy 的 ports/implementations 与 backend composition root |
| 前置条件 | 目录模式已装配；旧 RAG 模块仍在仓库中 |
| 预期行为 | `ChatService` 仅编排命令，`LlmService` 仅管理 Pi，目录读取、Pi 持久上下文、工具授权、摘要/索引投影分别由单一组件承担；实现经 port 注入，替换知识访问实现不要求修改上传、命令或 session 机制 |
| 禁止出现 | 不得在 Chat/Llm/文件工具内直接查询 catalog entity、渲染 index 或以 feature flag 分支混用 RAG 与目录；不得存在 production import 回指旧 RAG |
| 判定方式 | L1 composition/import 边界测试与代码审查；为每个 port 至少提供一个 fake 实现的单测 |

### AC-09 关键边界有可维护注释

| 要素 | 内容 |
|---|---|
| 代码位置 | 所有新增 public class/method、AGENTS 装载、目录 revision 替换、重复 index 拒绝、旧 RAG 保留处 |
| 前置条件 | 完成目录模式代码变更 |
| 预期行为 | 注释说明责任、信任边界和决策原因，足以让后续替换 RAG 的开发者不需要从调用链猜测约束 |
| 禁止出现 | 不得用重复实现细节的无效注释替代边界说明，也不得让关键安全/持久化分支无说明 |
| 判定方式 | L1 lint/代码审查清单；抽检上述五类关键位置 |

## Required Automated Checks

```bash
# L1
npm run test:document-ingest --workspace @teachforge/backend
npm run test:knowledge-library --workspace @teachforge/backend
npm run test:agent-stream --workspace @teachforge/backend
npm run test:deep-research --workspace @teachforge/backend

# L2
npm run verify:directory-knowledge-library --workspace @teachforge/backend
```

- [L1] 扩展现有 documents、workspace file tools、agent stream 和 deep research 测试，覆盖 AC-01 至 AC-09 的可控路径。
- [L2] 新增 `verify:directory-knowledge-library`：临时 `TEACHFORGE_CONFIG_DIR`/SQLite，真实 backend 和一个已配置测试 Provider；导入 Markdown、生成摘要、核对 index、普通模型自主 `read`、显式命令强制 `read`、删除后目录移除条目。
  - 适用场景：跨文件系统、SQLite、Pi tool lifecycle 和 Provider JSON 语义。
  - 前提条件：测试 Provider 凭据；不得使用用户真实资料目录。
  - 预计耗时：1–3 分钟。
  - 副作用：产生测试 Provider token 成本，仅写临时目录，finally 删除。
  - 清理策略：临时 config/data root 在 finally 中递归清理；Provider 不保存业务对象。

## Required Manual Checks

- [L3] 在桌面端导入一份 PDF/DOCX，确认 `cataloging → ready`、index 可被普通聊天自主读取、工具活动显示文件名；再禁用 Provider 验证安全失败与“重试摘要”。
  - 原因：真实桌面文件选择、Provider 的中文摘要质量和模型的自主决策无法由 mock 完全代表。
  - 执行人：开发者。
  - 判断标准：未输入命令但问题明显命中资料时有目录/原文读取活动；普通常识问题不查；显式命令必查且回答不伪造来源。

## Must-Not-Break Checks

- [ ] 普通对话、附件和会话快照不因目录读取而把全文持久化到用户消息。
- [ ] Agent 不能读取或修改 config.toml、SOULS.md、AGENTS.md，也不能写入知识库目录。
- [ ] 删除资料后用户不会在目录或后续答案中看到已删除资料的路径。
- [ ] 演练保持无工具、无资料目录直读的隔离。

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
|---|---|---|---|---|
| 新 Markdown 导入 | 有摘要与单一目录条目，零新 vector/chunk 行 | L1/L2 | document ingest + directory verify | 验证替换而不是叠加旧索引 |
| 摘要非法 | failed、文件保留、可重试、目录不含该资料 | L1 | catalog service test | 防止模型格式问题污染目录 |
| 连续导入/删除 | index 无重复或已删除条目 | L1 | queue/index test | 防止文件目录成为不可信状态源 |
| 普通资料问题 | Agent 依策略读目录/原文并显示活动 | L2/L3 | agent stream + desktop check | 验证自主查阅价值 |
| 普通知识问题 | 不读取资料库 | L3 | desktop check | 控制成本和误查 |
| `/查询资料库` | 后端持久加载目录；后续轮仅有紧邻用户输入的短状态标记；重复 read 不返回全文 | L2 | agent stream | 保留强制控制并避免重复 token |
| config/SOULS/AGENTS 路径 | 工具拒绝 | L1 | workspace policy test | 保持本机敏感文件边界 |
| 演练 | 无 read/grep，正常生成报告 | L1 | rehearsal regression | 防止角色/权限泄漏 |
| 替换目录实现的 fake | catalog、Chat、Pi session 各按自身 port 测试通过 | L1 | composition/import boundary test | 防止目录策略固化为跨层条件分支 |

## Known Guardrails

- 不把 L1 mock 作为 Provider 格式和模型自主工具选择的充分证据。
- 不记录上传原文、摘要全文、工具结果或 Provider 凭据到日志。
- 真实 Provider 验证必须用临时资料与临时 config root，不能写入用户 `~/.tech-forge`。
- 目录文件是数据库目录元数据的投影，不是可被模型/用户自由写入的权威状态。

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
|---|---|---|
| 把完整 index 加进 AGENTS | 把不可信资料升级为系统上下文并每轮消耗大量 token | AGENTS 只存固定策略，按需工具读取 index |
| 直接 `appendFile(index.md)` | 删除/新版本/失败重试会留下重复或半条目 | 从 DB 快照原子重建 |
| 仅在 prompt 中说“可读知识库” | 不能突破现有守卫目录边界 | 在文件工具中实现窄的只读知识根授权 |
| 用普通 `read` 放开整个 config root | config/SOULS/会话文件会一同暴露 | 仅知识根，并继续检查敏感路径和真实路径 |

## When To Read History

- 修改读取授权时，读取 `docs/changes/2026-11-09-knowledge-storage-isolation/brief.md` 与 `docs/current/platform/agent-runtime.md`。
- 修改/删除旧检索时，读取 `docs/changes/2026-11-08-knowledge-retrieval/design.md` 与 `docs/current/domains/retrieval/index.md`。

## Acceptance Criteria Review

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
|---|---|---|
| AC-01 | pass | `SettingsService.initializeFiles()`、`getManagedFilePaths()` 与 `LlmService.createSession()` 均存在；已安装 Pi SDK 的 `DefaultResourceLoaderOptions.agentsFilesOverride` 与 `noContextFiles` 可共同使用。 |
| AC-02 | pass | `DocumentsService.ingestFile()`、`DocumentVersionEntity` 与现有 SQLite migration 链均存在；AC 将验证新 catalog 字段与停止 `persistChunks()`/`EmbeddingService.embed()` 的调用。 |
| AC-03 | pass | `DocumentsService.libraryQueue`、`deleteDocument()` 和可注入的 storage root 已存在；AC 的 index 原子替换会以 index 派生的 Markdown 白名单为判据，混放原件不改变该边界。 |
| AC-04 | pass | `DocumentsController` 已拥有 imports/deletes 边界，Documents 域可新增目标重试和全库 rebuild 路由；现有失败状态/安全错误字段可承载 catalog failure。 |
| AC-05 | pass | `LlmService.createSession()`、`workspace-file-tools.ts`、`ChatService.stream()` 和 `knowledge-command.ts` 均为真实入口；Pi 的 `appendCustomMessageEntry` 与 `appendContextEdit` 已按当前依赖版本核验。 |
| AC-06 | pass | `ChatService` 当前显式注入并调用 `KnowledgeService.buildContext()`，`DocumentsService` 当前调用 chunk/vector 写入；这些可验证的生产调用将被移除，旧模块与迁移保留。 |
| AC-07 | pass | 内置 `deep-research/SKILL.md`、命令解析、Chat skill 选择和 `LlmService.stream()` 都存在，可验证其从分片输入改为目录/原文读取。 |
| AC-08 | pass | 目录、摘要、Pi context 和文件授权尚为新增代码；AC 已限定每个实现的当前组合根、禁止反向 import，并要求 fakes 验证 port 边界。 |
| AC-09 | pass | 项目 AGENTS.md 已要求类/函数与关键逻辑注释；AC 明确抽检 AGENTS、revision、重复 index 和遗留 RAG 边界。 |

- 评审结论：approved；所有当前引用的位置、方法和 Pi SDK API 已在 2026-11-10 核验，新增类型仅以其后续实现为验收对象。
- 评审方 / 确认人 / 时间：Codex / 开发者已确认目录布局 / 2026-11-10。

## Version History

无；本验证契约仍处于实施前 v1.0。

## 缺陷修正：目录摘要校验上限不一致（2026-11-12）

- 现象：导入 PDF/DOCX 后列表显示“导入失败”、`0 段`，后端无任何错误日志；`document_versions.catalogError = 'Invalid catalog JSON.'`。
- 根因：提示词要求 `summary` “不超过 300 个中文字符”，校验器上限是 200。真实 Provider 返回 260 / 397 字符，校验抛错；该分支只写库不写日志，HTTP 仍返回 200 并把 `processingStatus` 置为 `failed`，渲染层同时出现“本次导入 ✓”与“导入失败”。
- 修正：
  - 长度改为纯提示词软上限（`CATALOG_SUMMARY_SOFT_LIMIT = 200`，措辞“尽量不超过”）；校验器只校验 JSON 形状与非空字段，不再按长度拒绝。校验失败抛 `DocumentCatalogError('INVALID_SUMMARY')`，message 只含数量，非 JSON 的解析错误不再回显原文片段。
  - 成功写 `documents.catalog.ready`（`summaryLength`、`keywordCount`），成功与失败日志都不含摘要或正文。
  - 摘要失败记录 `documents.catalog.failed`（`documentId`、`versionNo`、`code`、`detail`、`trigger`），不记录正文。
  - 新增 `POST /api/documents/:documentId/catalog/retry`：读取该版本已存的转换文本重跑摘要，成功即 `ready` 并重建 `index.md`；已就绪版本幂等返回。
  - 读模型增加 `latest.catalogStatus`；桌面端把摘要失败显示为“摘要未生成”+「重试摘要」，导入反馈卡片按 `status: 'failed'` 显示失败文案，行内不再显示恒为 0 的“N 段”。
- 验证：用户两份真实资料（50 KB DOCX / 11 MB PDF）在修正后导入 `ready`，`index.md` 各写入一条条目；注入 Provider 失败复现 `failed` 与 `documents.catalog.failed`，清除故障后重试 `ready`，重复重试幂等；Electron 渲染层（打桩桥）确认三种状态徽标、重试动作与失败导入卡片。
- 并发与排队（2026-11-12）：`ConcurrencyGate(IMPORT_CONCURRENCY = 3)` 限制上传并发，解析/摘要并行而数据库写入与 `index.md` 重建继续走 `withDatabaseLock`。5 份同时提交的真实测试中，恰好 3 条 `llm.generate.started` 重叠，第 4、5 条在前一批结束后开始，总耗时约两批（3.1 s）；桌面端同样 3 并发并显示“排队中…”；同字节并发上传由锁内的重复检查收敛为一条版本记录。
