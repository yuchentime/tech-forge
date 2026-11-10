---
status: reviewed
layer: change
review_type: design_review
created_at: 2026-11-10
design_path: docs/changes/2026-11-10-conversation-knowledge-facts/design.md
verdict: PASS
confirmation_status: pending_confirmation
---

# Design Review: 会话知识掌握事实

## Summary

| Field | Value |
|---|---|
| Design | `docs/changes/2026-11-10-conversation-knowledge-facts/design.md` |
| Verdict | PASS |
| confirmation_status | pending_confirmation（新增 AC 待用户确认，不冒充确认） |
| DESIGN_REVIEW_PASS | passed |

本轮是同会话技术复核，非独立模型评审；直接检查源码、迁移注册、模块依赖、HTTP 认证和测试脚本，不以先前设计描述替代代码证据。PASS 表示修订后的方案可进入实施准备，不代表代码已实现或测试通过。AC 确认另见 verification.md。

本轮独立文档验证：

- 使用 Draft202012Validator 检查 api-schema.json 元结构，开启 format 校验；9 个正例、4 个反例通过（状态组合、首次空值、超长摘要、非法等级、completed 无成功时间、证据不足却有等级）。
- 新目录相对链接检查与 git diff --check 通过；没有运行应用测试或真实 provider 验收。
- 通用文档检查器报告 3 个错误、23 个警告，其中 2 个错误来自既有 review index，新增 1 个来自本次 reviews/index.md。检查器代码只豁免 design-review.md，却拒绝技能模板要求的 reviews/index.md，是模板/检查器不一致；保留规范要求的索引，不改技能工具、不伪装全库通过。本次路由预算无警告。

## Scope Anchor

- Original ask：每会话一条掌握事实，报告完成后异步更新；按时间解释多次演练；超预算可使用旧事实+最近 N 次+本次；不用版本号、来源清单或尝试次数。
- Design goals in scope：简化表、后端只读查询、串行生成和持久化重跑、证据规则和失败保留。
- Design items outside ask (if any)：无新增前端、知识点库、多进程或跨会话画像；预算回调和 5 秒扫描属于必要技术细化。

## Dimensions

### Complexity — Architecture

| Check | Result | Notes |
|---|---|---|
| Scope matches Goals/Non-Goals | pass | 保持后端边界，不接管工作区 knowledge-cards mock |
| No premature new abstraction layer | pass | 服务/controller/worker 放现有 rehearsals 模块，不加通用任务框架 |
| No speculative generalization | pass | 只服务事实归纳；generate 新增可选预算入口保持旧字符串调用 |
| Cross-cutting surface growth justified | pass | 报告事务、删除清理、LLM 预算均是正确性边界 |
| Operational weight justified | pass | 无外部队列；单个后台 worker + pending 扫描 |
| Alternatives Considered includes a simpler option | pass | 明确否决多表/版本字段；状态协议已给出 |
| Touch/complexity budget reasonable | pass | 不改前端；业务表一张，新增查询一个，三个已有业务落点 |

### Complexity — Data Model

| Check | Result | Notes |
|---|---|---|
| New tables justified vs reuse | pass | 会话派生事实与多次演练报告生命周期不同 |
| Alterations / migrations scoped | pass | 一表、主键/外键、状态索引；不改原报告枚举 |
| Cross-domain FK / shared tables justified | pass | 只关联 Conversation，删除沿用原事务显式清理 |
| Rollback / backfill cost acceptable | pass | 无回填；down 仅删除派生表；重新升级按下次事件生成 |
| No speculative schema for unused futures | pass | 用户删掉四字段未加回；不建立统一知识点表 |

### Verification — Acceptance Criteria

| Check | Result | Notes |
|---|---|---|
| AC 存在且编号连续 | pass | AC-01–12 |
| AC 代码接地 | pass | 现有 finishRehearsal/end/answer/skip、generate、deleteConversation、main.ts；拟新增能力明确标记 |
| AC 可判定 | pass | 状态、返回码、条件更新、空值、事务与失败均有反例 |
| AC 粒度合适 | pass | 按关键边界划分，不逐函数伪代码化 |
| 与 design.md 目标对应 | pass | 时序、预算、模型质量、状态恢复、查询均覆盖 |
| Must-Not-Break 业务语义保留 | pass | 报告、digest、历史、transcript、删除保留 |

### Consistency And Runtime Boundaries

| Check | Result | Notes |
|---|---|---|
| No-version lost-update protocol | pass | worker 排他；事务领取/读取；新报告置 pending；旧任务仅 running 条件更新 |
| Durable recovery | pass | running 启动恢复为 pending，提交后失唤醒由扫描补偿，failed 不无限重试 |
| Model selection and budget | pass | 修订为同一次模型解析后构造；修复指令计预算；未知窗口/必保留超限明确失败 |
| Delete race and dependency direction | pass | 删除不反向调用服务；worker 只 UPDATE，行消失即放弃，不 upsert |
| Local HTTP boundaries | pass | 认证 401、Origin 403、UUID 400、无会话 404；不新增账号 |

## Findings

### Over-design / risk findings

- KF-001（已修订）：预算先读取配置再调用 generate 会存在模型变化窗口，且当前 generate 无可用的外部预算回调。设计现明确新增同次模型绑定的可选输入构造入口，旧调用不变。
- KF-002（已修订）：原设计“尽力取消”可能促成 ConversationsModule 反向依赖 RehearsalsModule。改为删除只清表，worker 校验存在性及条件 UPDATE；不为取消追加模块循环。
- KF-003（已修订）：原 API 未写出 Origin 403、首次与旧事实空值规则。现已提供字段契约与机器可读响应 schema。
- KF-004（已修订）：现有 parseReportResponse 会过滤部分非法条目，不能直接复用为事实严格校验器。验收明确独立校验，拒绝后再有限修复。
- 剩余固有限制：模型语义归并、截断误判延续、无精确输入版本、多进程不支持均已在 design 风险中明示，属于已选简化方案的边界；真实 provider 验收不能由本轮文档核验替代。

### Suggested cuts (thinner design)

- 不加任务表、版本字段、独立知识点表和通用调度总线。
- 删除路径不增加服务级取消回调；迟到结果条件更新足以保障不复活。
- 全局一个事实 worker 即可，暂不实现可配置并发池。

### Worth keeping (surprising but justified now)

- pending 在生成中可再次落库：没有版本字段时，这是防止重启丢失新事件的必要信号。
- 仅 running 才能发布：同时约束成功和失败路径，不能只防旧成功覆盖。
- API 保留 generatedAt 与 generationStatus：允许“上次有成功事实，但当前更新失败”的真实状态。

## Developer Decision

- Decision: pending（仅新增验收标准确认；需求评审已于 2026-11-10 确认）
- Reason / accepted cuts: 保留用户已确认的简化表与截断方案；本轮未代签新的验收标准。
- Confirmed at: pending

## Gate

| Gate | Result | Notes |
|---|---|---|
| DESIGN_REVIEW_PASS | passed | 本轮技术复核 PASS；AC 确认仍 pending，未开始编码 |
