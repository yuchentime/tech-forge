---
status: implemented
layer: change
domain: documents
created_at: 2026-11-08
verified_at: 2026-11-08
updates_current:
  - docs/current/domains/documents/index.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/domains/system-settings/index.md
---

# 知识库管理 Design

## Problem

`DocumentsService.ingestFile()`、`RetrievalService.search()` 与 `search_documents` 工具都已上线，但整条链路没有用户入口：入库只能跑脚本，桌面端看不到已入库资料，也无法删除。本次补齐**知识库管理**这一条业务线：列表、导入、删除。

## Goals

- 侧栏"新建课题"下方新增"知识库"，与"设置"同级复用主区域切换，不新建窗口。
- 通过系统原生文件选择器导入 `pdf / docx / md / markdown / txt`，文件先落到 `config.toml` 的 `[workspace].path`，再调用 `ingestFile` 入库。
- 列表显示标题、原文件名、状态、分片数、版本数、导入时间，支持删除。
- 删除是彻底的：数据库六张相关表 + 两份文件副本 + FTS 索引全部清除，检索不再命中。

## Non-Goals

- 不暴露版本 UI（`ingestFile({ documentId })` 仍只在代码层可用）。
- 不做上传字节流（multipart / base64）：Electron 侧只传绝对路径，后端读文件。
- 不做后台 Job / 进度 SSE；入库是单次同步请求，UI 用列表轮询展示状态推进。
- 不改检索、分块、向量、Agent 侧任何逻辑；不新增表与迁移。
- 不改 `isShared` 语义之外的文档模型；不接入 `conversation_documents`。

## Must-Not-Break Existing Behavior

- `ingestFile()` 的幂等（contentHash）、版本自增、状态机（`parsing → chunking → indexed → ready`、`failed`）与 storage 布局不变。
- `GET /api/documents` 与既有 `listDocuments()` 字段保持兼容，只做**新增字段**。
- Agent 对话、设置页、Electron 桥的既有 IPC 契约不变；`backend:request` 仍只接受 JSON。
- Agent 文件写入边界不变：`<workspace>/knowledge/` 是 Agent 可读的普通目录，写入仍受 workspace 限制。

## Current Behavior

| 位置 | 现状 |
|---|---|
| `DocumentsService` | 只有 `ingestFile` / `listDocuments` / `getDocumentDetail` / `listVersionChunks`；没有任何删除或导入入口 |
| `documents` 模块 | 无 Controller；`DocumentsModule` 只装配解析器与 embedding |
| `knowledge` 模块 | `KnowledgeService` 空壳 |
| Electron 桥 | 只有 `backend:state`、`backend:request`（JSON）、`chat:stream:*`；无文件选择能力 |
| `SettingsService` | `getWorkspacePath()` 已存在，路径来自 `~/.tech-forge/config.toml` |
| `chunk_embeddings` / `chunk_search_terms` / `chunk_fts` | 无外键；FTS 由 `chunk_search_terms` 的 insert/delete 触发器同步 |

## 关键决策

| 决策 | 选择 | 原因 |
|---|---|---|
| 归属领域 | `documents`（新增 Controller + Service 方法） | 它拥有 document/version/chunk 与 storage 布局；`knowledge` 模块仍是空壳，此处只做转发会造出无行为的中间层（违反放置文档"不要为架构完整填空壳方法"） |
| 传输方式 | 传**绝对路径**，不传字节 | Electron 桥只有 JSON；渲染进程本来就不该读文件系统，后端统一在 workspace 内落盘 |
| workspace 副本位置 | `<workspace>/knowledge/<documentId>/<原文件名>` | 删除时按 documentId 即可定位，不需要新增表记录路径 |
| storage 副本 | 保留 `DOCUMENTS_STORAGE_ROOT` 现有布局 | `ingestFile` 的 `workspaceRelativePath` 语义不变；代价是同一份字节存两处，个人规模可接受，换来的是一致性与可回放 |
| 删除语义 | 先事务删库，再删文件 | 文件删除失败不应留下"有文件无记录"的可用假象；删库成功即检索不可见 |
| 处理中删除 | 拒绝（409） | 避免在解析/分块仍写行时并发删除，产生残缺索引 |
| 导入串行 | Service 内 promise 队列 | embedding 是 CPU 密集的，并发导入只会互相拖慢并放大 SQLite 写冲突 |
| `isShared` | 导入时写 `true` | 知识库就是共享资料集合；当前没有其它生产者，列表因此直接返回全部 |
| 直接依赖 SettingsService | 允许（跨领域公开 Service） | 放置文档明确允许经公开 Service 契约跨领域调用 |

## UI 设计

### 入口：侧栏

在 `ConversationSidebar` 的 header 内、"新建课题"行下方插入一个与"设置"同视觉的导航项（不放进滚动列表，位置固定）：

```
┌──────────────────────────────┐
│ [✎ 新建课题]           [⟳]  │
│ [▤ 知识库]                  │  ← 新增，aria-pressed 表示当前视图
│──────────────────────────────│
│ 学习下产品设计心法            │
│ 11/8                         │
│ …                            │
│──────────────────────────────│
│ [⚙ 设置]                     │
└──────────────────────────────┘
```

- 状态从 `isSettingsOpen: boolean` 提升为 `activeView: 'chat' | 'settings' | 'knowledge'`，三者互斥。
- "新建课题"、选中任意对话 → `activeView = 'chat'`；"设置" → 在 `settings` / `chat` 间切换；"知识库" → 在 `knowledge` / `chat` 间切换。
- 视图切换不停流：Agent 正在回答时也能进知识库（与设置页现有行为一致）。
- "新建课题"在处理中仍禁用；"知识库"始终可点。

### 主区域：知识库

```
知识库                                             [刷新]  [导入资料]
共 3 份资料 · 可检索 2 · 处理中 1

┌ 本次导入 ─────────────────────────────────────────────────────┐
│ ⟳ 教学讲义.pdf    正在解析并建立索引…                          │
│ ✓ 法规节选.docx   可检索 · 55 分片 · 0.3 秒         [关闭提示] │
│ ✗ 扫描件.pdf      失败：NO_TEXT_LAYER: 未发现文本层            │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│ AI-Agents-in-Depth-zh-CN.pdf                    [可检索]      │
│ PDF · 961 分片 · v1 · 11/8 18:20                  [删除]      │
├───────────────────────────────────────────────────────────────┤
│ 法规节选.docx                                  [可检索]       │
│ DOCX · 55 分片 · v1 · 11/8 18:22                  [删除]      │
├───────────────────────────────────────────────────────────────┤
│ 第三章 讲义.md                              [已索引·向量待补]  │
│ Markdown · 128 分片 · v1 · 11/8 18:30             [删除]      │
└───────────────────────────────────────────────────────────────┘
```

状态与交互规则：

| 场景 | 表现 |
|---|---|
| 首次加载 | 骨架文案"正在加载资料…"（`role="status"`） |
| 空列表 | "还没有资料。导入 PDF / DOCX / Markdown / TXT 后，Agent 就能检索到。" |
| 加载失败 | 红色提示条 + "重试"（`role="alert"`） |
| 状态徽标 | `ready` 绿"可检索"；`indexed` 琥珀"已索引 · 向量待补"（`title` 显示 `processingError`）；`parsing/chunking` 灰"处理中" + 转圈；`failed` 红"失败"（`title` 显示失败原因） |
| 导入中 | 按钮显示"导入中…"并禁用；列表每 1.5 s 静默轮询 `GET /api/documents`，可见 `parsing → chunking → ready` 推进 |
| 导入结果 | 每个文件一行结论（成功含分片数与耗时；失败含后端消息），可整体关闭 |
| 删除 | 行内两段式确认：`确认删除「<文件名>」？删除后该资料不可再被检索。 [取消] [删除]`；删除中禁用该行；成功刷新列表，409 显示"资料正在处理中" |
| 不支持的类型 | 选择器过滤 + 后端 400 双重拦截，消息为"不支持的文件类型：.xls" |
| 重复内容 | 该行提示"该文件已入库，未重复导入"，列表走高亮已有资料（`duplicate: true`） |

视觉沿用现有约定：`stone` 中性色、`rounded-xl border border-stone-200 bg-white` 卡片、主按钮 `rounded-lg bg-stone-900 text-white hover:bg-stone-700`、焦点环 `focus-visible:ring-2 focus-visible:ring-emerald-800/30`。

## API 契约

所有端点经 Electron 桥 `backend:request`，带本机 token，无新增鉴权机制。

| 方法 | 路径 | 请求 | 响应 | 失败 |
|---|---|---|---|---|
| GET | `/api/documents` | — | `DocumentSummary[]` | 500 |
| POST | `/api/documents/import` | `{ filePath: string, title?: string }` | 200 `ImportDocumentResult` | 400 类型或源文件问题；422 解析/切分失败（版本标 `failed`）；500 工作空间不可写。均返回 `{ statusCode, code, message, detail }`，`message` 为中文可执行文案 |
| DELETE | `/api/documents/:documentId` | — | 200 `{ documentId: string }` | 400 非法 UUID；404 不存在；409 `parsing/chunking` |

```ts
// documents.service.ts（新增）
export interface ImportDocumentResult extends IngestDocumentResult {
  /** workspace 内的落盘位置；重复导入时为 null（未复制任何字节）。 */
  workspacePath: string | null;
}

// DocumentSummary（新增字段，向后兼容）
latest: {
  versionNo: number;
  status: DocumentProcessingStatus;
  originalName: string;
  chunkCount: number;
  byteSize: number | null;          // 新增
  createdAt: Date;                  // 新增：最近一次导入时间
  processingError: string | null;   // 新增：失败或向量缺口的说明，供状态徽标展示
} | null;
```

DTO（`documents.dto.ts`）：

```ts
export class ImportDocumentDto {
  @IsString() @IsNotEmpty() @MaxLength(4096) filePath!: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}
```

现有全局 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` 直接生效；`POST import` 用 `@HttpCode(200)` 让前端只判 200（导入是"可能命中幂等键"的命令，语义上不是新建 201）。

## 后端实现

### 导入：`DocumentsService.importFromPath()`

```ts
async importFromPath(input: ImportDocumentDto): Promise<ImportDocumentResult> {
  return this.runExclusive(async () => {
    const sourcePath = this.validateInput({ filePath: input.filePath });
    const originalName = basename(sourcePath);
    if (!this.parser.supportsFile(originalName)) {
      throw new BadRequestException(`不支持的文件类型：${extname(originalName) || '(无扩展名)'}`);
    }
    this.assertReadable(sourcePath);

    // 1. 先复制到 workspace 的暂存目录（.importing），满足"上传到 workspace"。
    const workspaceRoot = await this.settings.getWorkspacePath();
    const stagingDirectory = join(workspaceRoot, 'knowledge', '.importing', randomUUID());
    mkdirSync(stagingDirectory, { recursive: true });
    const stagedPath = join(stagingDirectory, originalName);
    copyFileSync(sourcePath, stagedPath);

    // 2. 从暂存文件入库；失败与重复都不留副本。
    let result: IngestDocumentResult;
    try {
      result = await this.ingestFile({ filePath: stagedPath, title: input.title, isShared: true });
    } catch (error) {
      rmSync(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    if (result.duplicate) {
      rmSync(stagingDirectory, { recursive: true, force: true });
      return { ...result, workspacePath: null };
    }

    // 3. 成功后按 documentId 归位，删除时可直接递归移除。
    const targetDirectory = join(workspaceRoot, 'knowledge', result.documentId);
    rmSync(targetDirectory, { recursive: true, force: true });
    renameSync(stagingDirectory, targetDirectory);
    return { ...result, workspacePath: join(targetDirectory, originalName) };
  });
}
```

要点：

- 重复先由暂存副本承担：重复时 `ingestFile` 的内容哈希短路返回，暂存目录直接删掉，workspace 不留孤儿。
- 归一化用 `rename`（同卷、原子），避免二次拷贝大文件。
- `ingestFile` 内部的 `copyIntoStorage` 仍把源文件落到 `<dataDir>/documents/<id>/v1/`，这是入库快照，与 workspace 副本职责不同。

### 删除：`DocumentsService.deleteDocument()`

```ts
async deleteDocument(documentId: string): Promise<void> {
  return this.runExclusive(async () => {
    await this.requireDocument(documentId);                       // 404
    const versions = await this.versions.find({ where: { documentId } });
    if (versions.some((v) => v.processingStatus === 'parsing' || v.processingStatus === 'chunking')) {
      throw new ConflictException('资料正在处理中，请等待入库完成后再删除');
    }

    await this.dataSource.transaction(async (manager) => {
      // chunk_embeddings 无外键，必须显式删，否则向量残留会被检索命中。
      await manager.query('DELETE FROM "chunk_embeddings" WHERE "documentId" = ?', [documentId]);
      // 先删词法流：AFTER DELETE 触发器据此同步 chunk_fts（external content 需要旧值）。
      await manager.query(
        `DELETE FROM "chunk_search_terms" WHERE "chunkId" IN (
           SELECT "id" FROM "document_chunks"
            WHERE "documentVersionId" IN (
              SELECT "id" FROM "document_versions" WHERE "documentId" = ?))`,
        [documentId],
      );
      await manager.query(
        `DELETE FROM "document_chunks" WHERE "documentVersionId" IN (
           SELECT "id" FROM "document_versions" WHERE "documentId" = ?)`,
        [documentId],
      );
      await manager.delete(DocumentVersionEntity, { documentId });
      await manager.delete(ConversationDocumentEntity, { documentId });   // FK NO ACTION
      await manager.delete(DocumentEntity, { id: documentId });
    });

    // 事务提交后再清文件；失败不回滚数据库（记录已不可检索）。
    rmSync(join(this.storageRoot, 'documents', documentId), { recursive: true, force: true });
    const workspaceRoot = await this.settings.getWorkspacePath();
    rmSync(join(workspaceRoot, 'knowledge', documentId), { recursive: true, force: true });
  });
}
```

顺序受现有外键（`document_versions.documentId`、`document_chunks.documentVersionId`、`conversation_documents.documentId` 均为 `NO ACTION`）约束，且 FTS 只能通过 `chunk_search_terms` 的触发器清理。

### 串行队列

```ts
private libraryQueue: Promise<unknown> = Promise.resolve();

/** 串行执行导入/删除，避免并发写库与 CPU 抢占。 */
private runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = this.libraryQueue.then(task, task);
  this.libraryQueue = run.catch(() => undefined);
  return run;
}
```

### 模块装配

```ts
@Module({
  imports: [TypeOrmModule.forFeature([...]), DocumentParserModule, EmbeddingModule, SettingsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
```

`SettingsModule` 已 `exports: [SettingsService]`，无循环依赖（它只引用 `llm/adapters/llm-adapter` 的常量）。

### 测试隔离：`TEACHFORGE_CONFIG_DIR`

`SettingsService` 目前硬编码 `join(homedir(), '.tech-forge')`，集成测试一旦经过 `SettingsModule` 就会写真实用户目录。改为：

```ts
private readonly configDirectory = process.env.TEACHFORGE_CONFIG_DIR ?? join(homedir(), '.tech-forge');
```

与既有 `TEACHFORGE_DATA_DIR` 同一模式；默认行为不变。测试进程在 `NestFactory.create` 之前设置该变量即为沙箱。这也为后续"把配置放进便携目录"留出入口。

## 前端实现

### Electron 桥（新增一个 IPC）

| 层 | 代码 |
|---|---|
| `types/desktop-bridge.ts` | `pickImportFiles(): Promise<string[]>`；`hasDesktopBridge()` 增加该函数检查 |
| `electron/preload/preload.ts` | `pickImportFiles: () => ipcRenderer.invoke('documents:pick-files') as Promise<string[]>` |
| `electron/main/main.ts` | `ipcMain.handle('documents:pick-files', ...)`：`dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: [{ name: '资料', extensions: ['pdf','docx','md','markdown','txt'] }] })`，取消返回 `[]` |

只暴露"选择文件"，不暴露任意路径读取；文件字节始终由后端在 workspace 内复制。渲染进程伪造路径的后果仅是把自己选中的其它受支持文件导入知识库——与设置页可写 config.toml 属同一信任级别，记录为已接受风险（Agent 无 bash、无外网 Markdown，不能执行渲染进程代码）。

### 组件与状态

新增 `apps/desktop/src/features/knowledge/KnowledgeBasePage.tsx`（单文件，按现有 SettingsPage 的组织方式分节）：

```
KnowledgeBasePage           列表加载、轮询、删除确认、导入队列
├─ ImportFeedbackList       本次会话的导入结果列表（成功/失败/进行中）
├─ DocumentRow              单行：标题、元信息、状态徽标、删除确认
└─ StatusBadge              状态 → 中文标签与配色
```

状态：

| State | 用途 |
|---|---|
| `documents: DocumentSummary[]` | 列表 |
| `listStatus: 'loading' \| 'ready' \| 'error'` / `listError` | 首屏加载与错误横幅 |
| `imports: ImportEntry[]` | 本次会话导入队列：`{ path, name, state: 'pending' \| 'importing' \| 'done' \| 'failed', message? }` |
| `isImporting` | 导入按钮禁用 + 轮询开关 |
| `pendingDeleteId: string \| null` | 两段式删除确认 |
| `deletingId: string \| null` | 行级禁用 |

流程：

1. `useEffect` 挂载 → `loadDocuments()`（`hasDesktopBridge()` 不满足时给出"请通过桌面应用打开"的提示）。
2. 点击"导入资料" → `window.teachforge.pickImportFiles()`；`[]` 直接返回。
3. 逐文件串行：`POST /api/documents/import` → 更新该行状态 → 每完成一个就 `loadDocuments()`。串行是刻意的：与后端队列一致，也避免多个大文件同时抢 CPU。
4. `isImporting` 为真时启动 1.5 s 轮询 `GET /api/documents`（`setInterval` + cleanup），让 `parsing → ready` 可见。
5. 删除 → 置 `pendingDeleteId` → 确认后 `DELETE /api/documents/:id`，成功清空并刷新；409/404 走统一错误文案。

校验函数 `isDocumentSummary` / `isImportResult` 与 `readBackendErrorMessage`（从 `SettingsPage` 抽出到 `apps/desktop/src/api/backend-error.ts`，设置页改为复用），保证不把未校验的响应灌进 UI。

### 外壳改动

```tsx
// AgentChatPage.tsx
type ShellView = 'chat' | 'settings' | 'knowledge';
const [view, setView] = useState<ShellView>('chat');
…
<ConversationSidebar activeView={view} onSelectView={setView} … />
{view === 'settings' ? <SettingsPage />
 : view === 'knowledge' ? <KnowledgeBasePage />
 : /* 现有对话区域 */ }
```

`ConversationSidebar` 的 props 由 `isSettingsOpen / onToggleSettings` 改为 `activeView / onSelectView`，footer 设置按钮保持自切换逻辑，header 增加知识库按钮（`aria-pressed`、`title="知识库"`、图标用 `Books` 或 `FolderOpen`）。

## 异常分类与用户文案

目标用户只知道"AI 助手"这一层（例如用过豆包），因此**冻结的技术词**不出现在界面上：`向量`、`索引`、`分片`、`embedding`、`OCR`、`chunk` 一律改写。术语对照：

| 内部概念 | 面向用户 |
|---|---|
| 向量 / embedding | 按意思搜索 |
| 词法 / FTS / 关键词索引 | 关键词搜索 |
| chunk / 分片 | 段 |
| 状态 `indexed`（向量缺失） | 只能关键词搜索 |
| 解析 / 分块 | 读取 / 整理内容 |
| DOCX | Word（.docx） |

异常按"是否阻断本次操作"分两类，**两类都不静默**：

| 类别 | 例子 | 处理 |
|---|---|---|
| 阻断 | 源文件不可读、格式不支持、工作空间不可写、解析/切分失败 | 抛出 HTTP 异常（400/422/500/409），`message` 为中文可执行文案，`detail` 保留技术原因，同时写一条结构化日志（`documents.import.*`），渲染层必须展示 |
| 非阻断 | 删除后的文件清理、导入成功后另存上传副本、后台列表轮询 | 记录日志（`documents.file.cleanup_failed` 等）并回传到 UI：删除返回 `fileCleanup: 'complete' \| 'partial'`、导入以 `warnings[]` 返回、轮询连续失败显示"暂时刷新失败" |

API 错误信封新增两个字段，`HttpException` 直接携带对象：

```json
{ "statusCode": 422, "code": "NO_TEXT_LAYER",
  "message": "这份 PDF 里没有可以读取的文字，可能是扫描件或图片。",
  "detail": "NO_TEXT_LAYER: 该 PDF 没有文本层（可能是扫描件），暂不支持" }
```

错误码与文案：

| code | HTTP | message |
|---|---|---|
| `UNSUPPORTED_FILE_TYPE` | 400 | 这种文件暂时不能导入（.xlsx）。支持 PDF、Word（.docx）、Markdown（.md）和 TXT。 |
| `SOURCE_UNREADABLE` | 400 | 无法读取所选文件，它可能已被移动、重命名或删除，请重新选择。 |
| `WORKSPACE_UNWRITABLE` | 500 | 没能把资料保存到知识库的文件夹，请到设置里确认工作空间路径存在并且可以写入。 |
| `NO_TEXT_LAYER` | 422 | 这份 PDF 里没有可以读取的文字，可能是扫描件或图片。可以换成带文字的 PDF，或者改用 Word / Markdown / TXT 文件。 |
| `UNSUPPORTED_FORMAT` | 422 | 文件内容和扩展名对不上，可能已经损坏。请用原软件重新另存后再试。 |
| `DOCUMENT_TOO_LARGE_FOR_INDEX` | 422 | 这份资料内容太多，一次处理不了，请拆分后再导入。 |
| `PARSER_TIMEOUT` / `PARSER_CANCELLED` | 422 | 处理这份资料时超时或被中断，请稍后重试。 |
| `EMPTY_PARSE_RESULT` / `PARSER_FAILED` | 422 | 没有找到可以读取的文字 / 没能读取成功，请确认文件没有损坏，或换一种格式。 |
| `IMPORT_FAILED` | 422 | 处理这份资料时出错了，请稍后重试。 |
| `DOCUMENT_PROCESSING` | 409 | 这份资料还在处理中，等处理完再删除。 |
| 资料不存在 | 404 | 没有找到这份资料，它可能已经被删除。 |

渲染层对无法识别的技术文本（如 `fetch failed`、`The local backend is not ready.`）统一走 `describeFailure()`：中文消息原样透出，英文/技术文本降级为"<场景文案>（<技术原文>）"，避免只给一句英文。

解析器自身的告警（`TOC_LIKE`、`MULTI_COLUMN_SUSPECTED`、`UNSTRUCTURED_TABLE`、`EMPTY_PAGE`、`CONVERSION_MESSAGE`）保留原始 message 供诊断，界面按 code 映射成一句话（如"目录页已跳过"）。

## 边界与失败处理

| 情况 | 处理 |
|---|---|
| 用户在对话框取消 | 返回 `[]`，UI 无变化 |
| 选择后被移动/删除 | `statSync` 抛错 → 400「无法读取所选文件」，导入行显示该消息 |
| 不支持扩展名 | 选择器过滤 + 后端 400，不创建任何行 |
| 同一文件重复导入 | `duplicate: true`，不新增行、不留副本 |
| 大 PDF（300+ 页，~40 s） | 请求期间按钮禁用 + 列表轮询；请求无超时（本机回环） |
| 解析失败 / 无文本层 | 版本 `failed`，`processingError` 记录，HTTP 422 回传失败原因，列表可见"失败"行可删 |
| embedding 失败 | 版本 `indexed` + `EMBEDDING_FAILED…`，列表显示"已索引 · 向量待补"，仍可词法检索 |
| 删除处理中的资料 | 409，提示等待 |
| 删除时文件删除失败 | 数据库已提交删除，`rmSync(force)` 尽力而为；不影响检索正确性 |
| 直接删库后进程崩溃 | storage/workspace 残留目录无引用，安全（不会出现在列表） |

## 落地文件清单

| 文件 | 动作 |
|---|---|
| `apps/backend/src/documents/documents.dto.ts` | 新增 `ImportDocumentDto` |
| `apps/backend/src/documents/documents.controller.ts` | 新增 `GET /api/documents`、`POST /api/documents/import`、`DELETE /api/documents/:id` |
| `apps/backend/src/documents/documents.service.ts` | 新增 `importFromPath`、`deleteDocument`、串行队列、`latest.byteSize/createdAt` |
| `apps/backend/src/documents/documents.module.ts` | 引入 `SettingsModule`、注册 Controller |
| `apps/backend/src/settings/settings.service.ts` | `TEACHFORGE_CONFIG_DIR` 覆盖（默认不变） |
| `apps/backend/test/knowledge-library.test.cjs` | 新增 HTTP 集成测试 |
| `apps/backend/test/verify-document-ingest.cjs` | 构造参数补齐新签名（含 `EmbeddingService` 与 settings 依赖） |
| `apps/backend/package.json` | 新增 `test:knowledge-library` 脚本 |
| `apps/desktop/src/types/desktop-bridge.ts` | `pickImportFiles` |
| `apps/desktop/electron/preload/preload.ts` | `documents:pick-files` 转发 |
| `apps/desktop/electron/main/main.ts` | `dialog.showOpenDialog` handler |
| `apps/desktop/src/features/knowledge/KnowledgeBasePage.tsx` | 新增页面 |
| `apps/desktop/src/api/backend-error.ts` | 新增（从设置页抽出的错误消息助手） |
| `apps/desktop/src/features/settings/SettingsPage.tsx` | 改用共享助手 |
| `apps/desktop/src/features/agent/ConversationSidebar.tsx` | 新增知识库导航 + `activeView` props |
| `apps/desktop/src/features/agent/AgentChatPage.tsx` | 视图状态由 boolean 提升为 `ShellView` |
| `docs/current/domains/documents/index.md` | 入口/读取模型/未实现三节更新 |
| `docs/current/domains/system-settings/index.md` | 记录 `TEACHFORGE_CONFIG_DIR` |
| `docs/current/platform/architecture-and-code-placement.md` | documents/knowledge 行、desktop 表、装配差异 |
| `docs/changes/README.md`、`docs/manifest.yaml` | 登记本次变更与路由 |

## 测试与验证

### 集成测试（真实 HTTP + 真实 SQLite + 真实文件系统）

`apps/backend/test/knowledge-library.test.cjs`：

1. 临时 `TEACHFORGE_CONFIG_DIR` 写入 `config.toml`（`[workspace] path = <tmp>/workspace`），临时 `TEACHFORGE_DATA_DIR`。
2. `NestFactory.create(IntegrationModule, new FastifyAdapter())`，模块 = `TypeOrmModule.forRootAsync(buildDatabaseOptions)` + `DocumentsModule`；按 `main.ts` 同样方式加 token 校验钩子后 `listen(0)`。
3. 断言矩阵：

| 用例 | 断言 |
|---|---|
| 导入 md | 200；`documents`/`document_versions`(uuid, `ready`)/`document_chunks` 行存在；`<workspace>/knowledge/<documentId>/<name>` 存在；`<dataDir>/documents/<id>/v1/<name>` 存在；`GET /api/documents` 含该条 |
| 重复导入同一文件 | `duplicate: true`；文档行数不变；`.importing` 清空 |
| 不支持类型（`.xlsx`） | 400；无任何新行、无文件副本 |
| 无文本层 PDF | 422；版本 `failed` 且 `processingError` 非空（用 fixture 构造） |
| 删除 | 200；六表对应行数归零；`SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH '<词>'` 为 0；两个目录被删除；再次 `GET` 不含该条 |
| 删除不存在 | 404 |
| 删除处理中 | 直接把某版本 `processingStatus` 改为 `chunking` 后删除 → 409，行仍在 |

4. `npm run test:knowledge-library --workspace @teachforge/backend` 通过；既有 `test:document-ingest`、`test:retrieval`、`test:document-tool` 不回归。

`DocumentsModule` 引入 `SettingsModule` 后，既有 `document-ingest.test.cjs` 也会实例化真实 `SettingsService`，因此该测试同样要在 `NestFactory` 之前设置 `TEACHFORGE_CONFIG_DIR` 指向临时目录，否则会写真实 `~/.tech-forge/config.toml`。`test/verify-document-ingest.cjs` 手工构造 `DocumentsService` 的参数已落后于现有构造函数（缺 `EmbeddingService`），本次一并补齐为新签名。

### 手工验收（Electron 实际界面）

`npm run dev` → 侧栏"知识库" → 导入真实 PDF/DOCX/MD/TXT → 观察状态推进到"可检索" → 关闭应用重开确认列表仍在 → 删除其中一条并确认删除后 Agent `search_documents` 不再命中该资料 → 设置页切换、对话切换均正常。

## 任务顺序

1. `SettingsService` 增加 `TEACHFORGE_CONFIG_DIR`（先让测试可隔离）。
2. `DocumentsService` 增加 `importFromPath` / `deleteDocument` / 串行队列 / 读取模型新字段。
3. `documents.dto.ts` + `documents.controller.ts` + 模块装配。
4. 写 `knowledge-library.test.cjs` 并跑通；回归既有后端测试。
5. Electron main/preload/types 增加文件选择 IPC。
6. `KnowledgeBasePage` + `backend-error.ts` 抽取 + 设置页改用共享助手。
7. `ConversationSidebar` / `AgentChatPage` 视图切换改造。
8. `npm run build` + 手工 Electron 验收。
9. 同步 `current/` 文档、变更索引与 `manifest.yaml`。

## 风险与已知取舍

| 风险 | 影响 | 处理 |
|---|---|---|
| 同一份字节存两份（workspace + dataDir） | 磁盘占用 ×2 | 个人规模可接受；若将来改成单份，须把 `DOCUMENTS_STORAGE_ROOT` 迁入 workspace 并回填 `workspaceRelativePath`，另立变更 |
| 导入是长同步请求（大 PDF ~40 s） | 期间无法取消 | 本机回环无超时风险；失败会回滚为 `failed` 行；后续可换 Job 队列 |
| 渲染进程可提交任意路径 | 可将本机任意受支持文件复制进知识库 | 与设置页同级信任；不收字节、不返回文件内容；已记录 |
| `rename` 前先 `rmSync(target)` | 极端情况下 workspace 副本缺失而库记录完好 | 只影响"用户可见副本"，检索与删除不受影响 |
| 双写清理靠显式 SQL | 表结构变化时删除易漏 | 集成测试逐表断言 + 注释标明无外键表 |

## 实施差异（落地后回填）

| 计划 | 实际 | 原因 |
|---|---|---|
| 解析失败返回 500 | 返回 **422** `UnprocessableEntityException`，消息为解析器错误摘要 | Nest 默认异常过滤器会把非 HTTP 异常统一成 `Internal server error`，用户看不到失败原因 |
| `latest` 只加 `byteSize` / `createdAt` | 另加 **`processingError`** | 列表需要在不拉详情的前提下解释"已索引·向量待补"与"失败" |
| 删除后删除全部目录 | 保留空的 `<workspace>/knowledge/.importing/` 暂存根 | 它是下次导入的父目录；空的隐藏目录不影响检索与列表 |
| 文件删除失败需要报错 | 不失败响应，但**记录日志并通过 `fileCleanup: 'partial'` 回报**，界面出现"有一个文件没能删掉"的提示 | 数据库已提交、残留目录无引用，不能把成功删除变成错误；同时不能静默 |
| 测试进程可自由设置 HOME | 新增 `TEACHFORGE_CONFIG_DIR` 覆盖配置目录 | `SettingsService` 硬编码 `~/.tech-forge`，测试与便携部署都需要重定向 |
| 导入失败后列表不再保留记录 | 保留一条"导入失败"行，可手动删除；再次导入同一文件返回 `duplicate` + `failed`，界面提示"请先删除那条失败记录，再重新导入" | 失败证据对用户可见，不做静默清理；同时避免内容哈希幂等把失败悄悄吞掉 |
| 非法 documentId 返回 400 | 返回 404「没有找到这份资料」 | `ParseUUIDPipe` 的英文校验消息对用户无意义；路由参数本就参数化查询，不需要格式校验 |
| 界面允许出现技术词 | 界面冻结 `向量/索引/分片/embedding/OCR`，见"异常分类与用户文案" | 目标用户只熟悉对话式 AI，看不懂检索栈术语 |
