import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { transformMarkdownUrl } from './AssistantMarkdown';

/**
 * Renders Markdown that is not part of a chat message.
 *
 * The chat bubble uses assistant-ui's stream primitive, which reads the current message part; the
 * artifact preview has a plain string, so it renders with the same grammar and URL policy directly.
 */
export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="agent-markdown text-[15px] leading-7 text-stone-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={transformMarkdownUrl}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
