---
status: draft
layer: change
domain: directory-knowledge-library
created_at: 2026-11-10
---

# 目录驱动的自主资料库查阅任务

## Preconditions

- [ ] 本设计经 Design Review 通过，且 `verification.md` 的 AC Review 为 `approved`。
- [ ] 已确认 Pi `read` 与 `grep` 对受管目录使用同一真实路径授权实现；否则首版禁用 `grep`。
- [ ] 已准备一个无 Provider、一个有效 Provider、一个摘要返回非法 JSON 的可控测试环境。
- [ ] 已确认现有资料的“显式重建目录”入口及其 Provider 成本提示文案。

## Tasks

1. [ ] 新增 catalog migration、`DocumentVersionEntity`/DTO/read model 字段及对应局部测试。
2. [ ] 先定义目录模式的 ports/DTO（`CatalogSummaryGenerator`、`KnowledgeDirectoryReader`、`SessionContextWriter`）及 composition root，再新增 `DocumentCatalogService`、严格 JSON 校验、基于 context window 的摘要输入预算和 `DocumentCatalogIndexService` 原子目录重建；禁止跨层暴露 TypeORM entity、Pi entry id 或不必要的绝对路径。
3. [ ] 改造 `DocumentsService`：停止分块/FTS/vector 写入，接入 `parsing → cataloging → ready/failed`、retry/rebuild、删除与版本更新后的目录同步；保留旧读取/删除行兼容。
4. [ ] 在 `SettingsService` 创建并保护 `<configDir>/AGENTS.md`；在 assets 中维护其固定模板。
5. [ ] 新增 `KnowledgeDirectoryService`、`KnowledgeContextCoordinator` 与 `KnowledgeFileAccessPolicy` 的目录实现；各自仅实现设计表中职责，并完成单元测试后才接线。所有 public class/method 与安全、revision、持久上下文转换处写“原因与边界”注释。
6. [ ] 改造 `LlmService`：删除 `promptContext`/skill 注释中的“knowledge chunks”、删除“检索不是模型工具”的旧策略注释；精确加载 AGENTS；把单个 `contextMessage` 扩展为有序 `contextMessages`，通过 `SessionContextWriter` 支持带 revision/hash 的 `knowledge_index` custom message，按 revision 做去重并用 `context_edit` 替换旧目录；新增 `preloadedKnowledgePaths` 本轮选项，将显式命令已加载的 index 交给文件工具去重；补充“文件目录替换旧检索、旧模块仅观察”的责任注释。不得在此处实现 catalog、目录渲染或 slash-command 判断。
7. [ ] 改造 `workspace-file-tools`：仅消费 `KnowledgeFileAccessPolicy` 的授权结果，以受控实现替换默认 `grep`；`read` 只允许 index 与由后端解析 index 得到的转换 Markdown 白名单，`grep` 只允许同一原文白名单且不能读取 index；维护本轮 index 已加载状态，重复读取只返回固定状态；不为写入或演练开启知识根权限。
8. [ ] 从 `ChatService`/`ChatModule` 移除 `KnowledgeService.buildContext()`、分片注入、知识 `contextRefsJson` 与检索 telemetry；Chat 只把 slash-command 结果交给 `KnowledgeContextCoordinator`，不直接读取/拼接 index；对 `/查询资料库` 和 `/探索主题` 按 revision/hash 持久化“目录 → `<agent_state>`” custom message；每个后续轮仅在 transient `promptContext` 追加紧邻用户输入的短状态指针。
9. [ ] 改造 `deep-research` skill 及其测试，使其消费预加载目录并读取转换 Markdown，而不假设注入分片；保持 artifact 流程，确保 rehearsal 的 `tools: []` 不受影响。
10. [ ] 更新资料库页面状态、摘要失败重试和显式全库重建入口；不暴露目录正文。
11. [ ] 添加观察日志与测试，跑完验证矩阵；完成后同步 current 文档、manifest、历史替代关系与 worklog；额外进行一次依赖方向检查，确认不存在 Chat/Llm/文件工具反向依赖 Documents catalog 或旧 RAG 的 production import。

## Verification Commands

```bash
npm run build --workspace @teachforge/backend
npm run test:document-ingest --workspace @teachforge/backend
npm run test:knowledge-library --workspace @teachforge/backend
npm run test:agent-stream --workspace @teachforge/backend
npm run test:deep-research --workspace @teachforge/backend
npm run build --workspace @teachforge/desktop
node -e "const fs=require('fs'); require('yaml').parse(fs.readFileSync('docs/manifest.yaml','utf8')); console.log('manifest yaml: valid')"
git diff --check
```

## Completion Checklist

- [ ] Code behavior matches design and every AC has a recorded result.
- [ ] 新导入资料不再写入新的分片、FTS 或 embedding 行。
- [ ] `~/.tech-forge/AGENTS.md`（或受环境变量覆盖的 config root）存在且只被精确加载。
- [ ] Agent 能在需要时读取 `index.md` 与转换 Markdown，但不能读取/写入 config、SOULS 或知识根以外的受保护文件。
- [ ] 导入、失败重试、删除、新版本和显式重建不会产生重复或失效目录条目。
- [ ] Current docs reflect final behavior; 旧检索文档被明确标为已替代而非误写为当前事实。
- [ ] No task-only document is routed as required runtime context outside its manifest route.
