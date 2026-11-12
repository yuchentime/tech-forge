import { useCallback, useEffect, useState } from 'react';
import {
  ArrowClockwise,
  Books,
  CheckCircle,
  CircleNotch,
  FileText,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react';
import { describeFailure, readBackendErrorMessage } from '../../api/backend-error';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { hasDesktopBridge } from '../../types/desktop-bridge';

/** Lifecycle values the backend may report for the latest document version. */
type DocumentStatus = 'parsing' | 'cataloging' | 'chunking' | 'indexed' | 'ready' | 'failed';

/** Catalog state of the latest version; `failed` keeps the file but leaves it out of the directory. */
type CatalogStatus = 'pending' | 'ready' | 'failed';

/** Copy shared by the import card, the row badge and its hint for a missing catalog summary. */
const CATALOG_FAILED_HINT =
  '资料已保存，但目录摘要没生成成功。点「重试摘要」再试一次，或删除后重新导入。';
const CATALOG_FAILED_COPY = '资料已保存，但目录摘要没生成成功，可以在列表里点「重试摘要」。';

/** One row of the knowledge library list, as returned by `GET /api/documents`. */
interface DocumentSummary {
  id: string;
  title: string;
  isShared: boolean;
  versionCount: number;
  latest: {
    versionNo: number;
    status: DocumentStatus;
    catalogStatus: CatalogStatus;
    originalName: string;
    chunkCount: number;
    byteSize: number | null;
    createdAt: string;
    processingError: string | null;
  } | null;
}

/** Outcome of one deletion, as returned by `DELETE /api/documents/:documentId`. */
interface DeleteResult {
  documentId: string;
  fileCleanup: 'complete' | 'partial';
}

/** Outcome of one import, as returned by `POST /api/documents/import`. */
interface ImportResult {
  documentId: string;
  chunkCount: number;
  status: DocumentStatus;
  duplicate: boolean;
  warnings: Array<{ code: string; message: string }>;
}

/** Per-file progress shown in the import feedback panel. */
interface ImportEntry {
  id: number;
  name: string;
  state: 'pending' | 'importing' | 'done' | 'duplicate' | 'failed';
  message?: string;
}

/**
 * How many uploads run at once; the rest wait with a visible queue entry.
 *
 * Mirrors `IMPORT_CONCURRENCY` in the backend, which still admits at most this many per request so a
 * second client or a direct API call cannot bypass the provider budget.
 */
const IMPORT_CONCURRENCY = 3;

/** Monotonic key for import feedback rows; the file path itself is not a stable key. */
let nextImportId = 0;

/**
 * Renders the knowledge library: imported materials, native file import and deletion.
 *
 * The page only talks to the local backend through the restricted desktop bridge. Picked files are
 * dispatched by a three-wide worker pool, so the remaining files wait with a "排队中" entry instead
 * of flooding the provider; the list is polled while imports or catalog retries are in flight so
 * `parsing → cataloging → ready` is visible without a progress protocol.
 */
export function KnowledgeBasePage() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [imports, setImports] = useState<ImportEntry[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [isPickingFiles, setIsPickingFiles] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fileCleanupWarning, setFileCleanupWarning] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [pollFailures, setPollFailures] = useState(0);

  /** Loads the library list; silent polls never replace a visible error or clear the rows. */
  const loadDocuments = useCallback(async (silent = false) => {
    if (!silent) {
      setListStatus('loading');
      setListError(null);
    }
    if (!hasDesktopBridge()) {
      setListStatus('error');
      setListError('请通过 TeachForge 桌面应用管理资料库。');
      return;
    }

    try {
      const response = await window.teachforge.request<unknown>({
        method: 'GET',
        path: '/api/documents',
      });
      if (
        response.status !== 200 ||
        !Array.isArray(response.data) ||
        !response.data.every(isDocumentSummary)
      ) {
        throw new Error(readBackendErrorMessage(response.data, '读取资料列表失败，请重试。'));
      }
      setDocuments(response.data);
      setListStatus('ready');
      setListError(null);
      setPollFailures(0);
    } catch (error) {
      if (silent) {
        // A background refresh must not replace the list with an error, but repeated failures are
        // still counted so the user is told the view may be stale.
        setPollFailures((count) => count + 1);
        return;
      }
      setListStatus('error');
      setListError(describeFailure(error, '读取资料列表失败，请重试。'));
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const isImporting = imports.some(
    (entry) => entry.state === 'pending' || entry.state === 'importing',
  );
  const isBackgroundWork = isImporting || retryingId !== null;

  useEffect(() => {
    if (!isBackgroundWork) return;
    const timer = window.setInterval(() => {
      void loadDocuments(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [isBackgroundWork, loadDocuments]);

  /** Picks files natively, then imports them one at a time and reports each outcome. */
  const importDocuments = useCallback(async () => {
    setImportError(null);
    if (!hasDesktopBridge()) {
      setImportError('请通过 TeachForge 桌面应用导入资料。');
      return;
    }

    setIsPickingFiles(true);
    let picked: string[];
    try {
      picked = await window.teachforge.pickImportFiles();
    } catch (error) {
      setImportError(describeFailure(error, '无法打开文件选择器，请重试。'));
      return;
    } finally {
      setIsPickingFiles(false);
    }

    if (picked.length === 0) return;

    const entries = picked.map((filePath) => ({
      id: nextImportId++,
      filePath,
      name: fileNameOf(filePath),
    }));
    setImports((current) => [
      ...entries.map(({ id, name }) => ({
        id,
        name,
        state: 'pending' as const,
        message: '排队中…',
      })),
      ...current,
    ]);

    // Workers pull from a copy: the React updater above must keep seeing the full batch, and a
    // shifted array would render only the files that were still queued at commit time.
    const pending = entries.slice();
    const startNext = () => pending.shift();
    const runOne = async (item: (typeof entries)[number]) => {
      updateImport(setImports, item.id, (entry) => ({
        ...entry,
        state: 'importing',
        message: undefined,
      }));
      try {
        const response = await window.teachforge.request<unknown>({
          method: 'POST',
          path: '/api/documents/import',
          body: { filePath: item.filePath },
        });
        if (response.status !== 200 || !isImportResult(response.data)) {
          throw new Error(readBackendErrorMessage(response.data, '导入失败，请重试。'));
        }
        const result = response.data;
        // A duplicate can point at an earlier failed attempt; saying "already imported" would hide it.
        const failedBefore = result.duplicate && result.status === 'failed';
        // The row is saved even when the summary fails, so the card must not read as a plain success.
        const catalogFailed = !failedBefore && result.status === 'failed';
        // Picking the same file twice in one batch reports a duplicate while the first copy is still
        // running; claiming it is already imported would be wrong until that copy settles.
        const stillRunning =
          result.duplicate && (result.status === 'parsing' || result.status === 'cataloging');
        updateImport(setImports, item.id, (entry) => ({
          ...entry,
          state: failedBefore || catalogFailed ? 'failed' : result.duplicate ? 'duplicate' : 'done',
          message: failedBefore
            ? '这份文件上次导入没成功，请先在列表里重试摘要或删除后重新导入。'
            : catalogFailed
              ? CATALOG_FAILED_COPY
              : stillRunning
                ? '这份文件正在导入，不会再处理一次。'
                : result.duplicate
                  ? '该文件已入库，未重复导入。'
                  : describeImportSuccess(result),
        }));
      } catch (error) {
        updateImport(setImports, item.id, (entry) => ({
          ...entry,
          state: 'failed',
          message: describeFailure(error, '导入失败，请重试。'),
        }));
      }
      await loadDocuments(true);
    };

    const workers = Array.from(
      { length: Math.min(IMPORT_CONCURRENCY, pending.length) },
      async () => {
        for (let item = startNext(); item; item = startNext()) await runOne(item);
      },
    );
    await Promise.all(workers);

    await loadDocuments(true);
  }, [loadDocuments]);

  /** Regenerates the catalog summary of one saved document and refreshes its row. */
  const retryCatalog = useCallback(
    async (documentId: string) => {
      setRetryingId(documentId);
      setRetryError(null);
      try {
        const response = await window.teachforge.request<unknown>({
          method: 'POST',
          path: `/api/documents/${encodeURIComponent(documentId)}/catalog/retry`,
        });
        if (response.status !== 200 || !isRetryResult(response.data)) {
          throw new Error(readBackendErrorMessage(response.data, '重试摘要失败，请重试。'));
        }
        if (response.data.catalogStatus === 'failed') {
          setRetryError('摘要还是没有生成成功，可以稍后再试一次。');
        }
      } catch (error) {
        setRetryError(describeFailure(error, '重试摘要失败，请重试。'));
      } finally {
        setRetryingId(null);
      }
      await loadDocuments(true);
    },
    [loadDocuments],
  );

  /** Deletes one confirmed document and drops it from the list without a reload. */
  const deleteDocument = useCallback(async (documentId: string) => {
    setDeletingId(documentId);
    setDeleteError(null);
    try {
      const response = await window.teachforge.request<unknown>({
        method: 'DELETE',
        path: `/api/documents/${encodeURIComponent(documentId)}`,
      });
      if (response.status !== 200 || !isDeleteResult(response.data)) {
        throw new Error(readBackendErrorMessage(response.data, '删除失败，请重试。'));
      }
      setDocuments((current) => current.filter((document) => document.id !== documentId));
      setPendingDeleteId(null);
      setFileCleanupWarning(response.data.fileCleanup !== 'complete');
    } catch (error) {
      setDeleteError(describeFailure(error, '删除失败，请重试。'));
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-50/50">
      <PageHeader className="justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">资料库</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            aria-label="刷新资料列表"
            className="flex size-9 items-center justify-center rounded-lg text-ink-600 transition hover:bg-ink-100 hover:text-ink-900 disabled:cursor-wait disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
            disabled={listStatus === 'loading'}
            onClick={() => void loadDocuments()}
            title="刷新资料列表"
            type="button"
          >
            <ArrowClockwise
              aria-hidden="true"
              className={`size-4 ${listStatus === 'loading' ? 'animate-spin' : ''}`}
            />
          </button>
          <button
            className="flex items-center gap-2 rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-ink-700 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
            disabled={isPickingFiles || isImporting}
            onClick={() => void importDocuments()}
            type="button"
          >
            {isImporting ? (
              <CircleNotch aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <UploadSimple aria-hidden="true" className="size-4" />
            )}
            <span>{isImporting ? '正在导入…' : '导入资料'}</span>
          </button>
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8 md:py-8">
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col space-y-4 pb-8">
          {importError && (
            <div
              className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
              role="alert"
            >
              <span className="min-w-0 flex-1">{importError}</span>
              <button
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => setImportError(null)}
                type="button"
              >
                关闭
              </button>
            </div>
          )}

          {imports.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-ink-200 bg-white">
              <header className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-2.5">
                <h2 className="text-sm font-medium text-ink-800">本次导入</h2>
                <button
                  className="text-xs font-medium text-ink-500 underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={isImporting}
                  onClick={() => setImports([])}
                  type="button"
                >
                  清除记录
                </button>
              </header>
              <ul className="divide-y divide-ink-100">
                {imports.map((entry) => (
                  <li className="flex items-start gap-3 px-4 py-2.5 text-sm" key={entry.id}>
                    <ImportStateIcon state={entry.state} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink-800">{entry.name}</span>
                      {entry.message && (
                        <span
                          className={`mt-0.5 block text-xs ${
                            entry.state === 'failed' ? 'text-rose-700' : 'text-ink-500'
                          }`}
                        >
                          {entry.message}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {deleteError && (
            <div
              className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
              role="alert"
            >
              <span className="min-w-0 flex-1">{deleteError}</span>
              <button
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => setDeleteError(null)}
                type="button"
              >
                关闭
              </button>
            </div>
          )}

          {retryError && (
            <div
              className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              role="alert"
            >
              <span className="min-w-0 flex-1">{retryError}</span>
              <button
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => setRetryError(null)}
                type="button"
              >
                关闭
              </button>
            </div>
          )}

          {fileCleanupWarning && (
            <div
              className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              role="status"
            >
              <span className="min-w-0 flex-1">
                资料已删除，但有一个文件没能删掉，可以到工作空间里手动删除。
              </span>
              <button
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => setFileCleanupWarning(false)}
                type="button"
              >
                知道了
              </button>
            </div>
          )}

          {isImporting && pollFailures >= 2 && (
            <p className="text-xs text-ink-500" role="status">
              资料列表暂时刷新失败，正在继续重试；导入本身不受影响。
            </p>
          )}

          {listStatus === 'loading' ? (
            <p className="my-auto py-12 text-center text-sm text-ink-500" role="status">
              正在加载资料…
            </p>
          ) : listStatus === 'error' ? (
            <div
              className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-800"
              role="alert"
            >
              <p>{listError}</p>
              <button
                className="mt-3 font-medium underline underline-offset-2"
                onClick={() => void loadDocuments()}
                type="button"
              >
                重试
              </button>
            </div>
          ) : documents.length === 0 ? (
            <EmptyState
              className="my-auto"
              description="导入 PDF、Word、Markdown 或 TXT 后，提问和备课时会先在这些资料里找依据。"
              hint="点右上角「导入资料」开始，一次可以选多个文件。"
              icon={Books}
              title="把要讲的资料放进来"
            />
          ) : (
            <ul className="space-y-2">
              {documents.map((document) => (
                <DocumentRow
                  confirmDelete={pendingDeleteId === document.id}
                  deleting={deletingId === document.id}
                  document={document}
                  key={document.id}
                  onCancelDelete={() => setPendingDeleteId(null)}
                  onConfirmDelete={() => void deleteDocument(document.id)}
                  onRequestDelete={() => {
                    setDeleteError(null);
                    setPendingDeleteId(document.id);
                  }}
                  onRetryCatalog={() => void retryCatalog(document.id)}
                  retrying={retryingId === document.id}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** Renders one material with its status, an optional summary retry and two-step deletion. */
function DocumentRow({
  document,
  confirmDelete,
  deleting,
  retrying,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onRetryCatalog,
}: {
  document: DocumentSummary;
  confirmDelete: boolean;
  deleting: boolean;
  retrying: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onRetryCatalog: () => void;
}) {
  const latest = document.latest;
  const displayName = latest?.originalName ?? document.title;
  const busy =
    latest?.status === 'parsing' ||
    latest?.status === 'cataloging' ||
    latest?.status === 'chunking' ||
    retrying;

  return (
    <li className="rounded-xl border border-ink-200 bg-white px-4 py-3">
      <div className="flex items-start gap-3">
        <FileText aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ink-500" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-900" title={displayName}>
            {displayName}
          </p>
          <p className="mt-1 truncate text-xs text-ink-500">
            {[
              latest
                ? document.versionCount > 1
                  ? `v${latest.versionNo}`
                  : null
                : '还没导入完成',
              latest?.byteSize !== null && latest?.byteSize !== undefined
                ? formatBytes(latest.byteSize)
                : null,
              latest ? formatImportedAt(latest.createdAt) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {latest && <StatusBadge latest={latest} />}
      </div>

      {confirmDelete ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-3 text-xs text-ink-700">
          <span className="min-w-0 flex-1">
            确认删除「{displayName}」？删除后这份资料不会再出现在搜索和回答里。
          </span>
          <button
            className="rounded-lg px-3 py-1.5 font-medium text-ink-600 transition hover:bg-ink-100 disabled:opacity-40"
            disabled={deleting}
            onClick={onCancelDelete}
            type="button"
          >
            取消
          </button>
          <button
            className="flex items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-1.5 font-medium text-white transition hover:bg-rose-800 disabled:cursor-wait disabled:opacity-60"
            disabled={deleting}
            onClick={onConfirmDelete}
            type="button"
          >
            {deleting && <CircleNotch aria-hidden="true" className="size-3.5 animate-spin" />}
            <span>{deleting ? '正在删除…' : '删除'}</span>
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-end gap-2">
          {latest?.catalogStatus === 'failed' && (
            <button
              className="mr-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30 disabled:cursor-wait disabled:opacity-40"
              disabled={busy}
              onClick={onRetryCatalog}
              type="button"
            >
              {retrying && <CircleNotch aria-hidden="true" className="size-3.5 animate-spin" />}
              <span>{retrying ? '正在生成摘要…' : '重试摘要'}</span>
            </button>
          )}
          <button
            aria-label={`删除 ${displayName}`}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-500 transition hover:bg-ink-100 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30 disabled:cursor-wait disabled:opacity-40"
            disabled={deleting || busy}
            onClick={onRequestDelete}
            title={busy ? '处理完成后才能删除' : '删除这份资料'}
            type="button"
          >
            <Trash aria-hidden="true" className="size-3.5" />
            <span>删除</span>
          </button>
        </div>
      )}
    </li>
  );
}

/** Maps the latest version state to a Chinese label plus a distinct colour and icon. */
function StatusBadge({ latest }: { latest: NonNullable<DocumentSummary['latest']> }) {
  // A failed summary is not a failed file: the row keeps the source and offers a retry, so the badge
  // reports the degraded capability instead of "导入失败".
  const catalogFailed = latest.catalogStatus === 'failed';
  const label = catalogFailed ? '摘要未生成' : getStatusLabel(latest.status);
  const hint = catalogFailed ? CATALOG_FAILED_HINT : getStatusHint(latest.status);
  const className = catalogFailed
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : latest.status === 'ready'
      ? 'border-brand-200 bg-brand-50 text-brand-600'
      : latest.status === 'indexed'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : latest.status === 'failed'
          ? 'border-rose-200 bg-rose-50 text-rose-800'
          : 'border-ink-200 bg-ink-100 text-ink-700';
  const isBusy =
    latest.status === 'parsing' || latest.status === 'cataloging' || latest.status === 'chunking';

  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
      title={hint ?? undefined}
    >
      {isBusy ? (
        <CircleNotch aria-hidden="true" className="size-3 animate-spin" />
      ) : catalogFailed ? (
        <WarningCircle aria-hidden="true" className="size-3" />
      ) : latest.status === 'failed' ? (
        <XCircle aria-hidden="true" className="size-3" />
      ) : (
        <CheckCircle aria-hidden="true" className="size-3" />
      )}
      <span>{label}</span>
    </span>
  );
}

/** Renders the import feedback icon for one queued file. */
function ImportStateIcon({ state }: { state: ImportEntry['state'] }) {
  if (state === 'failed') {
    return <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-rose-600" />;
  }
  if (state === 'pending' || state === 'importing') {
    return (
      <CircleNotch
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 animate-spin text-ink-500"
      />
    );
  }
  if (state === 'duplicate') {
    return <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-400" />;
  }
  return <CheckCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-500" />;
}

/** Names a status for users who should not have to learn the internal lifecycle. */
function getStatusLabel(status: DocumentStatus): string {
  switch (status) {
    case 'ready':
      return '可以搜索';
    case 'indexed':
      return '只能关键词搜索';
    case 'failed':
      return '导入失败';
    case 'parsing':
      return '正在读取';
    case 'cataloging':
      return '正在生成摘要';
    case 'chunking':
      return '正在整理';
    default:
      return '未知';
  }
}

/** Explains a non-ready status in plain language; technical detail stays in the tooltip tail. */
function getStatusHint(status: DocumentStatus): string | null {
  switch (status) {
    case 'indexed':
      return '这份资料暂时只能用关键词搜索，还不能按意思搜索。';
    case 'failed':
      return '这份资料没能导入成功，可以删除后重新导入。';
    case 'parsing':
      return '正在读取文件内容…';
    case 'cataloging':
      return '正在生成资料摘要…';
    case 'chunking':
      return '正在整理内容，方便之后搜索…';
    default:
      return null;
  }
}

/**
 * Summarises one successful import without repeating the status label in the panel.
 *
 * The library is a directory of summaries plus converted text rather than a chunk index, so the
 * panel reports that the material is searchable and keeps the first parser warning only.
 */
function describeImportSuccess(result: ImportResult): string {
  const warning = result.warnings
    .map((entry) => getWarningCopy(entry.code))
    .find((copy): copy is string => Boolean(copy));
  return warning ? `已加入资料库 · ${warning}` : '已加入资料库';
}

/**
 * Translates warning codes into plain language.
 *
 * The API keeps the technical parser message for diagnostics; this list is the only place where a
 * reader with no AI background is expected to understand the outcome.
 */
function getWarningCopy(code: string): string | null {
  switch (code) {
    case 'EMBEDDING_FAILED':
      return '暂时只能用关键词搜索';
    case 'UPLOAD_COPY_FAILED':
      return '原文件没能另存到工作空间';
    case 'CATALOG_FAILED':
      return '目录摘要没生成成功';
    case 'TOC_LIKE':
      return '目录页已跳过';
    case 'MULTI_COLUMN_SUSPECTED':
      return '多栏排版的阅读顺序可能不准';
    case 'UNSTRUCTURED_TABLE':
      return '表格内容被简化成普通文字';
    case 'EMPTY_PAGE':
      return '空白页已跳过';
    case 'CONVERSION_MESSAGE':
      return '文件转换有提示，部分内容可能不完整';
    default:
      return '部分内容可能没有完整读取';
  }
}

/** Updates one import entry in place, keeping the newest entries first. */
function updateImport(
  setImports: React.Dispatch<React.SetStateAction<ImportEntry[]>>,
  id: number,
  update: (entry: ImportEntry) => ImportEntry,
): void {
  setImports((current) => current.map((entry) => (entry.id === id ? update(entry) : entry)));
}

/** Reads the trailing file name from an absolute path with either separator. */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Formats the latest import time with a stable Chinese locale. */
function formatImportedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Formats a byte count for the compact row metadata. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Validates one list row before it reaches the DOM. */
function isDocumentSummary(value: unknown): value is DocumentSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { id, title, isShared, versionCount, latest } = value as DocumentSummary;
  if (typeof id !== 'string' || typeof title !== 'string') return false;
  if (typeof isShared !== 'boolean' || typeof versionCount !== 'number') return false;
  if (latest === null) return true;
  if (typeof latest !== 'object') return false;
  return (
    typeof latest.versionNo === 'number' &&
    isDocumentStatus(latest.status) &&
    typeof latest.originalName === 'string' &&
    typeof latest.chunkCount === 'number' &&
    (latest.byteSize === null || typeof latest.byteSize === 'number') &&
    typeof latest.createdAt === 'string' &&
    (latest.processingError === null || typeof latest.processingError === 'string')
  );
}

/** Validates one delete response before showing a cleanup warning. */
function isDeleteResult(value: unknown): value is DeleteResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { documentId, fileCleanup } = value as DeleteResult;
  return (
    typeof documentId === 'string' && (fileCleanup === 'complete' || fileCleanup === 'partial')
  );
}

/** Validates one import response before showing its numbers. */
function isImportResult(value: unknown): value is ImportResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { documentId, chunkCount, status, duplicate, warnings } = value as ImportResult;
  return (
    typeof documentId === 'string' &&
    typeof chunkCount === 'number' &&
    isDocumentStatus(status) &&
    typeof duplicate === 'boolean' &&
    Array.isArray(warnings)
  );
}

/** Narrows a value to the known processing statuses. */
function isDocumentStatus(value: unknown): value is DocumentStatus {
  return (
    value === 'parsing' ||
    value === 'cataloging' ||
    value === 'chunking' ||
    value === 'indexed' ||
    value === 'ready' ||
    value === 'failed'
  );
}

/** Narrows a value to the known catalog states. */
function isCatalogStatus(value: unknown): value is CatalogStatus {
  return value === 'pending' || value === 'ready' || value === 'failed';
}

/** Validates one catalog retry response before the page reports its outcome. */
function isRetryResult(value: unknown): value is { documentId: string; catalogStatus: CatalogStatus } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { documentId, catalogStatus } = value as { documentId: unknown; catalogStatus: unknown };
  return typeof documentId === 'string' && isCatalogStatus(catalogStatus);
}
