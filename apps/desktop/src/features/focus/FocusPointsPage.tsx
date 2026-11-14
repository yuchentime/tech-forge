import {
  ArrowRight,
  BookmarkSimple,
  ChatCircle,
  NotePencil,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { showToast } from '../agent/toast';
import type { ConversationSummary } from '../agent/conversation-store';
import {
  deleteFocusItem,
  listFocusItems,
  updateFocusItemNote,
  type FocusItemView,
} from './focus-api';
import {
  createStudyNote,
  deleteStudyNote,
  listStudyNotes,
  type StudyNoteView,
} from './notes-api';
import { AddNoteDialog } from './AddNoteDialog';

/** One row of the page: a saved excerpt or a note the user wrote themselves. */
type StudyNoteEntry =
  | { kind: 'excerpt'; item: FocusItemView }
  | { kind: 'note'; item: StudyNoteView };

/**
 * Lists everything saved under 学习笔记: excerpts highlighted from assistant replies plus notes the
 * user writes on this page.
 *
 * The page owns its own fetch, writing and deletion; opening a conversation is delegated so the
 * chat view can load the full history and scroll to the stored message id.
 */
export function FocusPointsPage({
  conversations,
  onOpenConversation,
}: {
  /** Conversations offered when a new note is linked to one. */
  conversations: readonly ConversationSummary[];
  /** Opens a conversation, optionally scrolling to the saved message. */
  onOpenConversation: (conversationId: string, messageId?: string) => void;
}) {
  const [excerpts, setExcerpts] = useState<FocusItemView[]>([]);
  const [notes, setNotes] = useState<StudyNoteView[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  /** Replaces both lists with the backend's current rows. */
  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    try {
      const [savedExcerpts, savedNotes] = await Promise.all([
        listFocusItems(),
        listStudyNotes(),
      ]);
      setExcerpts(savedExcerpts);
      setNotes(savedNotes);
      setStatus('ready');
      setError(null);
    } catch (failure) {
      setStatus('error');
      setError(
        failure instanceof Error ? failure.message : '读取学习笔记失败，请重试。',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Deletes one excerpt and keeps the rest of the list intact. */
  const removeExcerpt = async (item: FocusItemView): Promise<void> => {
    if (deletingId) return;
    setDeletingId(item.id);
    try {
      await deleteFocusItem(item.id);
      setExcerpts((current) => current.filter(({ id }) => id !== item.id));
      if (editingNoteId === item.id) {
        setEditingNoteId(null);
        setNoteDraft('');
      }
      showToast('已从学习笔记移除');
    } catch (failure) {
      showToast(
        failure instanceof Error ? failure.message : '删除失败，请重试。',
      );
    } finally {
      setDeletingId(null);
    }
  };

  /** Deletes one self-written note. */
  const removeNote = async (note: StudyNoteView): Promise<void> => {
    if (deletingId) return;
    setDeletingId(note.id);
    try {
      await deleteStudyNote(note.id);
      setNotes((current) => current.filter(({ id }) => id !== note.id));
      showToast('已删除笔记');
    } catch (failure) {
      showToast(
        failure instanceof Error ? failure.message : '删除失败，请重试。',
      );
    } finally {
      setDeletingId(null);
    }
  };

  /** Saves a new note, prepends it and closes the dialog. */
  const addNote = async (input: {
    content: string;
    conversationId: string | null;
  }): Promise<void> => {
    const created = await createStudyNote({
      content: input.content,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    setNotes((current) => [created, ...current]);
    setIsAddDialogOpen(false);
    showToast('笔记已保存');
  };

  /** Opens the inline note editor for one excerpt. */
  const startNoteEdit = (item: FocusItemView): void => {
    setEditingNoteId(item.id);
    setNoteDraft(item.note ?? '');
  };

  /** Closes the note editor without writing. */
  const cancelNoteEdit = (): void => {
    setEditingNoteId(null);
    setNoteDraft('');
  };

  /** Saves the draft note; an empty draft clears the note. */
  const saveNote = async (item: FocusItemView): Promise<void> => {
    if (savingNoteId) return;
    setSavingNoteId(item.id);
    try {
      const updated = await updateFocusItemNote(item.id, noteDraft);
      setExcerpts((current) =>
        current.map((entry) => (entry.id === item.id ? updated : entry)),
      );
      setEditingNoteId(null);
      setNoteDraft('');
      showToast(updated.note ? '备注已保存' : '备注已清除');
    } catch (failure) {
      showToast(
        failure instanceof Error ? failure.message : '保存备注失败，请重试。',
      );
    } finally {
      setSavingNoteId(null);
    }
  };

  // Both resources keep their own rows; the page is one timeline, newest first.
  const entries: StudyNoteEntry[] = [
    ...excerpts.map((item) => ({ kind: 'excerpt' as const, item })),
    ...notes.map((item) => ({ kind: 'note' as const, item })),
  ].sort((left, right) =>
    right.item.createdAt.localeCompare(left.item.createdAt),
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-50/50">
      <PageHeader className="justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">学习笔记</h1>
        <button
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand-800 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          onClick={() => setIsAddDialogOpen(true)}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4" />
          添加笔记
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8 md:py-8">
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-3 pb-8">
          {status === 'loading' && (
            <p className="py-16 text-center text-sm text-ink-500">正在加载学习笔记…</p>
          )}

          {status === 'error' && (
            <div
              className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
              role="alert"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <button
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => void load()}
                type="button"
              >
                重试
              </button>
            </div>
          )}

          {status === 'ready' && entries.length === 0 && (
            <EmptyState
              className="my-10"
              description="点右上角「添加笔记」写下自己的理解；在对话模式里选中助手回复的一段文字，也能把它连同摘录一起存进来。"
              hint="学习笔记只保存在本机。"
              icon={BookmarkSimple}
              title="还没有学习笔记"
            />
          )}

          {status === 'ready' && entries.length > 0 && (
            <ul className="flex flex-col gap-3">
              {entries.map((entry) =>
                entry.kind === 'excerpt' ? (
                  <ExcerptCard
                    deletingId={deletingId}
                    editingNoteId={editingNoteId}
                    item={entry.item}
                    key={entry.item.id}
                    noteDraft={noteDraft}
                    onCancelNoteEdit={cancelNoteEdit}
                    onDelete={removeExcerpt}
                    onNoteDraftChange={setNoteDraft}
                    onOpenConversation={onOpenConversation}
                    onSaveNote={saveNote}
                    onStartNoteEdit={startNoteEdit}
                    savingNoteId={savingNoteId}
                  />
                ) : (
                  <NoteCard
                    deletingId={deletingId}
                    key={entry.item.id}
                    note={entry.item}
                    onDelete={removeNote}
                    onOpenConversation={onOpenConversation}
                  />
                ),
              )}
            </ul>
          )}
        </div>
      </div>

      {isAddDialogOpen && (
        <AddNoteDialog
          conversations={conversations}
          onCancel={() => setIsAddDialogOpen(false)}
          onSave={addNote}
        />
      )}
    </section>
  );
}

/** One excerpt saved from an assistant reply, with its optional note and message anchor. */
function ExcerptCard({
  item,
  deletingId,
  editingNoteId,
  noteDraft,
  savingNoteId,
  onDelete,
  onStartNoteEdit,
  onCancelNoteEdit,
  onNoteDraftChange,
  onSaveNote,
  onOpenConversation,
}: {
  item: FocusItemView;
  deletingId: string | null;
  editingNoteId: string | null;
  noteDraft: string;
  savingNoteId: string | null;
  onDelete: (item: FocusItemView) => Promise<void>;
  onStartNoteEdit: (item: FocusItemView) => void;
  onCancelNoteEdit: () => void;
  onNoteDraftChange: (draft: string) => void;
  onSaveNote: (item: FocusItemView) => Promise<void>;
  onOpenConversation: (conversationId: string, messageId?: string) => void;
}) {
  const isEditing = editingNoteId === item.id;
  const isSaving = savingNoteId === item.id;

  return (
    <li className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-4">
        <blockquote className="min-w-0 flex-1 border-l-2 border-brand-500 pl-3">
          <ClampedText text={item.quote} />
        </blockquote>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
            onClick={() => onOpenConversation(item.conversationId, item.messageId)}
            type="button"
          >
            进入会话
            <ArrowRight aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-label="删除这条学习笔记"
            className="rounded-lg p-2 text-ink-400 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
            disabled={deletingId === item.id}
            onClick={() => void onDelete(item)}
            title="删除这条学习笔记"
            type="button"
          >
            <Trash aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <div className="mt-3 rounded-xl bg-ink-50/80 px-3 py-2">
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              className="tf-scrollbar min-h-20 w-full resize-y rounded-lg border border-ink-200 bg-white px-2.5 py-2 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-400 focus:border-brand-400"
              onChange={(event) => onNoteDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancelNoteEdit();
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void onSaveNote(item);
                }
              }}
              placeholder="写下这条摘录的备注…"
              value={noteDraft}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-ink-400">
                {Array.from(noteDraft).length} / 2000 · Ctrl + Enter 保存
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-600 transition hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
                  onClick={onCancelNoteEdit}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="rounded-lg bg-brand-700 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-800 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                  disabled={isSaving}
                  onClick={() => void onSaveNote(item)}
                  type="button"
                >
                  {isSaving ? '保存中…' : '保存备注'}
                </button>
              </div>
            </div>
          </div>
        ) : item.note ? (
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-ink-700">
              {item.note}
            </p>
            <button
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
              onClick={() => onStartNoteEdit(item)}
              type="button"
            >
              编辑备注
            </button>
          </div>
        ) : (
          <button
            className="inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-xs font-medium text-ink-500 transition hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
            onClick={() => onStartNoteEdit(item)}
            type="button"
          >
            <NotePencil aria-hidden="true" className="size-3.5" />
            添加备注
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
        <span
          className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink-800"
          title={item.conversationTitle}
        >
          <ChatCircle
            aria-hidden="true"
            className="size-3.5 shrink-0 text-brand-600"
          />
          <span className="break-words">{item.conversationTitle}</span>
        </span>
        <span>第 {item.messageIndex} 条</span>
        <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
      </div>
    </li>
  );
}

/**
 * One note the user wrote themselves.
 *
 * It renders as plain text without the excerpt's quote rail: there is no selected source, and the
 * conversation is only shown when the note was linked to one.
 */
function NoteCard({
  note,
  deletingId,
  onDelete,
  onOpenConversation,
}: {
  note: StudyNoteView;
  deletingId: string | null;
  onDelete: (note: StudyNoteView) => Promise<void>;
  onOpenConversation: (conversationId: string, messageId?: string) => void;
}) {
  const { conversationId } = note;
  return (
    <li className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <ClampedText text={note.content} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {conversationId && (
            <button
              className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
              onClick={() => onOpenConversation(conversationId)}
              type="button"
            >
              进入会话
              <ArrowRight aria-hidden="true" className="size-4" />
            </button>
          )}
          <button
            aria-label="删除这条笔记"
            className="rounded-lg p-2 text-ink-400 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
            disabled={deletingId === note.id}
            onClick={() => void onDelete(note)}
            title="删除这条笔记"
            type="button"
          >
            <Trash aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
        {note.conversationTitle && (
          <span
            className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink-800"
            title={note.conversationTitle}
          >
            <ChatCircle
              aria-hidden="true"
              className="size-3.5 shrink-0 text-brand-600"
            />
            <span className="break-words">{note.conversationTitle}</span>
          </span>
        )}
        <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
      </div>
    </li>
  );
}

/**
 * Clamped body text with an explicit expand control, shared by excerpts and self-written notes.
 *
 * `line-clamp-4` hides the overflow; measuring the clamped element tells us whether "查看" is
 * needed. The control stays visible after expanding so the block can collapse again.
 */
function ClampedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    if (expanded) return;
    const element = textRef.current;
    if (!element) return;
    const measure = (): void => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <>
      <p
        className={`whitespace-pre-wrap break-words text-sm leading-6 text-ink-800 ${
          expanded ? '' : 'line-clamp-4'
        }`}
        ref={textRef}
      >
        {text}
      </p>
      {isOverflowing && (
        <button
          className="mt-1 rounded text-xs font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? '收起' : '查看'}
        </button>
      )}
    </>
  );
}

/** Short local date-time for saved notes. */
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
