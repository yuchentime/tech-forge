---
status: accepted
layer: decision
domain: knowledge-retrieval
decided_at: 2026-11-08
canonical_for:
  - knowledge-retrieval-platform-choice
related:
  - docs/current/domains/documents/index.md
  - docs/current/domains/retrieval/index.md
  - docs/changes/2026-11-08-knowledge-retrieval/design.md
last_verified: 2026-11-08
---

# ADR: 知识库检索走全本地实现

## 决策

TeachForge 的知识库检索全部在本地实现，不引入托管检索服务，也不把 LLM wiki 作为知识存储：

1. 文本层解析 + 本地分块（500 embedding tokens，10% 重叠）。
2. 词法索引 `SQLite FTS5`（中文按 bigram 归一化，英文整词 + porter 词干化）。
3. 向量索引：`bge-small-zh-v1.5` q8（512 维）经 `@huggingface/transformers` 在进程内推理，模型随仓库分发。
4. 双通道以 RRF（k = 60）融合；可选模型查询扩展只在词法零命中时触发。

## 背景

应用是单用户、本地优先的教师学习平台，资料多为中文 PDF/讲义。检索需要满足：资料正文不出本机、Windows 桌面直接安装、可引用到页/节、索引可重建。

## 备选方案

| 方案 | 否决理由 |
|---|---|
| Supermemory 托管 | 资料正文离开本机，引入第二套远程事实源 |
| Supermemory 自托管 | Windows 原生仅 0.0.8（无 v5 API、绑定全网卡），v5 需 Docker Linux 容器；二进制闭源、遥测默认开启；embedding 维度锁死；引用粒度只到 chunk |
| LLM wiki 作为知识存储 | 不替代检索（仍需原文索引），新增第二套事实源与漂移/去重/重编译成本 |
| 仅 FTS5 | 换说法提问召回不足 |
| 仅向量 | 术语、人名、公式等精确命中弱；中文分词问题不可控 |
| `sqlite-vec` | 当前规模暴力扫描 8.6 ms/10k chunk，ANN 无收益却多一个按平台分发的原生扩展 |
| 云端 embedding / 云端 rerank | 需网络与第三方账号，正文或查询出本机 |
| MinerU 作为默认解析器 | 组件 1.5–2.5 GB、AGPL-3.0、Python 冷启动；当前目标用户的 PDF 以文本层为主 |

## 后果

- 断网可用；除「查询扩展」这一可选外呼外，检索链路不联网，且扩展只发送查询文本、不发送资料正文。
- 分片预算以 token 计，避免超过模型 512 窗口被静默截断。
- 换 embedding 模型必须整库重嵌；因此不提供模型选择入口，也用行级模型戳记隔离不同模型的向量。
- 中文单字查询无法由 bigram 索引回答，需子串扫描兜底（已实现）。
- 检索质量阈值（0.55 相似度下限、RRF 参数、扩展触发点）目前来自小样本实测，尚未用 gold set 标定。

## 复核触发条件

- 资料量增长到十万级分片、检索 P95 超过 100 ms：重新评估 `sqlite-vec` 或 ANN。
- 中文召回在 gold set 上持续不达标：评估更换 embedding 模型（含整库重嵌成本）。
- 解析质量成为主要瓶颈（扫描件占比升高、表格/公式还原不满足）：评估启用 MinerU 组件。
- 出现跨设备或多实例需求：重新评估是否引入服务端检索。
