import {
  buildSearchText,
  locateSearchMatch,
  type SearchMatch,
  type SearchTextIndex,
  type SearchTextPart,
} from './search-text-index';

/**
 * Reads one rendered surface for keyword search.
 *
 * The renderer cannot wrap hits in `<mark>`: the chat thread rebuilds its DOM on every streamed
 * token, so injected nodes would be thrown away or conflict with React. Instead the text nodes are
 * indexed here and each hit becomes a `Range`, painted through the CSS Custom Highlight API.
 */

/** Elements whose boundaries end a matchable text run. */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

/**
 * Subtrees that are chrome or duplicated markup rather than searchable content.
 *
 * `katex-mathml` is KaTeX's accessible copy of the formula the visible glyphs already show; indexing
 * it would report every formula hit twice.
 */
const SKIPPED_SELECTOR = [
  '[data-search-ignore]',
  '.katex-mathml',
  'script',
  'style',
  'noscript',
  'textarea',
  'input',
  'select',
].join(',');

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Highlight registry names shared by both search surfaces. */
export const SEARCH_HIGHLIGHT_NAME = 'tf-find';
export const SEARCH_CURRENT_HIGHLIGHT_NAME = 'tf-find-current';

/** One surface's text index plus the node behind every text part. */
export interface DomSearchIndex {
  readonly index: SearchTextIndex;
  /** Text node for each part index; `null` marks a separator part. */
  readonly nodes: readonly (Text | null)[];
}

/** Indexes every searchable text node under `root`. */
export function buildDomSearchIndex(root: HTMLElement): DomSearchIndex {
  const parts: SearchTextPart[] = [];
  const nodes: (Text | null)[] = [];
  collectParts(root, parts, nodes);
  return { index: buildSearchText(parts), nodes };
}

/** Walks one subtree, recording text runs and the block boundaries between them. */
function collectParts(
  node: Node,
  parts: SearchTextPart[],
  nodes: (Text | null)[],
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    if (text.data.length === 0) return;
    parts.push({ text: text.data });
    nodes.push(text);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  // Diagram labels cannot be highlighted by the Custom Highlight API, so they are not searchable
  // either; reporting a hit nothing can show would break the match counter.
  if (element.namespaceURI === SVG_NAMESPACE) return;
  if (element.matches(SKIPPED_SELECTOR)) return;

  const isBlock = BLOCK_TAGS.has(element.tagName);
  if (isBlock) {
    parts.push({ separator: true });
    nodes.push(null);
  }
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    collectParts(child, parts, nodes);
  }
  if (isBlock) {
    parts.push({ separator: true });
    nodes.push(null);
  }
}

/** Builds the DOM range for one hit, or `null` when its nodes are gone. */
export function buildMatchRange(
  domIndex: DomSearchIndex,
  match: SearchMatch,
): Range | null {
  const location = locateSearchMatch(domIndex.index, match);
  if (!location) return null;

  const startNode = domIndex.nodes[location.startPart];
  const endNode = domIndex.nodes[location.endPart];
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  try {
    range.setStart(startNode, Math.min(location.startOffset, startNode.length));
    range.setEnd(endNode, Math.min(location.endOffset, endNode.length));
  } catch {
    // A node replaced between indexing and painting leaves a stale match; it is re-indexed on the
    // next mutation.
    return null;
  }
  return range;
}

/** Reports whether the renderer can paint ranges without touching the DOM. */
export function supportsSearchHighlights(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof Highlight === 'function'
  );
}

/** Paints every hit and, distinctly, the one Enter is currently on. */
export function highlightSearchMatches(
  domIndex: DomSearchIndex,
  matches: readonly SearchMatch[],
  activeIndex: number,
): void {
  if (!supportsSearchHighlights()) return;

  const ranges: Range[] = [];
  let current: Range | null = null;
  matches.forEach((match, index) => {
    const range = buildMatchRange(domIndex, match);
    if (!range) return;
    ranges.push(range);
    if (index === activeIndex) current = range;
  });

  CSS.highlights.set(SEARCH_HIGHLIGHT_NAME, new Highlight(...ranges));
  if (current) {
    CSS.highlights.set(SEARCH_CURRENT_HIGHLIGHT_NAME, new Highlight(current));
  } else {
    CSS.highlights.delete(SEARCH_CURRENT_HIGHLIGHT_NAME);
  }
}

/** Removes both highlight layers. */
export function clearSearchHighlights(): void {
  if (!supportsSearchHighlights()) return;
  CSS.highlights.delete(SEARCH_HIGHLIGHT_NAME);
  CSS.highlights.delete(SEARCH_CURRENT_HIGHLIGHT_NAME);
}

/**
 * Brings one hit into the middle of its scroll container.
 *
 * Horizontal overflow (code blocks) is handled first so the vertical centring below measures the
 * final layout.
 */
export function scrollToSearchMatch(range: Range, container: HTMLElement): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  let scroller = range.startContainer.parentElement;
  while (scroller !== null && scroller !== container) {
    if (scroller.scrollWidth > scroller.clientWidth + 1) {
      const box = scroller.getBoundingClientRect();
      scroller.scrollLeft += rect.left - box.left - box.width / 2 + rect.width / 2;
    }
    scroller = scroller.parentElement;
  }

  const containerBox = container.getBoundingClientRect();
  container.scrollTop +=
    rect.top - containerBox.top - containerBox.height / 2 + rect.height / 2;
}
