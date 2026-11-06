# TeachForge 数据表字段草案

- 状态：候选字段设计，尚非实现基线
- 更新日期：2026-11-06
- 适用范围：[个人学习数据建模草案](data-model-design.md)

## 1. 字段与通用字段约定

下表是支持当前用户闭环的最小候选字段。它描述逻辑字段，不代表已经创建数据库表或 migration。

| 类型      | 约定                                               |
| ------- | ------------------------------------------------ |
| 表名      | 小写复数形式，如 conversations；沿用当前项目表名风格                |
| 列名      | camelCase，和现有 TypeORM 实体保持一致                     |
| 主键      | 实体表使用 id，SQLite TEXT/VARCHAR，应用生成 UUID；关联表可用复合主键 |
| 时间      | DATETIME，统一按 UTC 保存；createdAt 必填，默认当前 UTC 时间     |
| 更新时间    | updatedAt 只用于可变记录；不可变版本/分片只保留 createdAt          |
| 可空字段    | 尚未完成或当前业务不一定产生的内容使用 NULL，不填空字符串代替                |
| JSON 内容 | 存 TEXT，由应用校验结构；只用于变化较大的消息块、评估或定位数据               |
| 状态      | 仅有真实生命周期的表才设 status；数据库存字符串，当前状态值由应用校验           |

不增加所有表通用的 userId、teacherId、tenantId、createdBy、deletedAt、metadataJson 或 version 字段。删除与保留策略尚未定稿，所以本草案不设软删除，也不预先规定级联删除。

工作空间和模型 Provider 等运行配置保存在工作空间外的 config.toml，不增加设置表；API Key 保存在操作系统安全存储。业务文件路径均相对工作空间根目录。详见[本地系统配置设计草案](system-configuration-design.md)。

## 2. 核心业务表

### conversations — 学习线索

| 字段        | 类型        | 必填  | 说明                  |
| --------- | --------- | ---:| ------------------- |
| id        | TEXT/UUID | 是   | Conversation 标识     |
| title     | TEXT      | 否   | 用户可选名称；不强制学习主题或目标字段 |
| createdAt | DATETIME  | 是   | 创建时间                |
| updatedAt | DATETIME  | 是   | 最近一次业务内容更新时间        |

不设置 mode、endedAt 或必须完成状态。教师可自行停止或继续，结束准备不触发系统门槛。

### messages — 普通对话消息

| 字段              | 类型        | 必填  | 说明                                                         |
| --------------- | --------- | ---:| ---------------------------------------------------------- |
| id              | TEXT/UUID | 是   | 消息标识                                                       |
| conversationId  | TEXT/UUID | 是   | 所属 Conversation                                            |
| sequenceNo      | INTEGER   | 是   | Conversation 对话中的顺序                                        |
| role            | TEXT      | 是   | 当前使用 user 或 assistant                                      |
| contentJson     | TEXT      | 是   | 文本及结构化内容块；物料链接存 Artifact ID                                |
| status          | TEXT      | 是   | 生成状态；用户消息创建时为 completed                                    |
| requestId       | TEXT      | 否   | 客户端请求幂等键；仅需要防重复提交时提供                                       |
| contextRefsJson | TEXT      | 否   | 本次回复实际使用的 RehearsalTurn、DocumentVersion/Chunk、Artifact 及定位 |
| createdAt       | DATETIME  | 是   | 消息创建时间                                                     |
| updatedAt       | DATETIME  | 是   | 流式生成状态或内容的最后更新时间                                           |

### rehearsals — 一次演练/一批提问

| 字段             | 类型        | 必填  | 说明              |
| -------------- | --------- | ---:| --------------- |
| id             | TEXT/UUID | 是   | 演练标识            |
| conversationId | TEXT/UUID | 是   | 所属 Conversation |
| status         | TEXT      | 是   | 当前演练生命周期状态      |
| startRequestId | TEXT      | 否   | 开始请求的幂等键        |
| startedAt      | DATETIME  | 否   | 实际开始时间          |
| endedAt        | DATETIME  | 否   | 完成或退出时间         |
| createdAt      | DATETIME  | 是   | 创建时间            |
| updatedAt      | DATETIME  | 是   | 最近一次状态更新时间      |

当前候选是每次重新生成一批问题就创建新的 Rehearsal，并保留历史演练；若后续把“一批问题”定义为同一演练内的子阶段，再调整关系。状态值先由应用维护，不在数据库添加封闭枚举约束。

### rehearsal_turns — 演练轮次

| 字段              | 类型        | 必填  | 说明                     |
| --------------- | --------- | ---:| ---------------------- |
| id              | TEXT/UUID | 是   | 轮次标识                   |
| rehearsalId     | TEXT/UUID | 是   | 所属演练                   |
| sequenceNo      | INTEGER   | 是   | 演练内顺序                  |
| question        | TEXT      | 是   | 本轮问题                   |
| answer          | TEXT      | 否   | 用户提交的回答；回答前为空          |
| evaluationJson  | TEXT      | 否   | 本轮唯一的当前评估；评估结构暂不固定     |
| status          | TEXT      | 是   | 轮次处理状态，如等待回答、评估中、完成、失败 |
| answerRequestId | TEXT      | 否   | 回答提交幂等键                |
| askedAt         | DATETIME  | 是   | 问题生成时间                 |
| answeredAt      | DATETIME  | 否   | 回答提交时间                 |
| evaluatedAt     | DATETIME  | 否   | 评估完成时间                 |
| createdAt       | DATETIME  | 是   | 记录创建时间                 |
| updatedAt       | DATETIME  | 是   | 本轮最近一次更新时间             |

问题、回答、评估是主要业务内容。Assessment 和 AssessmentEvidence 不拆表；对同一轮重试时更新该行，暂不保存独立评估历史。

### documents — 资料身份

| 字段        | 类型              | 必填  | 说明                               |
| --------- | --------------- | ---:| -------------------------------- |
| id        | TEXT/UUID       | 是   | 资料标识                             |
| title     | TEXT            | 是   | 应用中显示的名称                         |
| isShared  | INTEGER/BOOLEAN | 是   | 是否可在所有 Conversation 中检索；默认 false |
| createdAt | DATETIME        | 是   | 加入本地资料集合的时间                      |
| updatedAt | DATETIME        | 是   | 名称或共享状态最近更新时间                    |

共享知识库由 isShared=true 的资料构成，不单独建 KnowledgeBase 表。共享标记表示检索范围，不代表内容已被验证。

### document_versions — 资料文件版本

| 字段                    | 类型        | 必填  | 说明                                       |
| --------------------- | --------- | ---:| ---------------------------------------- |
| id                    | TEXT/UUID | 是   | 不可变资料版本标识，供引用定位                          |
| documentId            | TEXT/UUID | 是   | 所属资料                                     |
| versionNo             | INTEGER   | 是   | 资料内递增版本号                                 |
| originalName          | TEXT      | 是   | 上传时的文件名                                  |
| mimeType              | TEXT      | 是   | 文件类型                                     |
| workspaceRelativePath | TEXT      | 是   | 相对工作空间根目录的路径，例如 documents/originals 下的文件 |
| byteSize              | INTEGER   | 否   | 文件字节数                                    |
| contentHash           | TEXT      | 否   | 完整性校验值；暂不作为强制去重键                         |
| processingStatus      | TEXT      | 是   | 当前解析/索引总状态                               |
| processingError       | TEXT      | 否   | 最近一次处理错误摘要                               |
| createdAt             | DATETIME  | 是   | 版本登记时间                                   |
| updatedAt             | DATETIME  | 是   | 处理状态最近更新时间                               |

新文件版本产生新 id，不覆盖旧版本；引用使用 documentVersionId，保证内容更新后历史来源仍可定位。

### conversation_documents — Conversation 资料关联

| 字段             | 类型        | 必填  | 说明                     |
| -------------- | --------- | ---:| ---------------------- |
| conversationId | TEXT/UUID | 是   | Conversation 标识        |
| documentId     | TEXT/UUID | 是   | 资料标识                   |
| addedAt        | DATETIME  | 是   | 资料加入该 Conversation 的时间 |

conversationId + documentId 作为复合主键。同一资料可以被多个 Conversation 使用，也可以同时设为共享资料；上传入口只负责创建资料版本并建立关联。

### document_chunks — 可引用资料分片

| 字段                | 类型        | 必填  | 说明                     |
| ----------------- | --------- | ---:| ---------------------- |
| id                | TEXT/UUID | 是   | 分片标识                   |
| documentVersionId | TEXT/UUID | 是   | 来源资料版本                 |
| sequenceNo        | INTEGER   | 是   | 版本内分片顺序                |
| content           | TEXT      | 是   | 可检索文本                  |
| locatorJson       | TEXT      | 否   | 页码、章节、URL 片段或字符偏移等来源定位 |
| createdAt         | DATETIME  | 是   | 分片生成时间                 |

Embedding 不存入通用分片字段；FTS 和向量索引属于可重建索引数据。

### artifacts — 产出物料

| 字段                    | 类型        | 必填  | 说明                         |
| --------------------- | --------- | ---:| -------------------------- |
| id                    | TEXT/UUID | 是   | 物料标识                       |
| conversationId        | TEXT/UUID | 是   | 首次生成它的 Conversation        |
| contentFormat         | TEXT      | 是   | 源内容格式，如 json、markdown、html |
| fileName              | TEXT      | 是   | 文件名                        |
| workspaceRelativePath | TEXT      | 是   | 相对工作空间根目录的物料文件路径           |
| mimeType              | TEXT      | 否   | MIME 类型，例如 application/pdf |
| fileHash              | TEXT      | 否   | 文件完整性校验值                   |
| createdAt             | DATETIME  | 是   | 首次创建时间                     |
| updatedAt             | DATETIME  | 是   | 文件或物料信息最近更新时间              |

contentFormat 和 mimeType 以字符串保存，应用按已支持的格式处理；不为每种产物单建表。workspaceRelativePath 保存相对工作空间根目录的物料文件路径。当前 Artifact 直接指向物料文件，不拆版本表；如后续需要比较或恢复旧物料，再迭代设计。

## 3. 最小索引与唯一性

| 表                      | 必要索引/约束                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| messages               | 唯一 (conversationId, sequenceNo)；按 conversationId + createdAt 查询                            |
| messages               | requestId 有值时按 conversationId + requestId 防止重复写入                                           |
| rehearsals             | 按 conversationId + createdAt 查询；startRequestId 有值时按 conversationId + startRequestId 防止重复创建 |
| rehearsal_turns        | 唯一 (rehearsalId, sequenceNo)；answerRequestId 有值时防止重复提交                                     |
| document_versions      | 唯一 (documentId, versionNo)                                                                 |
| conversation_documents | 复合主键 (conversationId, documentId)                                                          |
| document_chunks        | 唯一 (documentVersionId, sequenceNo)                                                         |
| artifacts              | 按 conversationId + createdAt 查询                                                            |
| documents              | 为 isShared 建索引；按共享资料和 Conversation 关联组合检索                                                  |

SQLite 外键启用。各外键的删除行为待资料保留规则明确后再定，不在此阶段使用级联删除假设。状态值由应用层校验，不添加妨碍扩展的封闭 CHECK 列表。

## 4. 暂不纳入本轮字段设计

- 长期记忆、Concept/ConceptRelation、能力投影、跨 Conversation 记忆实体。
- Assessment、AssessmentEvidence、ArtifactVersion 独立表。
- 通用 AgentRun、ToolExecution、AgentEvent 表；对话生成状态和演练轮次状态先保存在所属业务记录。
- Job 表的租约、重试和恢复字段。若实现阶段确认文档处理/文件生成必须在崩溃后恢复，再单独设计后台任务数据表。
- 通用 userId、tenantId、createdBy、deletedAt、通用 metadataJson。

上述省略不改变产品需求文档中保留的长期记忆目标；它们不属于当前闭环所需字段。
