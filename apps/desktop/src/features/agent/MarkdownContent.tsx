import ReactMarkdown from 'react-markdown';
import { transformMarkdownUrl } from './AssistantMarkdown';
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdown-plugins';

/**
 * Renders Markdown that is not part of a chat message.
 *
 * The chat bubble uses assistant-ui's stream primitive, which reads the current message part; the
 * artifact preview has a plain string, so it renders with the same grammar, math pipeline and URL
 * policy directly.
 *
 * `className` replaces the default body typography so a denser surface (the classroom summary card)
 * can scale the same Markdown grammar down without forking the pipeline.
 */
export function MarkdownContent({
  content,
  className = 'text-[15px] leading-7 text-ink-800',
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={`agent-markdown ${className}`}>
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
