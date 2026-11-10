---
status: current
layer: platform
domain: documentation-entry
canonical_for:
  - documentation-routing
related:
  - docs/current/platform/index.md
  - docs/source/index.md
last_verified: 2026-11-10
---

# TeachForge 工程文档入口

## 当前事实

- [当前实现文档索引](current/index.md)：平台架构、业务域文档、跨领域约定和工程规则。

## 设计输入与草案

- [架构与设计草案索引](source/index.md)：产品、后端架构、数据模型和本地配置设计材料。草案表达目标或候选决策，不自动代表代码已实现。

## 工程记录

- [复杂变更工作流](changes/README.md)：何时建立正式变更记录，以及变更目录的生命周期。
- [已接受决策索引](decisions/index.md)：长期有效的已接受权衡。
- [故障复盘与复用经验](postmortems/index.md)：运行失败的证据、根因及防复发验收。

- [会话知识掌握事实](changes/2026-11-10-conversation-knowledge-facts/design.md)：演练后异步维护会话当前掌握情况；自动化 L1/L2 已实现，真实 provider 语义验收待补。
- [会话知识掌握卡片实施记录](changes/2026-11-10-knowledge-session-cards/design.md)：卡片列表读取轻量 facts 集合，详情在用户打开时单独读取。
- [`/探索主题` 斜杠命令](changes/2026-11-10-deep-research-command/design.md)：固定先检索知识库，再用内置 skill 生成知识文档与 SVG 知识地图。
