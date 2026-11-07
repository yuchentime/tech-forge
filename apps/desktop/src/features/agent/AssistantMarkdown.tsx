import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders assistant text parts with the official assistant-ui streaming Markdown primitive. */
export function AssistantMarkdown() {
  return (
    <MarkdownTextPrimitive
      className="agent-markdown"
      remarkPlugins={[remarkGfm]}
      urlTransform={transformMarkdownUrl}
    />
  );
}

/** Blocks remote image loads and unsafe or local-file URL schemes from model output. */
function transformMarkdownUrl(url: string, key: string): string {
  if (key === 'src') return '';

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
  if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) return '';

  return url;
}
