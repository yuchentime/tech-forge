---
status: current
layer: change
domain: document-parser-adapter
canonical_for:
  - document-parser-adapter-verification
last_verified: 2026-11-08
version: 1.0
acceptance_review_status: pending review
---

# 文档解析适配层验收

## 验证分层

- **L1 — 局部逻辑**：路由器、路径与签名校验、错误码映射、行/段重建几何、伪标题识别的单元级断言。
- **L2 — 自动化真实联动**：真实 PDF/DOCX 字节经适配层解析；合成 fixture 覆盖多页、双栏、目录、扫描件、表格、损坏文件。
- **L3 — 人工协同**：真实中文讲义/教材的提取质量判断（排版正确性、可用性）。

本变更的实现验收位于 L1/L2；L3 只用于回答"提取结果是否真的可读"，不作为自动化门槛。

## 执行命令

```bash
# L1 + L2（隔离编译到 .test-dist，规避运行中的 dev backend 锁住 dist）
npm run test:document-parser --workspace @teachforge/backend

# L3 冒烟（传入真实文件路径；不写死样本路径，避免把个人资料写进仓库）
npm run verify:document-parser --workspace @teachforge/backend -- <file> [file...]
```

## Acceptance Criteria

### AC-01 格式路由与输入校验

| 要素 | 内容 |
|---|---|
| 代码位置 | `apps/backend/src/platform/document-parser/document-parser.service.ts`、`document-parser.registry.ts` |
| 前置条件 | 任意被调用方给出的临时文件路径与原始文件名 |
| 预期行为 | 扩展名映射到唯一 parser；相对路径、缺失文件、空文件返回 `INVALID_INPUT_FILE`；超过 `maxFileBytes` 返回 `FILE_TOO_LARGE`；`.pdf`/`.docx` 签名不符返回 `UNSUPPORTED_FORMAT`；未知扩展名返回 `UNSUPPORTED_FORMAT` |
| 禁止出现 | 依调用方声明的 MIME 选择解析器；对 `.doc`、图片、PPTX 静默返回空结果 |
| 判定方式 | `test/document-parser.test.cjs` 的 "rejects renamed files, oversized files, relative paths and unsupported types" |

### AC-02 PDF 页级重建

| 要素 | 内容 |
|---|---|
| 代码位置 | `apps/backend/src/platform/document-parser/parsers/pdf-text.parser.ts` |
| 前置条件 | 带文本层的 PDF |
| 预期行为 | `pages[].pageNo` 从 1 连续递增；同页内文本按 (y 降序, x 升序) 重建为行、再按行距聚段；`text` 为 `pages` 拼接 |
| 禁止出现 | 每页只产出一行；跨页合并；给非 PDF 格式产出页码 |
| 判定方式 | 合成两页 PDF 断言页数、页码与行序；真实 313 页教材断言 508,303 字符/2.3 s |

### AC-03 无文本层与目录页的显式语义

| 要素 | 内容 |
|---|---|
| 代码位置 | 同上 |
| 前置条件 | 扫描件 PDF；含点线引导符的目录页 |
| 预期行为 | 全篇无可提取文本时抛 `NO_TEXT_LAYER`；目录页段落产出 `TOC_LIKE` warning 且保留页号 |
| 禁止出现 | 返回空 `text` 的成功结果；静默丢弃目录页而不给标记 |
| 判定方式 | "rejects a PDF without a text layer" 与 "reports a table-of-contents page" |

### AC-04 双栏检测

| 要素 | 内容 |
|---|---|
| 代码位置 | 同上（`detectGutter`） |
| 前置条件 | 页面存在贯穿全文的垂直空白带，且左右各有 ≥30% 的文本项 |
| 预期行为 | 按列优先输出，并产出 `MULTI_COLUMN_SUSPECTED` warning |
| 禁止出现 | 单栏文档被误判为双栏后丢失阅读顺序 |
| 判定方式 | 合成 24 行双栏 PDF 断言 warning 存在 |

### AC-05 DOCX 转换与结构损失可见

| 要素 | 内容 |
|---|---|
| 代码位置 | `apps/backend/src/platform/document-parser/parsers/docx.parser.ts` |
| 前置条件 | 含标题样式、加粗短段落、表格的 docx |
| 预期行为 | 标题保留为 Markdown 标题；加粗短段落提升为 `##` 伪标题；表格数量计入 `UNSTRUCTURED_TABLE` warning；转换消息计入 `CONVERSION_MESSAGE`（上限 5 条） |
| 禁止出现 | 静默丢弃表格而不告警；把长加粗正文误判为标题 |
| 判定方式 | "converts DOCX, promoting bold-only headings and flagging flattened tables"；真实 50 KB 文档断言 18 个表格与 142 个标题 |

### AC-06 超时与取消

| 要素 | 内容 |
|---|---|
| 代码位置 | `document-parser.service.ts`（`runWithLimits`） |
| 前置条件 | 调用方传入已 abort 的 signal；或解析超过 `timeoutMs` |
| 预期行为 | 分别返回 `PARSER_CANCELLED` / `PARSER_TIMEOUT`；解析器收到的是组合后的 signal |
| 禁止出现 | 超时只丢弃结果而不中断解析；取消后仍继续读取后续页 |
| 判定方式 | "honours an already-aborted signal"；超时由注入的 `DOCUMENT_PARSER_LIMITS` 控制 |

### AC-07 依赖注入可用

| 要素 | 内容 |
|---|---|
| 代码位置 | `document-parser.module.ts`、`platform.module.ts` |
| 前置条件 | 仅加载 `DocumentParserModule` 的 Nest 上下文 |
| 预期行为 | 可解析 `DocumentParserService`，`availableParsers()` 返回 `['pdf-text','docx','plain-text']` |
| 禁止出现 | 因 `limits` 可选 token 缺失导致启动失败 |
| 判定方式 | 手工执行的 Nest 上下文冒烟（见下"本轮实测"） |

## 本轮实测（2026-11-08，win32 x64 / Node 25）

| 项目 | 结果 |
|---|---|
| `npm run test:document-parser` | 8/8 通过，452 ms |
| Nest 上下文（仅 `DocumentParserModule`） | DI 通过，parser 列表正确，解析真实 docx 成功 |
| `AI-Agents-in-Depth-zh-CN.pdf`（11 MB / 313 页） | 2,280–2,433 ms，508,303 字符，`TOC_LIKE` × 7 |
| `AI员工平台_作业背景文档_脱敏版_v1.docx`（50 KB） | 103–123 ms，29,737 字符，`UNSTRUCTURED_TABLE` × 1（18 个表格），142 个标题 |

## 已知限制

- 提取质量上限由源文件决定：实测某教材页的文本层本身缺字（同页其他同字正常），适配层不会补齐。
- cmaps 随包但本样本不需要（该 PDF 自带 ToUnicode）；仅有预定义 CJK CMap 的 PDF 仍需另一样本验证。
- 表格只保内容不保行列；升级路径为 `convertToHtml` + 表格转 Markdown，改动限定在 `docx.parser.ts`。
- 未在 Electron `utilityProcess` 内验证（解析器本身无原生依赖，风险点在后续 `onnxruntime-node`）。
