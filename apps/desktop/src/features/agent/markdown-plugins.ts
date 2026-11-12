import type { Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
// KaTeX ships its own metrics and font-face rules; without them formulas render as broken text.
import 'katex/dist/katex.min.css';

/**
 * Shared Markdown pipeline for every model-authored surface (chat bubbles and artifact previews).
 *
 * `remark-math` turns `$…$` and `$$…$$` into math nodes, `rehype-katex` renders them to KaTeX markup.
 * `throwOnError: false` keeps a malformed formula inside the document as red text instead of
 * rejecting the whole file, and `strict: 'ignore'` drops KaTeX's console warnings about CJK
 * characters that land between two currency-like `$` signs.
 */
export const markdownRemarkPlugins: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkMath];

export const markdownRehypePlugins: NonNullable<Options['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
];
