import { useAui, useAuiState } from '@assistant-ui/react';
import { Database, MagnifyingGlass } from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { composerCommandStore } from './composer-command-store';
import { SLASH_COMMANDS, type SlashCommandItem } from './slash-commands';

/**
 * Reads the trigger query out of the draft.
 *
 * Only a draft that is still just `/` plus unspaced characters opens the menu: once the user types a
 * space (or text before the slash) the command is either finished or not a command at all.
 */
function readSlashQuery(text: string): string | null {
  const match = /^\s*\/([^\s/]*)$/.exec(text);
  return match ? match[1] : null;
}

/** Behaviour of the composer slash menu: matching, keyboard navigation and insertion. */
export interface SlashCommandMenuState {
  open: boolean;
  matches: readonly SlashCommandItem[];
  highlightedIndex: number;
  setHighlightedIndex: (index: number) => void;
  select: (item: SlashCommandItem) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Drives a slash menu inside the assistant-ui composer.
 *
 * Typing `/` opens the menu; Enter or a click turns on the command chip and clears the slash, so the
 * textarea holds only the user's question. A textarea cannot render an inline chip, so the chip is a
 * sibling element and the command is prepended when the turn is sent. Ctrl/Cmd+Enter still sends.
 */
export function useSlashCommandMenu(
  inputRef: RefObject<HTMLTextAreaElement | null>,
): SlashCommandMenuState {
  const aui = useAui();
  // Mirrors assistant-ui's own selector: only an editing composer owns the draft.
  const text = useAuiState((state) => (state.composer.isEditing ? state.composer.text : ''));
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const query = readSlashQuery(text);
  const matches =
    query === null
      ? []
      : SLASH_COMMANDS.filter(
          (command) =>
            query === '' ||
            command.label.includes(query) ||
            command.insert.trim().endsWith(query),
        );
  const open = matches.length > 0 && dismissedFor !== text;

  const select = useCallback(
    (item: SlashCommandItem) => {
      // Clear the slash so the sent text is the question alone...
      aui.composer.setText('');
      // ...and attach the command as a chip; the adapter prepends it when the turn is sent.
      composerCommandStore.setCommand(item.insert.trim());
      setDismissedFor(null);
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      requestAnimationFrame(() => node.setSelectionRange(0, 0));
    },
    [aui, inputRef],
  );

  useEffect(() => {
    setHighlightedIndex(0);
  }, [text]);

  // Dismissal lasts only while the draft stays exactly as it was. Editing the text (including
  // deleting the slash and typing it again) must reopen the menu; without this an Esc latched it
  // closed for the rest of the conversation.
  useEffect(() => {
    if (dismissedFor !== null && text !== dismissedFor) setDismissedFor(null);
  }, [text, dismissedFor]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open) return;
      // Never steal the send shortcut or fight an IME composition.
      if (event.nativeEvent.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        select(matches[Math.min(highlightedIndex, matches.length - 1)]);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Escape') {
        // Close the menu without erasing what the user typed.
        event.preventDefault();
        setDismissedFor(text);
      }
    },
    [open, highlightedIndex, matches, select, text],
  );

  return { open, matches, highlightedIndex, setHighlightedIndex, select, handleKeyDown };
}

/**
 * Renders the slash menu floating above the composer input.
 *
 * Absolutely positioned against the composer, so opening it never changes the composer height or the
 * page layout. One row per command in body text: icon, name, one-line explanation.
 */
export function SlashCommandMenu({ menu }: { menu: SlashCommandMenuState }) {
  if (!menu.open) return null;
  return (
    <div
      aria-label="斜杠命令"
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto overflow-x-hidden rounded-lg border border-ink-200 bg-white shadow-lg"
      role="listbox"
    >
      {menu.matches.map((item, index) => (
        <button
          aria-selected={index === menu.highlightedIndex}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition ${
            index === menu.highlightedIndex ? 'bg-ink-100' : 'hover:bg-ink-50'
          }`}
          key={item.id}
          onClick={() => menu.select(item)}
          onMouseEnter={() => menu.setHighlightedIndex(index)}
          role="option"
          type="button"
        >
          {item.icon === 'research' ? (
            <MagnifyingGlass className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
          ) : (
            <Database className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
          )}
          <span className="shrink-0 font-medium text-ink-900">{item.label}</span>
          <span className="min-w-0 flex-1 truncate text-ink-500">{item.description}</span>
        </button>
      ))}
    </div>
  );
}
