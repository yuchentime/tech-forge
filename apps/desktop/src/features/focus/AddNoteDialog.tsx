import { NotePencil } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import type { ConversationSummary } from '../agent/conversation-store';

/** Matches the backend note limit; counted in Unicode code points so emoji count once. */
const NOTE_MAX_CHARACTERS = 2000;

/**
 * Captures one self-written note before it is saved.
 *
 * The conversation is optional: "不关联会话" saves a note that lives only on this page. The text
 * field starts three lines tall and Enter stays a newline; "保存笔记" or Ctrl/⌘+Enter submits,
 * while "取消", Esc or the backdrop discards the draft without writing.
 */
export function AddNoteDialog({
  conversations,
  onCancel,
  onSave,
}: {
  /** Conversations offered in the optional link dropdown, newest first. */
  conversations: readonly ConversationSummary[];
  onCancel: () => void;
  /** Persists the draft; a rejection keeps the dialog open with the typed text. */
  onSave: (input: { content: string; conversationId: string | null }) => Promise<void>;
}) {
  const [content, setContent] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentId = useId();
  const conversationFieldId = useId();
  const canSave = content.trim().length > 0 && !isSaving;

  // Escape must cancel even after a click moved focus onto the select or the backdrop.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isSaving) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSaving, onCancel]);

  /** Saves the draft with its optional conversation; failures stay in the dialog. */
  const submit = async (): Promise<void> => {
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      await onSave({
        content: content.trim(),
        conversationId: conversationId || null,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存笔记失败，请重试。');
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSaving) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-labelledby={`${contentId}-title`}
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-ink-200 bg-white p-5 shadow-float"
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <NotePencil aria-hidden="true" className="size-5" weight="fill" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900" id={`${contentId}-title`}>
              添加笔记
            </h2>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              写自己的理解、疑问或复习要点，可以关联一个会话方便回看。
            </p>
          </div>
        </div>

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label
            className="block text-xs font-medium text-ink-600"
            htmlFor={conversationFieldId}
          >
            会话（可选）
          </label>
          <select
            className="mt-1.5 w-full rounded-xl border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
            id={conversationFieldId}
            onChange={(event) => setConversationId(event.target.value)}
            value={conversationId}
          >
            <option value="">不关联会话</option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </select>

          <label className="mt-3 block text-xs font-medium text-ink-600" htmlFor={contentId}>
            笔记内容
          </label>
          <textarea
            autoFocus
            className="tf-scrollbar mt-1.5 max-h-48 w-full resize-none overflow-y-auto rounded-xl border border-ink-300 px-3 py-2 text-sm leading-6 text-ink-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
            id={contentId}
            onChange={(event) => {
              // Bound in code points so the draft never exceeds what the backend stores.
              setContent(
                Array.from(event.target.value).slice(0, NOTE_MAX_CHARACTERS).join(''),
              );
            }}
            onKeyDown={(event) => {
              // Ctrl/⌘+Enter saves; plain Enter stays a newline so notes can span lines.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="例如：幂等键要覆盖重试与重复投递，不要只依赖业务状态判断。"
            rows={3}
            value={content}
          />
          <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-ink-500">
            <span>Ctrl + Enter 保存</span>
            <span className="tabular-nums">
              {Array.from(content).length}/{NOTE_MAX_CHARACTERS}
            </span>
          </div>

          {error && (
            <p className="mt-2 text-xs text-rose-700" role="alert">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="rounded-xl border border-ink-200 bg-white px-4 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isSaving}
              onClick={onCancel}
              type="button"
            >
              取消
            </button>
            <button
              className="rounded-xl bg-brand-800 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              disabled={!canSave}
              type="submit"
            >
              {isSaving ? '正在保存…' : '保存笔记'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
