import ReactMarkdown from 'react-markdown';
import { transformMarkdownUrl } from './AssistantMarkdown';
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdown-plugins';

/**
 * Renders Markdown that is not part of a chat message.
 *
 * The chat bubble uses assistant-ui's stream primitive, which reads the current message part; the
 * artifact preview has a plain string, so it renders with the same grammar, math pipeline and URL
 * policy directly.
 */
export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="agent-markdown text-[15px] leading-7 text-ink-800">
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        urlTransform={transformMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
