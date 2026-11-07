---
status: current
layer: platform
domain: documentation-runtime
canonical_for:
  - documentation-structure
related:
  - docs/index.md
  - docs/manifest.yaml
last_verified: 2026-11-06
---

# TeachForge 文档运行库

`docs/` 为开发者和 coding agent 提供可路由的项目上下文。根目录 [AGENTS.md](../AGENTS.md) 说明项目约定并指向本目录；本目录集中维护当前实现事实、设计输入和工程执行记录。

## 文档树

```text
docs/
  README.md                  文档分层和维护约定
  index.md                   人工入口
  manifest.yaml              Agent Runtime 任务路由
  source/                    原始需求、设计输入和未定稿草案
  current/
    platform/                当前运行架构和平台事实
    domains/                 当前业务域行为和责任
    shared/                  跨领域约定
    rules/                   稳定工程规则
  changes/                   复杂任务的设计、执行与评审记录
  decisions/                 已接受的长期技术/产品权衡
  postmortems/               故障复盘、经验索引与防复发护栏
  archive/                   已被替代的材料和历史参考
  evals/                     验收与回归检查清单
  templates/                 项目专用文档模板
  scripts/                   项目专用文档工具
```

## 信息状态

- `current/` 描述经代码或运行证据核对的当前事实，以及明确的放置规则。
- `source/` 保留来源材料和候选方案。其目标能力不能自动当作已实现事实。
- `changes/` 服务于多阶段、跨模块或需要正式设计/评审的任务，不替代 `current/`。
- `decisions/` 记录已接受且需要长期追踪的权衡；单纯建议或待决项留在 `source/` 或对应 change。
- `postmortems/` 保存已验证故障的根因与复用经验，并链接到当前规则或自动验收护栏。
- `archive/` 保存被替代但仍有追溯价值的材料。归档前更新索引和替代关系。
- `evals/` 放可复用的验收清单；功能特定的验收标准放在对应 change。

## 维护流程

1. 从 [文档入口](index.md) 和 [Agent 路由](manifest.yaml) 找到责任单元，再读最小必要上下文。
2. 新设计先归入 `source/`；实施后依据代码更新对应 `current/`，保留清楚的目标与现状差异。
3. 跨模块或多轮工作在 `changes/YYYY-MM-DD-<slug>/` 建立记录；完成后把稳定事实同步到 `current/`。
4. 仅在权衡已接受且长期有效时新增 ADR；不要把尚未决定的选项写成当前规则。
5. 更新文档时同时维护对应索引和 `manifest.yaml` 路由，并核对相对链接。

新增 Markdown 页面使用 YAML frontmatter，至少标明 `status`、`layer`、`domain`、`canonical_for`、`related` 和 `last_verified`。当前文档力求单一责任、可直接导航；健康长度不超过 200 行。
