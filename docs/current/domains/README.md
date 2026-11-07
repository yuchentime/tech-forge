---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - current-domain-doc-organization
related:
  - docs/README.md
  - docs/current/platform/index.md
last_verified: 2026-11-08
---

# 当前业务域文档

在此按业务责任建立 `docs/current/domains/<domain>/index.md` 和必要的行为、数据、API 文档。一个目录对应稳定业务责任；不要按前端/后端技术目录重复切分同一流程。

当前业务 Service 多数仍是空壳，且既有 Course 原型与目标数据模型冲突。Conversation/Message 已接入 Agent 对话持久化、列表和消息历史查询，详见[业务事实](conversations/index.md)、[行为](conversations/backend-behavior.md)与[接口契约](conversations/api-contract.md)。本机模型与风格设置、Agent workspace 默认输出目录及文件读写边界已实现，见[系统设置事实](system-settings/index.md)和[Agent Runtime](../platform/agent-runtime.md)。其他业务仍只在流程经代码实现并核对后建立当前业务事实页；实施目标仍放在 `source/` 或正式 change 中。
