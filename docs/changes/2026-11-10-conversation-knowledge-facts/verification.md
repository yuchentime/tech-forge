---
status: current
layer: change
domain: rehearsals
created_at: 2026-11-10
version: 2.0
acceptance_review_status: pending
---

# 会话知识掌握事实 Verification

> 状态：`implemented`（2026-11-10）。自动化 L1/L2 已执行；真实 provider L3 未覆盖，`acceptance_review_status` 仍为 `pending`。

## Test Layer Taxonomy

- L1：局部逻辑与受控模型输出，只证明结构、分支和状态逻辑。
- L2：真实 SQLite、迁移、HTTP、进程生命周期的集成；模型受控替身只证明编排，真实 provider 另列验证。
- L3：人工核验真实模型输出的语义、范围和时间推理，不替代可自动化的状态测试。

## Acceptance Criteria（代码级验收规则）

代码位置均为当前已有锚点；明确标为“拟新增”的 worker、schema、表和 endpoint 是待实现契约，不能据此宣称已有实现。路径以 apps/backend/src 为根。以下标准尚未运行。

### AC-01 报告完成与幂等

| 要素 | 内容 |
|---|---|
| 代码位置 | RehearsalsService.finishRehearsal / end / answer / skip（rehearsals.service.ts） |
| 前置条件 | 新报告完成；或对 completed 演练重复 end |
| 预期行为 | 手动与上限路径均将报告和 pending 登记同事务提交；HTTP 不等待事实模型；重复 end 不重置事实状态。事务失败二者均不提交 |
| 禁止出现 | 报告已提交而任务登记丢失；事实失败改坏演练状态 |
| 判定方式 | L2：真实 SQLite + 服务，阻塞事实模型 promise；检查 end 返回及事务回滚 |

### AC-02 唯一记录与原子发布

| 要素 | 内容 |
|---|---|
| 代码位置 | RehearsalEntity.conversationId；buildDatabaseOptions（database/database.options.ts）；拟新增表见 design |
| 前置条件 | 同会话完成两次演练，第一次已有成功事实 |
| 预期行为 | 最多一行；整组事实字段和 generatedAt 一次提交；首次未成功内容全 null，更新中保留上次完整内容 |
| 禁止出现 | 按 rehearsalId 新建事实；混合新摘要旧知识点 |
| 判定方式 | L2：真实迁移、SQL 唯一约束和查询快照 |

### AC-03 串行与持久化重跑

| 要素 | 内容 |
|---|---|
| 代码位置 | RehearsalsService.finishRehearsal（登记入口）；LlmService.generate（模型边界）；拟新增 worker |
| 前置条件 | A 已领取 running 后阻塞，报告 B 成功 |
| 预期行为 | B 设置 pending；A 成功或失败均不得覆盖；新 worker 输入包含 B；同会话同时最多一个调用，状态最终 completed |
| 禁止出现 | A 迟到结果覆盖 B；旧失败吃掉 pending |
| 判定方式 | L2：可控 provider 屏障 + 真实 DB，分别释放成功/异常；不靠 sleep 猜顺序 |

### AC-04 重启及丢失唤醒恢复

| 要素 | 内容 |
|---|---|
| 代码位置 | main.ts enableShutdownHooks；RehearsalsModule（rehearsals.module.ts）；拟新增生命周期 worker |
| 前置条件 | 事务已提交未唤醒；或 running/pending 后进程退出 |
| 预期行为 | 新进程先 running→pending，再调度；周期扫描在下一次可用扫描周期拾取 pending；failed 不自动重试 |
| 禁止出现 | 只靠内存 dirty 标识；重复 worker；无任务启动批量回填旧会话 |
| 判定方式 | L2：真实临时数据库与子进程终止/重启；等待有界完成事件 |

### AC-05 时间序列和语义边界

| 要素 | 内容 |
|---|---|
| 代码位置 | RehearsalEntity.planJson/overallEvaluationJson/endedAt；rehearsal.types.ts RehearsalReport |
| 前置条件 | 先 weak 后 mastered、反向退步、跳过、未涉及、局部提高、同 ID 异义、分歧、全部 unverified 样例 |
| 预期行为 | 输入升序且材料携带范围；模型案例按最近有效直接证据更新对应范围；未涉及保留；insufficient 等级为空；分歧明确；局部不扩大全部 |
| 禁止出现 | 将未考察判为薄弱；仅凭 pointId 合并；同时宣称当前掌握且不掌握同一范围 |
| 判定方式 | L1：排序/输入断言；L2：真实模型批量样例保存脱敏输出；L3：人工核查不可机械判定的语义 |

### AC-06 预算与完整材料

| 要素 | 内容 |
|---|---|
| 代码位置 | LlmService.generate / createSession（llm.service.ts）；拟新增可选预算构造入口 |
| 前置条件 | 模型窗口充足/不足/未知；存在旧事实及多个历史报告 |
| 预期行为 | 固定同一次模型配置构造输入；全量优先；不足从最旧整份移除，本次仅一次；N=0 可用；必保留超预算失败保留旧事实；修复 prompt 也计预算 |
| 禁止出现 | 调用前后读取不同模型窗口；字符切坏 JSON；静默丢本次或旧事实 |
| 判定方式 | L1：预算边界和中文/emoji；L2：实际 provider 接受输入及模型配置固定验证 |

### AC-07 结构化结果与引用校验

| 要素 | 内容 |
|---|---|
| 代码位置 | rehearsal-json.ts parseReportResponse 为既有报告边界；拟新增事实校验器，不复用其宽松过滤行为 |
| 前置条件 | 模型返回超长摘要、非法枚举、空白字段、重复项、跨会话或凭空引用 |
| 预期行为 | 拒绝非法结果，最多三次结构修复；summary 按 code point ≤200；仅输入引用或旧事实原引用可保留，且 DB 中同会话真实存在 |
| 禁止出现 | 非法条目被静默过滤后发布；新编被截断报告的引用 |
| 判定方式 | L1：非法输出矩阵；L2：DB 引用关系、旧引用保留和跨会话拒绝 |

### AC-08 失败保留与模型隔离

| 要素 | 内容 |
|---|---|
| 代码位置 | LlmService.generate；RehearsalsService.generateValidated 的现有调用选项参照 |
| 前置条件 | 旧事实存在；超时、传输异常、修复耗尽；调用结束演练 |
| 预期行为 | 任务 failed+脱敏 lastError；旧内容/generatedAt 不变；专用 signal，tools=[]、loadMemory=false、固定 system prompt，不传父 conversation 快照 |
| 禁止出现 | 借用 end signal 取消后台；加载学生 persona/SOULS；写普通会话消息/快照 |
| 判定方式 | L1：参数断言；L2：数据库旧值与消息/快照比较；真实超时按配置触发 |

### AC-09 会话删除与迁移回滚

| 要素 | 内容 |
|---|---|
| 代码位置 | ConversationsService.deleteConversation；database.options.ts 迁移注册 |
| 前置条件 | 事实生成中删除会话；迁移 up/down/up |
| 预期行为 | 同一删除事务清理事实；迟到结果 affected=0 不重建；down 仅删新表，演练与消息不变，up 不回填 |
| 禁止出现 | 新增反向模块循环；后台 upsert 复活；删除原评估 |
| 判定方式 | L2：真实 SQLite、真实迁移、受控生成中删除与 SQL 对比 |

### AC-10 查询 schema 与状态

| 要素 | 内容 |
|---|---|
| 代码位置 | main.ts 全局 api 前缀；ConversationRehearsalsController 现有路由参照；拟新增 GET 见 api-contract.md |
| 前置条件 | 存在会话但无行，或各生成状态，或 JSON 损坏 |
| 预期行为 | 严格符合 api-schema.json；无行返回 fact=null；首次/旧事实空值规则正确；JSON 损坏 500；读取无生成副作用 |
| 禁止出现 | 放到 rehearsals 子路径；GET 触发任务；failed 返回 502；暴露 *Json 列文本 |
| 判定方式 | L2：真实 HTTP 请求 + JSON Schema 校验，检查无新增模型调用/状态写入 |

### AC-11 本机认证与错误

| 要素 | 内容 |
|---|---|
| 代码位置 | main.ts onRequest；rehearsals.controller.ts ParseUUIDPipe 使用方式 |
| 前置条件 | 无/错 token，带 Origin，合法 token+非法 UUID/不存在会话 |
| 预期行为 | 分别 401、403（优先于 token）、400、404；错误至少 statusCode/message；安全错误无 provider/SQL 原文 |
| 禁止出现 | 新增账号或租户权限；把不存在会话当 fact=null |
| 判定方式 | L2：启动实际 Fastify/Nest 边界，覆盖完整错误矩阵 |

### AC-12 历史兼容与既有行为

| 要素 | 内容 |
|---|---|
| 代码位置 | RehearsalsService.buildConversationDigest / finishRehearsal；rehearsal-json.ts；现有 rehearsal.test.cjs |
| 前置条件 | 旧会话从未登记；后续新演练；损坏 completed 报告 |
| 预期行为 | 启动/查询不回填；新触发读取上线前评估；损坏报告明确失败不静默丢弃；原 digest/transcript/历史响应不变 |
| 禁止出现 | 后台任意改原始报告；前端 mock 卡片接口被替换 |
| 判定方式 | L2：现有演练/删除/session entries 回归及混合旧数据夹具 |

### AC-13 事实集合查询

| 要素 | 内容 |
|---|---|
| 代码位置 | ConversationKnowledgeFactsController.list；ConversationKnowledgeFactsService.listAll；ConversationKnowledgeFactListItem |
| 前置条件 | 多条事实（published / pending），其中一条详情 JSON 很大；无记录；无 token / 带 Origin |
| 预期行为 | `GET /api/knowledge-facts` 返回全部事实，按 `updatedAt DESC, conversationId ASC` 排序；查询只选择小字段，不读取/返回 `knowledgePointDetails`；空集合返回 `items: []`；认证错误仍为 401/403 |
| 禁止出现 | 列表序列化详情、触发生成/修复、分页缺失导致字段截断、把损坏 JSON 伪装成空值 |
| 判定方式 | L1：`listAll returns every fact without knowledge-point details`；L2：HTTP 集合、空集合与认证矩阵 |

## Required Automated Checks

现有命令（2026-11-10 已执行）：

```bash
npm run build --workspace @teachforge/backend
npm run test:knowledge-facts --workspace @teachforge/backend
npm run test:rehearsal --workspace @teachforge/backend
npm run test:conversation-delete --workspace @teachforge/backend
npm run test:session-entries --workspace @teachforge/backend
TEACHFORGE_REAL_PROVIDER=1 npm run verify:knowledge-facts-provider --workspace @teachforge/backend
```

- [L1] 已在 `apps/backend/test/knowledge-facts.test.cjs` 补入事实输入、预算、结构校验与状态逻辑；实际命令见下表。
- [L2] 已在同一套件及 `knowledge-facts-http.test.cjs` 覆盖真实 SQLite、迁移、Fastify HTTP 与真实子进程恢复；使用临时目录/端口并清理，不访问正式数据库。
- [L2] 真实 provider 入口已实现为 `verify:knowledge-facts-provider`，必须显式设置 `TEACHFORGE_REAL_PROVIDER=1`；本次未配置 provider，未执行。

### 实施执行结果（2026-11-10）

| 命令 | 分组 | 结果 |
|---|---|---|
| `npm run build --workspace @teachforge/backend` | L2 构建 | pass |
| `npm run test:knowledge-facts --workspace @teachforge/backend` | L1 + L2（27 total：22 core + 5 HTTP） | pass |
| `npm run test:rehearsal --workspace @teachforge/backend` | L2 回归（19） | pass |
| `npm run test:conversation-delete --workspace @teachforge/backend` | L2 回归（2） | pass |
| `npm run test:session-entries --workspace @teachforge/backend` | L2 回归（5） | pass |
| `npm run verify:knowledge-facts-provider --workspace @teachforge/backend` | L2 真实 provider | `SKIPPED`（未设 `TEACHFORGE_REAL_PROVIDER=1`） |
| `git diff --check` | 交付检查 | pass |

### AC 实施结果

| AC | 结果 | 证据 |
|---|---|---|
| AC-01 | pass | `knowledge-facts.test.cjs`：报告完成同事务登记、登记失败整体回滚、HTTP 先返回 |
| AC-02 | pass | 单行 upsert、整体发布、迁移 up/down/up、HTTP 各状态 schema |
| AC-03 | pass | 生成中到达新报告、旧成功/旧失败不覆盖 pending、单 worker 与队尾重跑 |
| AC-04 | pass | 进程内 running→pending + 真实子进程 kill/restart |
| AC-05 | not_covered（L3） | L1 已断言输入顺序/预算/引用；真实模型进步/退步/范围/分歧语义未执行 |
| AC-06 | pass（L1）；真实窗口 not_covered | 全量、整份截断、N=0、窗口未知失败；provider 接受未执行 |
| AC-07 | pass | 非法输出矩阵、200 code point/emoji、重复项、伪造引用与时间、旧引用保留 |
| AC-08 | pass | 失败保留旧内容/generatedAt、脱敏 lastError、模型隔离参数 |
| AC-09 | pass | 生成中删除、迟到结果不复活、删除事务触发回滚、迁移降级保留原数据 |
| AC-10 | pass | 无行/首次/旧事实+failed/completed + Ajv 2020 schema + 损坏 JSON 500 |
| AC-11 | pass | 401/403（Origin 优先）/400/404；错误不含原始 JSON/SQL |
| AC-12 | pass | 损坏报告明确失败；rehearsal/delete/session-entries 回归通过 |
| AC-13 | pass | 集合查询返回全部事实、无 `knowledgePointDetails`、空集合与认证矩阵通过 |

## Required Manual Checks

- [L3] 评审者逐条核对 AC-05 真实模型输出：先弱后强应更新到新证据支持的等级；未考察保持；局部改善不扩范围；矛盾输出明确分歧；所有结论可回溯输入。不可接受项任何一次出现即判该案例失败，记录模型、输入与输出的脱敏样本。
- 原因：这些语言语义无法仅用枚举和关键词断言完整判断。执行人是实施验收者；不是要求用户手工验证数据库或并发。

## Must-Not-Break Checks

- [x] 用户结束演练仍先拿到原报告，无需等第二次生成。（AC-01 自动化）
- [x] 事实失败后可继续查看原报告和上次成功事实。（AC-08 / HTTP failed 用例）
- [x] 普通对话 digest、演练历史和 transcript 不改变。（rehearsal / delete / session-entries 回归）
- [x] 会话删除后不再出现其派生事实。（AC-09 删除中生成用例）

## Regression Matrix

| Scenario | Expected Result | Layer | Check | Why It Matters |
|---|---|---|---|---|
| 手动/上限/重复结束 | 原报告正常、只登记新报告 | L2 | AC-01 | 覆盖实际共享入口 |
| 新评估抢在旧生成完成前到达 | 重跑，旧结果不发布 | L2 | AC-03 | 排除异步乱序 |
| 中断并重启 | 数据库信号恢复 | L2 | AC-04 | 排除纯内存假恢复 |
| 进步/退步/范围/分歧 | 当前结论符合证据 | L2/L3 | AC-05 | 检验模型语义限制 |
| 中文超预算 | 完整材料与必保留范围正确 | L1/L2 | AC-06 | 排除固定 N 的伪预算 |
| 删除/降级 | 不复活、不删原评估 | L2 | AC-09 | 生命周期安全 |
| 状态和错误矩阵 | schema/认证一致 | L2 | AC-10/11 | 消费者稳定契约 |

## Known Guardrails

- 代码级验证与真实 provider 语义验证分开报告，不将 mock 结果冒充真实模型表现。
- 多进程任务并行不在支持范围；真实重启测试必须退出旧进程。
- 自动化集成优先，外部模型调用显式开启；只使用临时数据，清理失败需记录。
- 技术设计 PASS 不等于 CODE_PASS 或 AC 实测通过。

## Known Anti-Patterns

| Anti-Pattern | Why It Is Wrong | Correct Approach |
|---|---|---|
| 用 sleep 排并发顺序 | 无法证明目标竞态被覆盖 | 屏障控制模型完成并观察真实 DB |
| 以模型替身证明事实一致 | 只验证预设输出 | 真实 provider 案例加语义核查 |
| 重启测试只清空 Map | 不覆盖启动流程与持久化 | 真实退出/启动子进程 |
| 只测 happy path schema | 遗漏旧事实+失败、首次空内容 | 全状态矩阵 |

## When To Read History

- 改普通对话 digest 时才读取 ../2026-11-09-rehearsal-digest-delivery/design.md；本次不改其投递语义。

## Acceptance Criteria Review

首轮起草后逐条核对已有源码及 package scripts，第二轮修订如下。这里只评审标准可判定性，不是代码验收结果；用户对新增标准的确认待完成，不代签确认。

| AC | 核验结果 | 备注（修正内容 / 协商一致结论） |
|---|---|---|
| AC-01 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-02 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-03 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-04 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-05 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-06 | pass | 第二轮源码锚点与可判定性核验通过；首轮 revised：generate 内才选模型；已修订为同一次模型解析后的预算构造。尚未执行实现测试。 |
| AC-07 | pass | 第二轮源码锚点与可判定性核验通过；首轮 revised：既有 parseReportResponse 会过滤非法项；新事实必须独立严格校验。尚未执行实现测试。 |
| AC-08 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-09 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-10 | pass | 第二轮源码锚点与可判定性核验通过；首轮 revised：新接口尚不存在；明确拟新增路径，禁止继承 rehearsals 前缀。尚未执行实现测试。 |
| AC-11 | pass | 第二轮源码锚点与可判定性核验通过；首轮 revised：补现有 Origin 403 及优先顺序。尚未执行实现测试。 |
| AC-12 | pass | 第二轮源码锚点与可判定性核验通过；已有锚点已核对，拟新增行为单独标记。尚未执行实现测试。 |
| AC-13 | pass | 集合接口契约、字段排除、排序、空集合与认证边界可判定。 |

- 评审结论：技术可判定性核验通过；新增验收标准待用户确认，因此 acceptance_review_status 保持 pending。
- 评审方 / 确认人 / 时间：Codex 同会话独立复核 / 用户待确认 / 2026-11-10。

## Version History

### v2.0 — 2026-11-10

- 触发：用户要求在事实 controller 新增查询全部记录的 list API，并忽略详情字段。
- 改动内容：新增 AC-13；补充 L1/L2 集合查询与空集合/认证验证。
- 影响范围：只读 HTTP 列表；不改变 AC-01–12 的生成、持久化和单会话查询契约。
- 处理状态：已实现并通过自动化；验收标准确认状态仍为 pending。

### v1.0 — 2026-11-10

- 初始实施前验收标准；AC-01–12。
