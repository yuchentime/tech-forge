---
status: draft
layer: change
domain: rehearsals
created_at: 2026-11-10
---

# 会话知识掌握事实 Tasks

## Preconditions

- [x] 需求范围已确认；[技术设计评审](reviews/design-review.md)为 PASS，DESIGN_REVIEW_PASS=passed。
- [x] 必需资料已定位：[设计](design.md)、[API 契约](api-contract.md)、[响应 Schema](api-schema.json)、[验收标准](verification.md)。实施前按 `docs/index.md` → `docs/manifest.yaml` 的 conversation-knowledge-facts 路由读取当前事实。
- [x] 验证目标为 AC-01–12；源码锚点可判定性已复核，应用测试尚未执行。
- [ ] 接手者复核上述资料与当前代码，补齐 verification.md 的 AC 确认记录；当前 acceptance_review_status=pending，确认后才改 approved，不把文档技术核验当作实现验收。**待用户确认，实施者未代签。**
- [x] 核对当前分支与工作区，使用适合本任务的独立分支；保留其他人修改。交接时已有 knowledge-session-cards / knowledge-profile 相关工作，且 rehearsal.types.ts、rehearsals.controller.ts 有其他修改，不得覆盖或整文件回退。已使用 `codex/conversation-knowledge-facts`，保留工作区其他修改。
- [x] 按 agent-runtime-docs 模板创建本变更的 worklog.md；每轮记录任务、AC、验证结果和偏差。

本期仅后端生成、持久化与单会话查询；不实施前端卡片、Electron 桥接、普通对话注入或跨会话画像。不新增 requestedVersion、publishedVersion、sourceEvaluationsJson、attemptCount、独立任务表或知识点表。

## Tasks

按 T01→T02→T03→T04→T05→T06→T07→T08→T09→T10 执行。测试随对应任务补齐，不等最后才验证；T09 负责真实联动及完整回归。以下新增文件名为建议落点，不表示已存在。

1. [x] **T01：建立验收夹具及测试入口**（依赖：Preconditions；AC-01–12）
   - 在 `apps/backend/test/` 新增事实专用套件，复用现有 rehearsal.test.cjs 的临时数据库/模块装配方式，避免测试写入正式数据库。
   - 准备先弱后强、退步、局部掌握、未考察、跳过、证据分歧、全部未验证、不同演练同 pointId、损坏历史及旧事实夹具。
   - 提供可控模型完成屏障，支持成功、失败、悬挂和新报告到达；进程恢复场景使用真实子进程，不仅清空 Map。
   - 运行脚本新增到 backend package.json 后，把真实命令补入 verification.md；明确 L1、真实 SQLite/HTTP 的 L2、真实 provider 的 L2 分组。
   - 完成证据：夹具可独立装配、清理；脚本可运行，未实现行为不得伪造通过。

2. [x] **T02：增加简化事实表与实体**（依赖：T01；AC-02、09）
   - 新增 `conversation-knowledge-fact.entity.ts` 与迁移，在 `database/database.options.ts` 和 `rehearsals.module.ts` 注册。
   - 严格采用 design 的字段：conversationId 主键/外键、四类事实内容、generationStatus、lastError、generatedAt、createdAt、updatedAt；状态普通索引供扫描。
   - up 不回填任何历史会话；down 只删除新增派生表/索引，不修改演练、消息、快照。
   - 完成证据：真实 SQLite up/down/up、同会话唯一约束、首建 null/default、原数据不变。

3. [x] **T03：实现事实 DTO、解析与输出校验**（依赖：T02；AC-02、07、10）
   - 建议新增 `conversation-knowledge-facts.types.ts` 与独立校验文件；与原报告 mastered/partial/weak/unverified 分开，不修改其枚举。
   - 对齐 api-schema.json：全部字段出现、空值/生成状态组合、日期、summary ≤200 Unicode code points、标签 0–8 个、去重非空。
   - 知识点校验 evidenceStatus、等级及有效考察时间；拒绝非法字段和无效项，不能沿用 parseReportResponse 的静默过滤逻辑。
   - 引用白名单限定为本次材料中的引用或旧事实原样引用，并检查同一会话中真实存在的 rehearsalId + pointId；不得按 pointId 跨演练直接合并。
   - 完成证据：结构/边界/emoji/引用反例测试通过；首次无成功内容与“旧事实+更新失败”均符合 schema。

4. [x] **T04：实现输入快照、时序 Prompt 与模型预算**（依赖：T03；AC-05、06、07、08、12）
   - 事实服务读取会话全部 completed 报告及计划，按 endedAt、createdAt、id 升序；损坏报告/映射失败明确失败，不静默漏掉证据。
   - 新增专用 Prompt：最近有效直接证据更新对应范围；未涉及保留；跳过非退步；局部非整体；歧义/分歧明示；资料不是指令。
   - 扩展 LlmService.generate 的可选预算构造入口，在同一次模型解析后使用实际 contextWindow 构建输入，保持现有字符串 prompt 调用兼容。
   - 按设计预留输出与安全余量，计入最终 system prompt、结构包装及修复追加文本；先全量，超限整份移除最旧历史，保留旧事实+本次，允许 N=0，本次仅输入一次。
   - 窗口未知或必保留材料仍超限时失败；不得静默裁剪旧事实/本次评估或依赖 SDK 隐式压缩保留语义。
   - 使用独立 signal、tools=[]、loadMemory=false、专用固定 system prompt，不携带学生 persona、父会话上下文，不加载 SOULS/记忆或写消息/快照。
   - 结构生成最多 3 次调用（含首次，最多 2 次修复）；provider 错误按已有 LLM 边界处理，不在事实服务无限重试。
   - 完成证据：输入顺序、去重、预算边界、修复预算、模型配置绑定、旧调用兼容测试通过。

5. [x] **T05：实现持久化状态与后台调度**（依赖：T02–04；AC-02、03、04、08）
   - 建议新增事实服务及专用 worker，放现有 rehearsals 模块，单向依赖 DataSource/LlmService，不做通用队列框架。
   - 默认全局一个事实 worker，5 秒扫描 pending，按 updatedAt、conversationId 排序；重跑回队尾。
   - worker 排他在第一个 await 前占位；短事务将 pending→running 并读取输入快照，模型调用在事务外。
   - 成功/失败仅在状态仍为 running 时条件更新；pending 表示已有新评估，旧结果或旧失败均丢弃并重跑；行消失则退出。完成路径禁止 upsert。
   - 成功整体发布并更新时间；失败保留全部旧内容/generatedAt，保存脱敏 lastError；新开始和成功清空旧错误。
   - 启动先恢复遗留 running→pending，再领取；扫描补偿未唤醒/释放排他竞态，failed 不自动重试。关闭停止领取，尽力取消当前调用，留持久化状态供下次恢复。
   - 数据库写入失败也必须释放进程排他并记录错误；针对恢复后的状态给出可验证处理，不允许永久占用 worker 或吞异常。
   - 完成证据：成功/失败双路径竞态、单会话排他、多会话公平、扫描补偿、真实重启用例通过。

6. [x] **T06：接入演练报告完成事务**（依赖：T05；AC-01、03、08、12）
   - 在 RehearsalsService.finishRehearsal 的共享完成路径中，将报告保存与 pending 登记合并同一数据库事务，覆盖 end、answer/skip 达到上限。
   - 同一会话已有行时仅置 pending、清理旧错误，保留已发布内容；正在 running 时同样持久化为 pending。
   - 提交后唤醒 worker，不等待事实模型；唤醒失败由扫描补偿，不能把已成功报告改失败。
   - completed 重复 end 不重新登记；原报告失败不登记，零回答丢弃和已有无有效证据报告规则保持不变。
   - 完成证据：真实服务/SQLite 事务回滚、阻塞后台模型仍返回原报告、所有结束入口、重复 end 回归通过。

7. [x] **T07：实现只读 API 及模块装配**（依赖：T03、T05；AC-10、11）
   - 新增独立 Controller 注册 `GET /api/conversations/:conversationId/knowledge-facts`；不要误挂在现有 rehearsals 子路由下。
   - 校验 UUIDv4，沿用 main.ts 本机 token 和 Origin 拒绝规则；不新增账户权限或全局错误 envelope。
   - 在一致读取视图中确认会话及事实；无会话 404，有会话无事实返回 200 + fact=null；JSON 损坏返回安全 500。
   - 解码 JSON 列，映射 UTC 日期；返回字段严格符合 api-contract.md/api-schema.json。生成 failed 仍为 GET 200，保留旧内容。
   - GET 不触发生成或恢复，不加缓存、轮询、前端桥接，不改已有 knowledge-cards mock。
   - 完成证据：真实 HTTP 全状态 schema、400/401/403/404/500、Origin 优先级及无查询副作用测试通过。

8. [x] **T08：接入会话删除清理**（依赖：T02、T05；AC-09）
   - 在 ConversationsService.deleteConversation 原事务中，先删除事实行再删除会话，保持现有各派生表清理顺序合法。
   - 不通过反向导入 rehearsals 服务进行取消；worker 调用前/回写时检查行存在性，迟到结果不得重建记录。
   - 完成证据：后台生成中删除、迟到成功/失败、删除事务失败回滚、原会话删除用例均通过。

9. [x] **T09：执行分层验收与现有回归**（依赖：T06–08；AC-01–12）
   - 完成 T01 新增套件，并执行下方现有构建/回归命令；逐 AC 记录 pass/fail/not_covered 及证据位置。
   - 临时数据库/真实子进程验证恢复、竞态及迁移；受控 provider 只证明编排，不证明事实语义。
   - 显式开启真实 provider 验证预算及时间序列样例，由验收者核查进步/退步/范围/分歧输出；记录模型及脱敏输入输出，不泄露配置或密钥。
   - 缺少真实 provider 环境时记录 not_covered 和原因，不宣称全部验收通过；清理临时目录/端口/连接。
   - 完成证据：verification.md 有可复现命令、运行结果、剩余限制，原报告/digest/transcript/历史无回归。

10. [x] **T10：文档同步、评审与交付**（依赖：T09）
    - 按已验证行为更新 current/domains/rehearsals、current/platform/agent-runtime、current/domains/conversations/backend-behavior 及关联索引/manifest；任务清单不写入 current。
    - 设计变化记录在 design.md 的 Design Deviations；改变范围/API/状态协议时重新进行技术设计评审，实施前迭代保持 v1.0。
    - 更新本 tasks 勾选状态、worklog 和 verification；按技能模板创建实际实施评审记录及 AC 覆盖矩阵，未覆盖项保留可追踪问题。
    - 仅实现并验证后将 design 状态改 implemented，填写 landed_in；没有提交则不编造提交 hash。
    - 完成证据：交付说明包含 API、迁移、验证结果、已知限制及回滚方式；只提交本任务文件，保留其他修改。

11. [x] **T11：新增事实集合查询**（依赖：T07；AC-13）
    - 在事实 controller 新增 `GET /api/knowledge-facts`；集合按 `updatedAt DESC, conversationId ASC` 排序，无分页、无生成副作用。
    - `listAll()` 只查询小字段，不读取、不返回 `knowledgePointDetails`；需要详情时仍走单会话接口。空集合返回 `items: []`。
    - 同步 current API 契约、design v2.0、verification AC-13、worklog L003 与实施评审 L002。
    - 完成证据：L1 映射测试 + L2 HTTP 空集合/全量/认证测试通过。

## Verification Commands

从仓库根目录执行；前四条是现有命令，事实专用命令由 T01 新增后补录。本次编写清单不运行应用测试。

```bash
npm run build --workspace @teachforge/backend
npm run test:rehearsal --workspace @teachforge/backend
npm run test:conversation-delete --workspace @teachforge/backend
npm run test:session-entries --workspace @teachforge/backend
git diff --check
python3 /Users/heyuchen/.codex/skills/agent-runtime-docs/scripts/check_doc_runtime.py docs
```

最后一条为当前机器技能路径；同事机器上使用其安装的 agent-runtime-docs 对应脚本。全库既有错误及模板/检查器对 reviews/index.md 的冲突见 [技术评审](reviews/design-review.md)，需要区分既有问题与本次新增问题，不可直接宣称检查通过。

## Completion Checklist

- [x] Code behavior matches design：T01–T10 完成，偏差记录在 design.md 的 Design Deviations。
- [x] Tests pass：AC-01–12 逐项有证据；AC-05 真实语义与 AC-06 真实 provider 窗口为 not_covered，已单列。
- [x] Current docs reflect final behavior：只同步已实现并验证的事实。
- [x] Historical or superseded docs are marked：本变更无替代旧文档；变更目录保留设计与验收追溯。
- [x] No task-only document is routed as required runtime context：tasks 只在 manifest optional。
- [x] 一会话一条记录、简化字段、独立后台运行和只读接口符合已确认边界。
- [x] 删除、重启、连续演练和上下文截断均有实际测试；未修改知识卡片 mock 以外的他人改动。
- [x] 实施评审已记录；worklog、verification 和 reviews/L001.md 包含真实结果。
