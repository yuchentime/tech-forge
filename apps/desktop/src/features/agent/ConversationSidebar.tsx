import {
  ArrowClockwise,
  Books,
  ChatCircle,
  DotsThree,
  GearSix,
  NotePencil,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type {
  ConversationStoreSnapshot,
  ConversationSummary,
} from './conversation-store';

/** Views the sidebar can switch the main area to; `chat` is the conversation view. */
export type SidebarView = 'chat' | 'settings' | 'knowledge';

/** Renders the conversation list and actions without owning API or runtime state. */
export function ConversationSidebar({
  state,
  isBusy,
  loadingConversationId,
  onNewConversation,
  onRefresh,
  onSelect,
  onDelete,
  activeView,
  onSelectView,
}: {
  state: ConversationStoreSnapshot;
  isBusy: boolean;
  loadingConversationId: string | null;
  onNewConversation: () => void;
  onRefresh: () => void;
  onSelect: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
  activeView: SidebarView;
  onSelectView: (view: SidebarView) => void;
}) {
  return (
    <aside
      aria-label="对话列表"
      className="flex h-48 min-h-0 w-full shrink-0 flex-col border-b border-stone-200 bg-stone-50/70 md:h-full md:w-64 md:border-b-0 md:border-r"
    >
      <header className="shrink-0 border-b border-stone-200 px-2 py-2">
        <div className="flex items-center gap-2">
          <button
            aria-label="新建课题"
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-sm text-stone-700 transition hover:bg-stone-200/70 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isBusy}
            onClick={onNewConversation}
            title="新建课题"
            type="button"
          >
            <NotePencil aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">新建课题</span>
          </button>
          <button
            aria-label="刷新对话列表"
            className="flex size-8 items-center justify-center rounded-lg text-stone-600 transition hover:bg-stone-200 hover:text-stone-900 disabled:cursor-wait disabled:opacity-40"
            disabled={state.listStatus === 'loading'}
            onClick={onRefresh}
            title="刷新列表"
            type="button"
          >
            <ArrowClockwise
              aria-hidden="true"
              className={`size-4 ${state.listStatus === 'loading' ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
        <button
          aria-label={activeView === 'knowledge' ? '返回对话' : '打开资料库'}
          aria-pressed={activeView === 'knowledge'}
          className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/30 ${
            activeView === 'knowledge'
              ? 'bg-stone-200 text-stone-900'
              : 'text-stone-600 hover:bg-stone-200/70 hover:text-stone-900'
          }`}
          onClick={() => onSelectView('knowledge')}
          title="资料库"
          type="button"
        >
          <Books aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">资料库</span>
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {state.conversations.length === 0 ? (
          <p className="px-3 py-5 text-center text-xs leading-5 text-stone-500">
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
                disabled={isBusy}
                isLoading={loadingConversationId === conversation.id}
                key={conversation.id}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="shrink-0 border-t border-stone-200 px-2 py-2">
        <button
          aria-label={activeView === 'settings' ? '返回对话' : '打开设置'}
          aria-pressed={activeView === 'settings'}
          className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/30 ${
            activeView === 'settings'
              ? 'bg-stone-200 text-stone-900'
              : 'text-stone-600 hover:bg-stone-200/70 hover:text-stone-900'
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
  disabled,
  isLoading,
  onSelect,
  onDelete,
}: {
  activeConversationId: string | null;
  conversation: ConversationSummary;
  disabled: boolean;
  isLoading: boolean;
  onSelect: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  const isActive = activeConversationId === conversation.id;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
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
        className={`w-full rounded-xl px-3 py-2.5 pr-8 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${isActive ? 'bg-emerald-900/10 text-stone-900' : 'text-stone-700 hover:bg-stone-200/70'}`}
        disabled={disabled}
        onClick={() => onSelect(conversation.id)}
        type="button"
      >
        <span className="flex min-w-0 items-start gap-2">
          <ChatCircle
            aria-hidden="true"
            className={`mt-0.5 size-4 shrink-0 ${isActive ? 'text-emerald-900' : 'text-stone-500'}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium leading-5">
                {conversation.title || '新对话'}
              </span>
              {isLoading && (
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-stone-300 border-t-emerald-800" />
              )}
            </span>
            <time className="mt-1 block text-[11px] text-stone-500">
              {formatUpdatedAt(conversation.updatedAt)}
            </time>
          </span>
        </span>
      </button>

      <button
        aria-expanded={isMenuOpen}
        aria-haspopup="menu"
        aria-label={`会话操作：${conversation.title || '新对话'}`}
        className={`absolute right-1.5 top-2 flex size-6 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-200 hover:text-stone-900 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0 ${isMenuOpen ? 'bg-stone-200 text-stone-900 opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        disabled={disabled}
        onClick={() => setIsMenuOpen((open) => !open)}
        type="button"
      >
        <DotsThree aria-hidden="true" className="size-4" weight="bold" />
      </button>

      {isMenuOpen && (
        <div
          className="absolute right-1.5 top-9 z-20 w-32 rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
          ref={menuRef}
          role="menu"
        >
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-rose-700 transition hover:bg-rose-50"
            onClick={() => {
              setIsMenuOpen(false);
              onDelete(conversation.id);
            }}
            role="menuitem"
            type="button"
          >
            删除会话
          </button>
        </div>
      )}
    </li>
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
