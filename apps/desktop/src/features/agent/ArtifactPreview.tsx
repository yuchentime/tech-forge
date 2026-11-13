import { useEffect, useState, type Ref } from 'react';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import type { GeneratedFileRef } from './artifact-store';
import { MarkdownContent } from './MarkdownContent';
import { MermaidDiagram, splitMermaidBlocks } from './MermaidDiagram';
import { SvgArtifact } from './SvgArtifact';
import { showToast } from './toast';

/** Mirrors the backend preview payload for one artifact. */
interface ArtifactContentResponse {
  id: string;
  fileName: string;
  contentFormat: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  byteSize: number | null;
  updatedAt: string;
}

/** Pretty-printing cap; larger JSON stays raw so the renderer never freezes. */
const MAX_PRETTY_JSON_CHARS = 256 * 1024;

/**
 * Shows one artifact read-only, choosing the preview by content format.
 *
 * `reloadToken` exists because the model rewrites files in place: the artifact keeps its id, so a
 * changed file produces no prop change. Bumping the token re-reads the same file on demand.
 */
export function ArtifactPreview({
  containerRef,
  file,
  reloadToken = 0,
}: {
  /** Scroll container the keyword search indexes; only the visible copy receives it. */
  containerRef?: Ref<HTMLDivElement>;
  file: GeneratedFileRef;
  reloadToken?: number;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; payload: ArtifactContentResponse }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    if (!hasDesktopBridge()) {
      setState({ status: 'error', message: '浏览器预览无法读取本地文件。' });
      return;
    }

    void (async () => {
      try {
        const response = await window.teachforge.request<ArtifactContentResponse>({
          method: 'GET',
          path: `/api/artifacts/${encodeURIComponent(file.id)}/content`,
        });
        if (cancelled) return;
        if (response.status !== 200) {
          setState({ status: 'error', message: '文件已不存在，无法预览。' });
          return;
        }
        setState({ status: 'ready', payload: response.data });
      } catch {
        if (cancelled) return;
        setState({ status: 'error', message: '读取文件失败，请稍后重试。' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.id, reloadToken]);

  useEffect(() => {
    if (state.status !== 'error') return;
    showToast(state.message);
  }, [state]);

  if (state.status === 'loading') {
    return <p className="p-4 text-sm text-ink-500">正在读取文件…</p>;
  }
  if (state.status === 'error') {
    return <p className="p-4 text-sm text-ink-600">{state.message}</p>;
  }

  const { payload } = state;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4"
      ref={containerRef}
    >
      {payload.binary && (
        <p className="text-sm text-ink-600">该文件不是文本，无法预览。</p>
      )}
      {!payload.binary && <ArtifactBody payload={payload} />}
      {payload.truncated && (
        <p className="text-xs text-ink-500">文件较大，预览只显示前一部分内容。</p>
      )}
    </div>
  );
}

/** Renders the text payload according to its detected format. */
function ArtifactBody({ payload }: { payload: ArtifactContentResponse }) {
  if (payload.contentFormat === 'mermaid') {
    return <MermaidDiagram code={payload.content} />;
  }

  if (payload.contentFormat === 'svg') {
    return <SvgArtifact content={payload.content} fileName={payload.fileName} />;
  }

  if (payload.contentFormat === 'markdown') {
    const blocks = splitMermaidBlocks(payload.content);
    return (
      <div className="space-y-3">
        {blocks.map((block, index) =>
          block.kind === 'mermaid' ? (
            <MermaidDiagram code={block.code} key={`mermaid-${index}`} />
          ) : (
            <MarkdownContent content={block.text} key={`markdown-${index}`} />
          ),
        )}
      </div>
    );
  }

  if (payload.contentFormat === 'json') {
    return (
      <pre className="overflow-x-auto rounded-lg bg-ink-100 p-3 text-xs leading-5 text-ink-800">
        {prettyPrintJson(payload.content)}
      </pre>
    );
  }

  return (
    <pre className="overflow-x-auto whitespace-pre rounded-lg bg-ink-100 p-3 text-xs leading-5 text-ink-800">
      {payload.content}
    </pre>
  );
}

/** Pretty-prints valid, small JSON and returns anything else untouched. */
function prettyPrintJson(content: string): string {
  if (content.length > MAX_PRETTY_JSON_CHARS) return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
