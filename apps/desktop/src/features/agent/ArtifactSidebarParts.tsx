import { useCallback } from 'react';
import { FilePlus, FileText, Files, FolderOpen, X } from '@phosphor-icons/react';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import {
  ALL_FILES_TAB_ID,
  artifactTabsStore,
  type GeneratedFileRef,
} from './artifact-store';
import { showToast } from './toast';

/** Mirrors the backend location payload used to reveal one file. */
interface ArtifactLocationResponse {
  directory: string;
  filePath: string;
  fileExists: boolean;
  directoryExists: boolean;
}

/**
 * Opens the operating system file manager at one artifact.
 *
 * The path comes from the artifact API, never from the Renderer, so the shell only ever navigates
 * to files the conversation produced.
 */
export async function revealArtifact(artifactId: string): Promise<void> {
  if (!hasDesktopBridge()) {
    showToast('浏览器预览无法打开本地目录。');
    return;
  }
  try {
    const response = await window.teachforge.request<ArtifactLocationResponse>({
      method: 'GET',
      path: `/api/artifacts/${encodeURIComponent(artifactId)}/location`,
    });
    if (response.status !== 200) {
      showToast('文件不存在');
      return;
    }
    const revealed = await window.teachforge.revealInFolder(response.data.filePath);
    if (revealed) return;
    showToast(
      response.data.directoryExists ? '无法打开文件目录' : '文件不存在',
    );
  } catch {
    showToast('无法打开文件目录');
  }
}

/** Opens one artifact in the sidebar, reporting a missing file instead of an empty tab. */
export function openArtifactTab(file: GeneratedFileRef): void {
  if (file.missing) {
    showToast('文件不存在');
    return;
  }
  artifactTabsStore.open(file);
}

/** Renders one clickable file row: open preview, or reveal its directory. */
export function ArtifactFileRow({
  file,
  active,
}: {
  file: GeneratedFileRef;
  active?: boolean;
}) {
  const handleReveal = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      void revealArtifact(file.id);
    },
    [file.id],
  );

  return (
    <div
      className={`group flex w-full items-center gap-1 rounded-lg pr-1 transition ${
        active ? 'bg-emerald-50' : 'hover:bg-stone-200/70'
      }`}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm text-stone-800"
        onClick={() => openArtifactTab(file)}
        title={file.fileName}
        type="button"
      >
        <FileText aria-hidden="true" className="size-4 shrink-0 text-stone-500" />
        <span className={`min-w-0 flex-1 truncate ${file.missing ? 'text-stone-400' : ''}`}>
          {file.fileName}
        </span>
      </button>
      <button
        aria-label="打开文件目录"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-200 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/30"
        onClick={handleReveal}
        title="打开文件目录"
        type="button"
      >
        <FolderOpen aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/**
 * Renders the conversation header entry that opens or collapses the artifact panel.
 *
 * It stays hidden until the conversation has produced a file, so the header carries no dead
 * control; while the panel is open the same button collapses it.
 */
export function ArtifactEntry({ count, visible }: { count: number; visible: boolean }) {
  if (count === 0) return null;

  return (
    <button
      aria-expanded={visible}
      aria-label={`${visible ? '收起' : '查看'}本会话生成的 ${count} 个文件`}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition ${
        visible
          ? 'border-emerald-800/30 bg-emerald-50 text-emerald-900'
          : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-100'
      }`}
      onClick={() => artifactTabsStore.toggleAll()}
      title={visible ? '收起文件侧边栏' : '查看本会话生成的文件'}
      type="button"
    >
      <Files aria-hidden="true" className="size-4" />
      <span>文件</span>
      <span className="rounded-full bg-stone-200/80 px-1.5 text-xs font-semibold tabular-nums text-stone-700">
        {count}
      </span>
    </button>
  );
}

/** Renders the files one response changed, as a card with a bold count header. */
export function ArtifactFileChips({ files }: { files: readonly GeneratedFileRef[] }) {
  if (files.length === 0) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 bg-stone-50/70">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-stone-200/80">
          <FilePlus aria-hidden="true" className="size-4 text-stone-700" />
        </span>
        <p className="min-w-0 flex-1 text-sm font-semibold text-stone-900">
          已更改 {files.length} 个文件
        </p>
        <button
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-stone-600 transition hover:bg-stone-200/80 hover:text-stone-900"
          onClick={() => artifactTabsStore.showAll()}
          type="button"
        >
          查看全部
        </button>
      </div>
      <ul className="border-t border-stone-200 bg-white">
        {files.map((file) => (
          <li
            className="group flex items-center gap-1 border-b border-stone-100 transition last:border-b-0 hover:bg-stone-100"
            key={file.id}
          >
            <button
              className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm transition ${
                file.missing ? 'text-stone-400' : 'text-stone-800 group-hover:text-stone-900'
              }`}
              onClick={() => openArtifactTab(file)}
              title={file.fileName}
              type="button"
            >
              <FileText aria-hidden="true" className="size-4 shrink-0 text-stone-500" />
              <span
                className={`min-w-0 truncate ${
                  file.missing
                    ? ''
                    : 'underline decoration-stone-300 decoration-1 underline-offset-2 group-hover:decoration-stone-600'
                }`}
              >
                {file.fileName}
              </span>
            </button>
            <button
              aria-label="打开文件目录"
              className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-200 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/30"
              onClick={(event) => {
                event.stopPropagation();
                void revealArtifact(file.id);
              }}
              title="打开文件目录"
              type="button"
            >
              <FolderOpen aria-hidden="true" className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Renders the tab strip shared by the whole-files tab and open file tabs. */
export function ArtifactTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onClosePanel,
}: {
  tabs: readonly GeneratedFileRef[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onClosePanel: () => void;
}) {
  return (
    <div className="flex shrink-0 items-stretch border-b border-stone-200">
      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-2 py-1.5">
        <button
          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
            activeId === ALL_FILES_TAB_ID
              ? 'bg-stone-900 text-white'
              : 'text-stone-700 hover:bg-stone-200/70'
          }`}
          onClick={() => onActivate(ALL_FILES_TAB_ID)}
          title="本会话文件"
          type="button"
        >
          <FolderOpen aria-hidden="true" className="size-4" />
          <span>本会话文件</span>
        </button>
        {tabs.map((tab) => (
          <div
            className={`flex shrink-0 items-center gap-1 rounded-lg pl-2.5 text-sm transition ${
              activeId === tab.id
                ? 'bg-emerald-50 text-emerald-900'
                : 'text-stone-700 hover:bg-stone-200/70'
            }`}
            key={tab.id}
          >
            <button
              className="max-w-40 truncate py-1.5 text-left"
              onClick={() => onActivate(tab.id)}
              title={tab.fileName}
              type="button"
            >
              {tab.fileName}
            </button>
            <button
              aria-label={`关闭 ${tab.fileName}`}
              className="flex size-6 items-center justify-center rounded-md text-stone-500 hover:bg-stone-300/60 hover:text-stone-800"
              onClick={() => onClose(tab.id)}
              title="关闭"
              type="button"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button
        aria-label="关闭文件侧边栏"
        className="my-1 mr-1 flex size-7 shrink-0 items-center justify-center self-center rounded-md text-stone-500 transition hover:bg-stone-200 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/30"
        onClick={onClosePanel}
        title="关闭"
        type="button"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
