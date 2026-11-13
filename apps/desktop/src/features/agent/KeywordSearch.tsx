import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  buildDomSearchIndex,
  buildMatchRange,
  clearSearchHighlights,
  highlightSearchMatches,
  scrollToSearchMatch,
  type DomSearchIndex,
} from './dom-search';
import { findSearchMatches, type SearchMatch } from './search-text-index';

/**
 * One keyword search box bound to one scroll container.
 *
 * Enter walks forward and Shift+Enter back, Esc clears and closes. Hits are painted through the CSS
 * Custom Highlight API, so streaming Markdown and code blocks keep rendering untouched; only ranges
 * are rebuilt when the container mutates.
 */
export function KeywordSearch({
  className = '',
  containerRef,
  focusSeq = 0,
  isOpen,
  label,
  onOpenChange,
  size = 'lg',
}: {
  readonly className?: string;
  readonly containerRef: RefObject<HTMLElement | null>;
  /** Bumped by Ctrl+F so an already-open box can take focus again. */
  readonly focusSeq?: number;
  readonly isOpen: boolean;
  /** Doubles as the input's accessible name and placeholder. */
  readonly label: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly size?: 'lg' | 'sm';
}) {
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const domIndexRef = useRef<DomSearchIndex | null>(null);
  const matchesRef = useRef<readonly SearchMatch[]>([]);
  const activeIndexRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  /** Scrolls the container so the active hit sits in the middle. */
  const scrollToActiveMatch = useCallback(() => {
    const container = containerRef.current;
    const domIndex = domIndexRef.current;
    const match = matchesRef.current[activeIndexRef.current];
    if (container === null || domIndex === null || match === undefined) return;
    const range = buildMatchRange(domIndex, match);
    if (range !== null) scrollToSearchMatch(range, container);
  }, [containerRef]);

  /** Repaints both layers after the active hit changes. */
  const paint = useCallback(() => {
    const domIndex = domIndexRef.current;
    if (domIndex === null) return;
    highlightSearchMatches(domIndex, matchesRef.current, activeIndexRef.current);
  }, []);

  /**
   * Rebuilds the index and every range for the current query.
   *
   * `shouldScroll` is true only for user-driven runs: a streamed token must not drag the viewport
   * while the user is reading.
   */
  const runSearch = useCallback(
    (shouldScroll: boolean) => {
      const container = containerRef.current;
      if (!isOpen || container === null) {
        domIndexRef.current = null;
        matchesRef.current = [];
        activeIndexRef.current = 0;
        setMatchCount(0);
        return;
      }

      const domIndex = buildDomSearchIndex(container);
      const matches = findSearchMatches(domIndex.index, query);
      domIndexRef.current = domIndex;
      matchesRef.current = matches;
      setMatchCount(matches.length);

      const nextActive =
        matches.length === 0
          ? 0
          : Math.min(activeIndexRef.current, matches.length - 1);
      activeIndexRef.current = nextActive;
      setActiveIndex(nextActive);
      paint();
      if (shouldScroll) scrollToActiveMatch();
    },
    [containerRef, isOpen, paint, query, scrollToActiveMatch],
  );

  // A new query always restarts at the first hit; declared before the search effect so the reset is
  // visible to it in the same commit.
  useEffect(() => {
    activeIndexRef.current = 0;
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    runSearch(true);
  }, [runSearch]);

  // Both surfaces paint into one document-wide registry, so the layer is dropped on the transition
  // out of the open state instead of inside the search effect: React runs every cleanup before any
  // setup, which keeps the closing surface from wiping the one that just opened.
  useEffect(() => {
    if (!isOpen) return;
    return () => clearSearchHighlights();
  }, [isOpen]);

  // Streaming Markdown and file reloads replace text nodes under the ranges, so the index is rebuilt
  // once per animation frame at most while a query is active.
  useEffect(() => {
    const container = containerRef.current;
    if (!isOpen || container === null) return;

    const observer = new MutationObserver(() => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        runSearch(false);
      });
    });
    observer.observe(container, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [containerRef, isOpen, runSearch]);

  useEffect(() => {
    if (!isOpen) return;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [focusSeq, isOpen]);

  /** Moves to the next or previous hit, wrapping at both ends. */
  const moveTo = useCallback(
    (delta: number) => {
      const count = matchesRef.current.length;
      if (count === 0) return;
      const next = (((activeIndexRef.current + delta) % count) + count) % count;
      activeIndexRef.current = next;
      setActiveIndex(next);
      paint();
      scrollToActiveMatch();
    },
    [paint, scrollToActiveMatch],
  );

  /** Handles Esc and the Enter / Shift+Enter walk without stealing IME confirmation keys. */
  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery('');
        onOpenChange(false);
        return;
      }
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      moveTo(event.shiftKey ? -1 : 1);
    },
    [moveTo, onOpenChange],
  );

  const closeSearch = useCallback(() => {
    setQuery('');
    onOpenChange(false);
  }, [onOpenChange]);

  /**
   * Closes the box when focus leaves it while the query is empty.
   *
   * Focus moving between the box's own controls (input, close button) keeps it open, and a query
   * with content survives the focus loss so the user can scroll or copy without losing the search;
   * an empty box is dismissed instead of lingering as dead chrome.
   */
  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      if (query.trim() !== '') return;
      closeSearch();
    },
    [closeSearch, query],
  );

  const isCompact = size === 'sm';
  const counter =
    query.trim() === ''
      ? null
      : `${matchCount === 0 ? 0 : activeIndex + 1}/${matchCount}`;

  if (!isOpen) {
    return (
      <button
        aria-label={label}
        className={`flex shrink-0 items-center justify-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          isCompact
            ? 'size-7 rounded-md text-ink-500 hover:bg-ink-200 hover:text-ink-800'
            : // Same height as the 文件 entry beside it (30px: 16px icon + 6px padding + 2 x 1px
              // border) but a circular outline, so the two controls still read as one row.
              'size-[30px] rounded-full border border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-100'
        } ${className}`}
        onClick={() => onOpenChange(true)}
        title={`${label}（Ctrl+F）`}
        type="button"
      >
        <MagnifyingGlass aria-hidden="true" className="size-4" />
      </button>
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center gap-1 ${
        isCompact
          ? 'h-7 rounded-md border border-ink-200 bg-white pl-2 pr-0.5'
          : 'h-[30px] gap-1.5 rounded-lg border border-ink-200 bg-white pl-2.5 pr-0.5'
      } ${className}`}
      onBlur={handleBlur}
      role="search"
    >
      <MagnifyingGlass
        aria-hidden="true"
        className={`shrink-0 text-ink-500 ${isCompact ? 'size-3.5' : 'size-4'}`}
      />
      <input
        aria-label={label}
        className={`min-w-0 bg-transparent text-ink-900 outline-none placeholder:text-ink-400 ${
          isCompact ? 'w-32 text-xs' : 'w-40 text-sm'
        }`}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={label}
        ref={inputRef}
        spellCheck={false}
        type="text"
        value={query}
      />
      {counter !== null && (
        <span
          aria-live="polite"
          className={`shrink-0 tabular-nums text-ink-500 ${
            isCompact ? 'text-[11px]' : 'px-1 text-xs'
          }`}
          title="Enter 下一处，Shift+Enter 上一处"
        >
          {counter}
        </span>
      )}
      <button
        aria-label="关闭搜索"
        className={`flex shrink-0 items-center justify-center rounded-md text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          isCompact ? 'size-5' : 'size-6'
        }`}
        onClick={closeSearch}
        title="关闭搜索（Esc）"
        type="button"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
