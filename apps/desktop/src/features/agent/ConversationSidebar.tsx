import {
  Books,
  ChatCircle,
  DotsThree,
  GearSix,
  NotePencil,
  Stack,
} from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  CONVERSATION_TITLE_MAX_CHARACTERS,
  type ConversationStoreSnapshot,
  type ConversationSummary,
} from './conversation-store';

/** Views the sidebar can switch the main area to; `chat` is the conversation view. */
export type SidebarView = 'chat' | 'settings' | 'knowledge' | 'knowledgeProfile';

/** Renders the conversation list and actions without owning API or runtime state. */
export function ConversationSidebar({
  state,
  isBusy,
  runningConversationIds = new Set<string>(),
  loadingConversationId,
  onNewConversation,
  onRefresh,
  onSelect,
  onDelete,
  onRename,
  activeView,
  onSelectView,
}: {
  state: ConversationStoreSnapshot;
  isBusy: boolean;
  runningConversationIds?: ReadonlySet<string>;
  loadingConversationId: string | null;
  onNewConversation: () => void;
  onRefresh: () => void;
  onSelect: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => Promise<void>;
  activeView: SidebarView;
  onSelectView: (view: SidebarView) => void;
}) {
  return (
    <aside
      aria-label="对话列表"
      className="tf-sidebar-art relative isolate flex h-48 min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-ink-200/60 md:h-full md:w-64 md:border-b-0 md:border-r"
    >
      <header className="relative z-10 shrink-0 border-b border-ink-200/70 px-2 py-2">
        <div className="flex items-center">
          <button
            aria-label="新建课题"
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-sm font-medium text-ink-800 transition hover:bg-white/70 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isBusy}
            onClick={onNewConversation}
            title="新建课题"
            type="button"
          >
            <NotePencil aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">新建课题</span>
          </button>
        </div>
        <button
          aria-label={activeView === 'knowledge' ? '返回对话' : '打开资料库'}
          aria-pressed={activeView === 'knowledge'}
          className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30 ${
            activeView === 'knowledge'
              ? 'bg-brand-100 text-brand-800'
              : 'text-ink-600 hover:bg-white/70 hover:text-ink-900'
          }`}
          onClick={() => onSelectView('knowledge')}
          title="资料库"
          type="button"
        >
          <Books aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">资料库</span>
        </button>
        <button
          aria-pressed={activeView === 'knowledgeProfile'}
          className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30 ${
            activeView === 'knowledgeProfile'
              ? 'bg-brand-100 text-brand-800'
              : 'text-ink-600 hover:bg-white/70 hover:text-ink-900'
          }`}
          onClick={() => onSelectView('knowledgeProfile')}
          title="知识掌握"
          type="button"
        >
          <Stack aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">知识掌握</span>
        </button>
      </header>

      {state.listError && (
        <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-rose-700" role="alert">
          <span className="min-w-0 flex-1">{state.listError}</span>
          <button
            className="shrink-0 font-medium underline underline-offset-2"
            onClick={onRefresh}
            type="button"
          >
            重试
          </button>
        </div>
      )}

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-24">
        {state.conversations.length === 0 ? (
          <p className="px-3 py-5 text-center text-xs leading-5 text-ink-500">
            {state.listStatus === 'loading'
              ? '正在加载对话…'
              : state.listStatus === 'error'
                ? '暂时无法显示对话。'
                : '还没有对话记录。'}
          </p>
        ) : (
          <ul className="space-y-1">
            {state.conversations.map((conversation) => (
              <ConversationRow
                activeConversationId={state.activeConversationId}
                conversation={conversation}
                isChatView={activeView === 'chat'}
                isRunning={runningConversationIds.has(conversation.id)}
                isLoading={loadingConversationId === conversation.id}
                key={conversation.id}
                onSelect={onSelect}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="relative z-10 shrink-0 border-t border-white/60 bg-white/45 px-2 py-2 backdrop-blur-lg">
        <button
          aria-label={activeView === 'settings' ? '返回对话' : '打开设置'}
          aria-pressed={activeView === 'settings'}
          className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30 ${
            activeView === 'settings'
              ? 'bg-brand-100 text-brand-800 shadow-sm'
              : 'font-medium text-ink-800 hover:bg-white/75 hover:text-ink-900'
          }`}
          onClick={() => onSelectView('settings')}
          title={activeView === 'settings' ? '返回对话' : '设置'}
          type="button"
        >
          <GearSix aria-hidden="true" className="size-4 shrink-0" />
          <span>设置</span>
        </button>
      </footer>
    </aside>
  );
}

/** Renders one selectable summary with a hover action menu. */
function ConversationRow({
  activeConversationId,
  conversation,
  isChatView,
  isLoading,
  isRunning,
  onSelect,
  onDelete,
  onRename,
}: {
  activeConversationId: string | null;
  conversation: ConversationSummary;
  isChatView: boolean;
  isLoading: boolean;
  isRunning: boolean;
  onSelect: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => Promise<void>;
}) {
  // Only the chat view shows a conversation; other views must not keep a row highlighted.
  const isActive = isChatView && activeConversationId === conversation.id;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // A row menu closes as soon as the user interacts anywhere outside it.
  useEffect(() => {
    if (!isMenuOpen) return;
    const closeOnOutside = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setIsMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [isMenuOpen]);

  return (
    <li className="group relative">
      <button
        aria-current={isActive ? 'true' : undefined}
        className={`w-full rounded-xl px-3 py-2.5 pr-8 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${isActive ? 'bg-brand-100/80 text-brand-900 ring-1 ring-inset ring-brand-200/70' : 'text-ink-700 hover:bg-white/70'}`}
        disabled={false}
        onClick={() => onSelect(conversation.id)}
        type="button"
      >
        <span className="flex min-w-0 items-start gap-2">
          <ChatCircle
            aria-hidden="true"
            className={`mt-0.5 size-4 shrink-0 ${isActive ? 'text-brand-600' : 'text-ink-500'}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium leading-5">
                {conversation.title || '新对话'}
              </span>
              {isLoading && (
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-ink-300 border-t-brand-600" />
              )}
              {isRunning && !isLoading && (
                <span aria-label="正在生成" className="size-3 shrink-0 animate-spin rounded-full border-2 border-ink-300 border-t-brand-600" />
              )}
            </span>
            <time className="mt-1 block text-[11px] text-ink-500">
              {formatUpdatedAt(conversation.updatedAt)}
            </time>
          </span>
        </span>
      </button>

      <button
        aria-expanded={isMenuOpen}
        aria-haspopup="menu"
        aria-label={`会话操作：${conversation.title || '新对话'}`}
        className={`absolute right-1.5 top-2 flex size-6 items-center justify-center rounded-md text-ink-500 transition hover:bg-ink-200 hover:text-ink-900 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0 ${isMenuOpen ? 'bg-ink-200 text-ink-900 opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        disabled={false}
        onClick={() => setIsMenuOpen((open) => !open)}
        type="button"
      >
        <DotsThree aria-hidden="true" className="size-4" weight="bold" />
      </button>

      {isMenuOpen && (
        <div
          className="absolute right-1.5 top-9 z-20 w-32 rounded-lg border border-ink-200 bg-white py-1 shadow-card"
          ref={menuRef}
          role="menu"
        >
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-ink-700 transition hover:bg-ink-100"
            onClick={() => {
              setIsMenuOpen(false);
              setIsRenameOpen(true);
            }}
            role="menuitem"
            type="button"
          >
            重命名
          </button>
          <button
            aria-disabled={isRunning}
            className="w-full px-3 py-1.5 text-left text-sm text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isRunning}
            onClick={() => {
              setIsMenuOpen(false);
              onDelete(conversation.id);
            }}
            role="menuitem"
            title={isRunning ? '会话正在生成，停止或完成后才能删除' : '删除会话'}
            type="button"
          >
            删除会话
          </button>
        </div>
      )}

      {isRenameOpen && (
        <RenameConversationDialog
          initialTitle={conversation.title || '新对话'}
          onCancel={() => setIsRenameOpen(false)}
          onSave={async (title) => {
            await onRename(conversation.id, title);
            setIsRenameOpen(false);
          }}
        />
      )}
    </li>
  );
}

/** Renders the rename modal; it owns the draft text and reports a failed save in place. */
function RenameConversationDialog({
  initialTitle,
  onCancel,
  onSave,
}: {
  initialTitle: string;
  onCancel: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const characterCount = Array.from(title).length;

  // The current name is preselected so typing replaces it without extra clicks.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  // An empty draft never reaches the backend: the service rejects it with a 400.
  const submit = async (): Promise<void> => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError('会话名称不能为空。');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave(nextTitle);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '重命名会话失败，请重试。');
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSaving) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isSaving) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-label="重命名会话"
        aria-modal="true"
        className="w-full max-w-sm rounded-xl border border-ink-200 bg-white p-4 shadow-xl"
        role="dialog"
      >
        <h1 className="text-sm font-bold text-ink-900">重命名会话</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="mt-3 block text-xs text-ink-500" htmlFor={inputId}>
            使用简短且易于识别的名称
          </label>
          <input
            autoFocus
            className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
            id={inputId}
            onChange={(event) => {
              // Bound in code points so one emoji counts once, matching the backend limit.
              setTitle(Array.from(event.target.value).slice(0, CONVERSATION_TITLE_MAX_CHARACTERS).join(''));
            }}
            ref={inputRef}
            value={title}
          />
          <p className="mt-1 text-right text-[11px] text-ink-500">
            {characterCount}/{CONVERSATION_TITLE_MAX_CHARACTERS}
          </p>
          {error && (
            <p className="mt-1 text-xs text-rose-700" role="alert">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="rounded-lg px-3 py-1.5 text-sm text-ink-700 transition hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isSaving}
              onClick={onCancel}
              type="button"
            >
              取消
            </button>
            <button
              className="rounded-lg bg-brand-800 px-3 py-1.5 text-sm text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isSaving || characterCount === 0}
              type="submit"
            >
              {isSaving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Formats the summary update date with a stable Chinese locale. */
function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });
}
