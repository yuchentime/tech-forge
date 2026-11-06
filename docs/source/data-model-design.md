# TeachForge 个人学习数据建模草案

- 状态：设计输入草案，尚非实现基线
- 更新日期：2026-11-06
- 责任单元：个人学习 Conversation 及其对话、演练、共享/会话资料和学习物料
- 相邻单元：文档与检索、Agent 运行、后台任务

## 1. 设计结论

MVP 数据模型以个人学习 Conversation 为核心。一个 Conversation 可以同时包含学习对话、问答演练和由学习过程产生的物料，不需要先创建教学组织记录。

Conversation 表示一条可持续的个人学习线索，不是 HTTP 会话、登录会话或单次 Agent Run。消息、演练、物料和资料仍由各自的业务记录保存；Conversation 提供统一的学习入口和关联，不把所有内容塞进一个字段，也不替代演练、版本等领域自身的状态边界。

共享知识库是整个本地应用可访问的单一文档集合，不需要单独的 KnowledgeBase 实体。文档可标记为全局共享，也可通过关联加入一个或多个 Conversation；当前 Conversation 的检索默认可使用共享文档及已关联文档。

工作空间路径与模型 Provider 属于本机系统配置，不进入业务表；详见[本地系统配置设计草案](system-configuration-design.md)。

## 2. 范围决策

### 单人 Personal Agent

开发者补充确认（2026-11-06）：TeachForge 当前定位为只供一个人使用的本地 Personal Agent。数据模型不建立用户/教师身份主体、账号、登录会话、角色授权、租户/工作区隔离，也不在业务记录中添加 user_id 或 teacher_id。

### 直接移除教学组织实体

当前阶段的目标模型直接移除 Course、Class、Lesson、LessonClass，以及依赖这些实体才能成立的 DeliveryRecord。它们不作为核心实体，也不保留为可选外键、占位模块或兼容抽象。Conversation、资料、演练和物料均可独立创建和使用。

产品以教师授课为使用场景，不要求代码模型也照搬课程管理系统的组织层级。当前设计围绕个人学习过程建模。

### 与既有设计资料的差异

需求文档、功能设计文档和后端架构草案仍包含 Course、Class、Lesson、DeliveryRecord，以及按 courseId/lessonId 限定检索范围的设计。需求/原型还把学习与演练描述为互斥模式；功能设计要求切入演练后隐藏普通输入框。这与本轮用户路径中“并列分屏、普通对话持续可用”冲突。slash 命令生成思维导读也是本轮补充的产品路径。

本草案记录的用户路径和开发者补充决策作为当前阶段的数据模型输入。上述原始需求、功能设计、架构草案及原型本轮不作改写；后续产品范围同步时需逐项处理这些差异，避免实现重新引入已移除实体或互斥模式。

### 暂缓长期记忆建模

产品需求文档中的长期记忆需求继续保留。本阶段的数据模型不设计 Memory、MemorySource、ConceptProgress 等长期记忆实体，也不设计跨 Conversation 记忆提取、确认、纠错、过期、检索或知识状态投影；相关实体边界后续单独讨论。本阶段也不建立持久化 Concept/ConceptRelation；当前 Conversation 的主题和思维导读节点关系保存在会话产物中。Conversation 内为继续对话而读取消息、演练回答和评估，属于本次学习过程所需的会话历史，不作为长期记忆模型。

## 3. 用户路径回归结果

| 路径步骤 | 数据模型要求 | 回归结论 |
|---|---|---|
| 应用级共享知识库上传通用资料 | Document.isShared 标记全局可检索；保留文档版本、来源定位和索引状态 | 共享不自动等于事实已验证 |
| 进入 Conversation 并上传领域资料 | 通过 ConversationDocument 将资料关联到当前 Conversation；删除/归档时定义资料保留规则 | 文件选择入口不改变资料与 Conversation 的关联模型 |
| 与模型学习概念 | Message 归属 Conversation；检索同时读取共享资料和当前 Conversation 资料 | 与 Conversation 核心模型一致 |
| slash 生成“思维导读” | Artifact 记录 Conversation 产生的物料文件及其格式 | 不需要单独的 SlashCommand 或 AgentRun 实体 |
| 分屏开启演练并回答 | Rehearsal 归属同一 Conversation；RehearsalTurn 保存回答，每个已提交问答对应一份逻辑评估 | 对话与演练并列，不通过 Conversation.mode 互斥；各自状态独立 |
| 看着评估继续提问 | 普通对话可读取已完成的 RehearsalTurn 评估；助手消息记录本次实际使用的轮次和资料引用 | 需要可追溯的消息上下文引用，避免只依赖“最新状态”而无法说明回答依据 |

## 4. 技术与业务约束

- SQLite 是本地业务权威存储，通过 TypeORM migration 演进；当前连接配置启用 WAL、外键和 busy timeout，关闭 schema synchronize。
- 工作空间是用户数据文件的唯一根目录，包含 SQLite 主库、原始资料、生成物料和持久化派生数据；config.toml 保存在工作空间外的 per-user 配置目录。
- 原始资料与模型文件保存在本地文件系统；SQLite 保存元数据和文件引用。全文及向量索引属于可重建数据，应区分索引代际与业务数据版本。
- Document 通过 isShared 标记是否全局可检索，通过 ConversationDocument 关联一个或多个 Conversation。一个文档可以同时共享并关联 Conversation；关联表达检索上下文，不是用户隔离。
- Conversation 内检索范围 = 全局共享资料 + 当前 Conversation 资料 + 用户显式选择的子集 + 当前 Conversation 内相关对话和演练评估。不同 Conversation 的私有资料不得因共享库检索而混入。
- “共享”代表跨 Conversation 可检索，不代表内容天然正确或可信。引用仍需保留文档版本和页码/章节等定位；外部资料仍按不可信内容处理。
- 对话和演练是同一 Conversation 下可并行的活动。Conversation 不设互斥的 Learn/Rehearse mode；Message、Rehearsal、RehearsalTurn 各自维护所需状态。
- 每轮只保留一份当前评估内容。网络重试更新同一 RehearsalTurn，不重复创建轮次；失败重试与人工重评需分开定义。
- 助手消息需记录回答时实际采用的上下文来源，包括相关 RehearsalTurn 和检索到的文档分片。模型运行中新增的评估不追溯性地改写已有回答上下文。
- 可重试副作用通过唯一键或条件状态转换保护。外部 LLM 调用和长时间 Worker 计算不放在 SQLite 写事务中。
- 全文与向量索引在同一代际完成验证后才切换为可查询；失败时保留上一代或明确标记不可用。

## 5. 核心实体候选

| 责任域 | 候选实体 | 主要责任 |
|---|---|---|
| 个人学习 | Conversation | 学习主题/目标、生命周期、创建与结束时间；关联本次学习中的记录 |
| 对话 | Message | Conversation 中按顺序发生的教师与 Agent 消息、生成状态和必要上下文引用 |
| 演练 | Rehearsal、RehearsalTurn | Conversation 中独立运行的演练状态机、问题、已提交回答及轮次顺序 |
| 学习物料 | Artifact | 记录 Conversation 产生的笔记、摘要、解释稿、思维导读等物料；当前不单独保存物料版本历史 |
| 资料与检索 | Document、DocumentVersion、DocumentChunk、ConversationDocument | 原始资料引用、共享标记、Conversation 关联、内容版本和可定位分片 |

以上名称是候选边界，不预先规定每个实体最终对应一张表。当前阶段不建立课程、班级、课次、通用 TeachingContext 或多态上下文框架。

候选字段和通用字段见[数据表字段草案](data-model-fields.md)。Job、AgentRun、ToolExecution、AgentEvent 等平台运行表不属于当前最小业务对象集；异步任务恢复需求确认后再单独设计。

## 6. 候选关系

| 主体 | 关系 | 说明 |
|---|---|---|
| Conversation → Message | 一对多 | 一个 Conversation 包含多条学习对话 |
| Conversation → Rehearsal → RehearsalTurn | 一对多 | 一个 Conversation 可包含多次演练；每轮直接保存问题、回答和评估 |
| Conversation → Artifact | 一对多 | 学习物料从 Conversation 产生，由 Artifact 直接记录 |
| Document → DocumentVersion → DocumentChunk | 一对多 | 分片必须回溯到具体版本及页码/章节等原文定位 |
| Conversation ↔ Document | 多对多 | ConversationDocument 记录会话资料关联；共享资料不复制到每个 Conversation |
| Message.contextRefsJson | 嵌入式元数据 | 记录生成该回复时实际使用的 RehearsalTurn 和文档分片引用，不建立独立引用实体 |

共享文档由全局标记直接查询，不建立 Conversation 到每个共享文档的复制关联。ConversationDocument 只记录显式会话关联。同一文档可以同时进入共享范围和一个或多个 Conversation。

## 7. 完整性与生命周期规则

- 演练必须由用户显式开始。Rehearsal 有独立状态；Conversation 的生命周期不能代替演练状态机。
- 每轮的主要业务内容为问题、回答和评估。评估直接保存在 RehearsalTurn 中，当前阶段不拆独立 Assessment 或 AssessmentEvidence 实体。
- 每次回答保存 request_id、提交时间和必要的处理状态。对同一回答的网络重试不得生成重复轮次；评估重试更新同一轮记录。
- 同一轮仅保留一份当前评估内容；历史重评版本当前不建模，后续如有明确需求再讨论。
- 退出时先持久化演练终态；迟到的模型结果不能再写入评估或下一题。已提交回答保留，未提交草稿不作为评估证据。
- 对话请求开始时读取相关 RehearsalTurn 中已完成的评估，并把实际采用的轮次 ID 写入助手消息的上下文元数据。评估完成后启动的对话可以读取新结果；生成中的回复维持原上下文引用。
- Artifact 直接记录当前物料文件及格式；当前不保存物料历史版本。若后续需要版本比较或恢复，再迭代增加相应设计。
- Conversation 的用户界面可以并列呈现对话与演练；布局属于界面状态，不要求业务模型设置互斥模式。用户退出重开后是否恢复分屏由前端持久化需求决定。
- 外部文件与 SQLite 无法原子提交。导入、删除、备份和恢复需定义暂存、引用登记、孤儿文件清理及一致性检查。

## 8. 当前实现状态与迁移影响

截至本草案编写时，后端代码已存在 courses 表、CourseEntity 和课程接口；数据库迁移尚未包含本草案列出的 Conversation、对话、演练、资料或物料模型。

courses 当前是已有原型实现，不是本草案的目标实体。将其从代码和数据库中实际移除属于后续实现与迁移工作；必须先决定现有课程记录是否可删除、导出或转换，不能由文档变更隐式删库。

## 9. 待决定事项

| 问题 | 当前处理建议 |
|---|---|
| Conversation 是短暂一次活动还是可持续学习线索 | 本草案按可持续线索设计；单次 Agent Run 独立记录 |
| 一个 Conversation 可否同时存在多个活动演练 | 首期建议同一 Conversation 最多一个进行中 Rehearsal；普通对话可与它并行 |
| 每个回答是否允许人工重评 | 当前按一次最终评估建模；如需重评，显式区分重评与网络重试 |
| 共享文档是否默认参与所有 Conversation 检索 | 当前假设默认参与，用户可按请求缩小到选中文档 |
| ConversationDocument 删除与资料复用 | 资料可被多个 Conversation 关联，也可全局共享；确定解除关联或删除 Conversation 时是否保留资料文件 |
| 物料历史版本 | 当前不单独建模；如后续需要比较或恢复旧物料，再迭代设计 |
| 思维导读内容格式 | 当前由 Artifact 记录物料格式和文件路径；具体内容格式随实现支持情况确定 |
| 回复上下文引用的结构 | 字段草案采用助手消息的 contextRefsJson；实现前确认引用格式与定位字段 |
| 长期记忆建模 | 需求保留在产品需求文档中；当前阶段不定义实体或实现方式，后续单独讨论 |
| 上游资料同步 | PRD、功能设计、架构草案与原型仍含旧实体及互斥模式；需另行安排范围同步 |

## 10. 当前阶段明确排除

本阶段不设计 Course、Class、Lesson、LessonClass、DeliveryRecord、课程/课次工作区、courseId/lessonId 检索过滤、长期记忆及其来源/能力状态实体、跨 Conversation 记忆提取与检索、互斥 Learn/Rehearse 会话模式、通用活动超表、用户/教师账号、用户认证授权、跨用户数据隔离、云端同步、独立数据库服务、Redis 队列或独立向量数据库。

如果未来出现明确需求，应以新的用户目标重新评审数据责任边界；本草案不预留 nullable FK 或通用上下文层作为扩展占位。

