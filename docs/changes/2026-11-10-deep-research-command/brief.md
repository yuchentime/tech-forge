---
status: current
layer: change
domain: deep-research
created_at: 2026-11-10
---

# `/探索主题` 斜杠命令 Brief

## Problem

教师需要把零散的资料整理成可直接备课的知识文档，并希望一眼看到知识结构。当前只有 `/查询资料库`：

- 它把检索结果注入普通问答，模型可能只回答一个问题，不会产出可复用的文档或图。
- 普通对话虽然可以写文件，但没有固定流程，输出结构、证据标注和 SVG 质量都不稳定。
- 项目已支持 Pi Skill 装载（`additionalSkillPaths`），但没有面向产品的内置 skill，也没有命令路由到它。

## Decision / Scope

1. 输入框输入 `/` 增加第二条命令「探索主题」。选择后命令以标签挂在输入区，用户再输入主题；发送时适配器拼回 `/探索主题 <主题>`。
2. 后端把 `/探索主题` 视为**固定流程开关**：
   - 先从会话资料范围检索知识库，和 `/查询资料库` 使用同一套分片、重排、去重与注入位置；
   - 再用 Pi 原生 `/skill:deep-research` 展开内置 skill，把资料上下文和用户主题作为参数交给同一个普通对话 Agent。
3. 不为探索主题新建 Agent、状态机或数据库表。skill 只提供工作流提示词，仍使用现有 `read`/`write`/`edit`/`grep` 工具。
4. 产物固定为会话工作区内的两个文件：
   - `deep-research/<slug>/知识文档.md`
   - `deep-research/<slug>/知识地图.svg`
   两个文件由现有 artifact 索引登记，出现在响应底部文件卡片和右侧文件侧边栏。
5. 内置 skill 的源模板随 backend 分发（`apps/backend/assets/skills/deep-research`），首次 session 创建前安装到 `<configDir>/skills`（默认 `~/.tech-forge/skills`），与用户自建 `<workspace>/skills` 并列加载。已存在的 `SKILL.md` 不被覆盖，用户可直接编辑安装后的文件。
6. 两个命令可以组合，顺序不限；`/探索主题` 始终隐含检索。

## Out Of Scope

- 联网检索、论文库、WebFetch、脚本执行与子 Agent。当前运行时没有这些工具，探索主题只以本地资料库和模型背景知识为证据，并对无证据内容明确标注。
- 新增探索主题会话列表、任务队列、进度页或后台任务。一次探索主题就是一次普通流式对话轮次；文件写入通过现有工具活动展示。
- 提高检索分片上限、整篇文档注入或知识库目录直读。当前仍使用 `/查询资料库` 的 8 片预算。
- 为探索主题单独建表、建 artifact 类型或特殊预览组件。SVG 继续用现有 `SvgArtifact` 预览。

## Acceptance 概要

- 输入 `/` 出现「查询资料库」「探索主题」两项；选择「探索主题」后标签、图标、占位文案和移除动作正确。
- `/探索主题 主题` 触发一次知识库检索；普通主题不检索、不加载 skill。
- 模型收到的 prompt 以 `/skill:deep-research` 开头，skill 正文被展开，资料块与 `## 用户输入` 作为其参数；入库消息和快照只保留主题。
- skill 缺失时请求以明确错误失败，而不是把 `/skill:...` 原文交给模型。
- 真实轮次产出 `知识文档.md` 与 `知识地图.svg`；文档包含证据与来源表，SVG 自包含且无脚本/外部引用。
- 产物登记为 `session` artifact，而不是 `external`。

## 验证

见 [verification.md](verification.md)。
