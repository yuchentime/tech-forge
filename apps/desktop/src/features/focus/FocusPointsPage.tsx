import {
  ArrowRight,
  BookmarkSimple,
  NotePencil,
  Trash,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { showToast } from '../agent/toast';
import {
  deleteFocusItem,
  listFocusItems,
  updateFocusItemNote,
  type FocusItemView,
} from './focus-api';

/**
 * Lists saved assistant-message excerpts.
 *
 * The page owns only its own fetch and deletion; opening a conversation is delegated so the chat
 * view can load the full history and scroll to the stored message id.
 */
export function FocusPointsPage({
  onOpenConversation,
}: {
  /** Opens a conversation and scrolls to the saved message. */
  onOpenConversation: (conversationId: string, messageId: string) => void;
}) {
  const [items, setItems] = useState<FocusItemView[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);

  /** Replaces the list with the backend's current rows. */
  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    try {
      setItems(await listFocusItems());
      setStatus('ready');
      setError(null);
    } catch (failure) {
      setStatus('error');
      setError(
        failure instanceof Error ? failure.message : '读取重点关注失败，请重试。',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Deletes one row and keeps the rest of the list intact. */
  const removeItem = async (item: FocusItemView): Promise<void> => {
    if (deletingId) return;
    setDeletingId(item.id);
    try {
      await deleteFocusItem(item.id);
      setItems((current) => current.filter(({ id }) => id !== item.id));
      if (editingNoteId === item.id) {
        setEditingNoteId(null);
        setNoteDraft('');
      }
      showToast('已从重点关注移除');
    } catch (failure) {
      showToast(
        failure instanceof Error ? failure.message : '删除失败，请重试。',
      );
    } finally {
      setDeletingId(null);
    }
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
      setItems((current) =>
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

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-50/50">
      <PageHeader>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">重点关注</h1>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8 md:py-8">
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-3 pb-8">
          {status === 'loading' && (
            <p className="py-16 text-center text-sm text-ink-500">正在加载重点关注…</p>
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

          {status === 'ready' && items.length === 0 && (
            <EmptyState
              className="my-10"
              description="在对话模式里选中助手回复中的一段文字，点击「添加到重点关注」，它就会出现在这里。"
              hint="重点关注只保存在本机。"
              icon={BookmarkSimple}
              title="还没有重点关注"
            />
          )}

          {status === 'ready' && items.length > 0 && (
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <li
                  className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm"
                  key={item.id}
                >
                  <div className="flex items-start gap-4">
                    <blockquote className="min-w-0 flex-1 border-l-2 border-brand-500 pl-3">
                      <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-6 text-ink-800">
                        {item.quote}
                      </p>
                    </blockquote>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
                        onClick={() =>
                          onOpenConversation(item.conversationId, item.messageId)
                        }
                        type="button"
                      >
                        进入会话
                        <ArrowRight aria-hidden="true" className="size-4" />
                      </button>
                      <button
                        aria-label="删除这条重点关注"
                        className="rounded-lg p-2 text-ink-400 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
                        disabled={deletingId === item.id}
                        onClick={() => void removeItem(item)}
                        title="删除这条重点关注"
                        type="button"
                      >
                        <Trash aria-hidden="true" className="size-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 rounded-xl bg-ink-50/80 px-3 py-2">
                    {editingNoteId === item.id ? (
                      <div className="flex flex-col gap-2">
                        <textarea
                          autoFocus
                          className="tf-scrollbar min-h-20 w-full resize-y rounded-lg border border-ink-200 bg-white px-2.5 py-2 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-400 focus:border-brand-400"
                          onChange={(event) => setNoteDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelNoteEdit();
                            }
                            if (
                              event.key === 'Enter' &&
                              (event.metaKey || event.ctrlKey)
                            ) {
                              event.preventDefault();
                              void saveNote(item);
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
                              onClick={cancelNoteEdit}
                              type="button"
                            >
                              取消
                            </button>
                            <button
                              className="rounded-lg bg-brand-700 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-800 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                              disabled={savingNoteId === item.id}
                              onClick={() => void saveNote(item)}
                              type="button"
                            >
                              {savingNoteId === item.id ? '保存中…' : '保存备注'}
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
                          onClick={() => startNoteEdit(item)}
                          type="button"
                        >
                          编辑备注
                        </button>
                      </div>
                    ) : (
                      <button
                        className="inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-xs font-medium text-ink-500 transition hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
                        onClick={() => startNoteEdit(item)}
                        type="button"
                      >
                        <NotePencil aria-hidden="true" className="size-3.5" />
                        添加备注
                      </button>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                    <span className="max-w-[24rem] truncate font-medium text-ink-600">
                      {item.conversationTitle}
                    </span>
                    <span>第 {item.messageIndex} 条</span>
                    <time dateTime={item.createdAt}>
                      {formatDateTime(item.createdAt)}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** Short local date-time for saved excerpts. */
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
