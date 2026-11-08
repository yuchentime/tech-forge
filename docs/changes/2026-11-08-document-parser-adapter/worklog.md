# Worklog: document-parser-adapter

| Loop | 本轮目标 | 主要改动 | 验证结果 | 评审结论 | 下一轮动作 | 风险/待评估点 | Commit | Re-anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L001 | 固化解析能力边界与打包方式 | 产出解析适配层设计：MinerU sidecar、DeepSeek Vision、格式路由与错误码 | 设计阶段，无运行验证 | `pending review` | 评估体积与许可成本 | 组件 1.5–2.5 GB、AGPL-3.0、Windows 需 Docker 的风险在后续轮次改变结论 | n/a | n/a |
| L002 | 用真实中文样本确定 v1 解析形态 | 改为文本层方案：`pdfjs-dist` + `mammoth`；契约改为按页返回 `pages[]`；补充 TOC/双栏/表格/伪标题规则 | 313 页中文 PDF 2.3 s / 508,303 字符；50 KB DOCX 103 ms / 29,737 字符；cmaps 在本样本无差异（推翻旧推断） | `pending review` | 落实实现与 conformance 用例 | 提取质量上限由源文件决定（实测源 PDF 缺字） | n/a | n/a |
| L003 | 实现适配层并接入 PlatformModule | 新增 `platform/document-parser/`（types、registry、service、module、三个 parser、ESM 加载器）；`PlatformModule` 装配；新增两套 npm 脚本 | 8/8 conformance 通过；Nest DI 冒烟通过；两个真实样本冒烟通过 | `pending review` | 同步当前架构文档与变更索引 | 运行中的 dev backend 锁住 `dist`，测试改用 `.test-dist` 隔离编译 | n/a | n/a |
