import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeFailure } from '../../api/backend-error';
import type { ConversationSummary } from '../agent/conversation-store';
import {
  loadKnowledgeCards,
  type KnowledgeFactMasteryLevel,
  type KnowledgeFactResponse,
} from './knowledge-profile-api';

interface KnowledgeCard {
  conversationId: string;
  conversationTitle: string;
  tags: string[];
  masteryLevel: KnowledgeFactMasteryLevel;
  summary: string;
  details: string | null;
}

const STATUS_PRESENTATION: Record<
  KnowledgeFactMasteryLevel,
  { label: string; cardClass: string; badgeClass: string }
> = {
  needs_improvement: {
    label: '建议加强',
    cardClass: 'border-orange-200 bg-orange-50/20',
    badgeClass: 'bg-orange-100 text-orange-800',
  },
  basic: {
    label: '基本掌握',
    cardClass: 'border-violet-200 bg-violet-50/20',
    badgeClass: 'bg-violet-100 text-violet-800',
  },
  proficient: {
    label: '熟练掌握',
    cardClass: 'border-emerald-200 bg-emerald-50/20',
    badgeClass: 'bg-emerald-100 text-emerald-800',
  },
};

/** Shows eligible conversation facts and routes card actions back through the Agent page. */
export function KnowledgeProfilePage({
  conversations,
  onSelectConversation,
}: {
  conversations: readonly ConversationSummary[];
  onSelectConversation: (conversationId: string) => void;
}) {
  const [items, setItems] = useState<KnowledgeFactResponse[]>([]);
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const cards = useMemo(
    () => mapKnowledgeCards(items, conversations),
    [conversations, items],
  );
  const selectedCard = cards.find(
    ({ conversationId }) => conversationId === selectedConversationId,
  );

  /** Loads the mock-backed fact contract through the typed local API helper. */
  const loadCards = useCallback(async () => {
    setListStatus('loading');
    setListError(null);
    try {
      setItems(await loadKnowledgeCards());
      setListStatus('ready');
    } catch (error) {
      setListStatus('error');
      setListError(describeFailure(error, '读取知识掌握情况失败，请重试。'));
    }
  }, []);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-stone-50/50">
      <div
        aria-hidden={Boolean(selectedCard)}
        className={`${selectedCard ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col`}
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-stone-200 bg-white px-5 py-4 md:px-8">
          <h1 className="text-xl font-semibold tracking-tight text-stone-900">知识掌握</h1>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-6xl pb-8">
            {listError && (
              <div
                className="mb-5 flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
                role="alert"
              >
                <span className="min-w-0 flex-1">{listError}</span>
                <button
                  className="shrink-0 font-medium underline underline-offset-2"
                  onClick={() => void loadCards()}
                  type="button"
                >
                  重试
                </button>
              </div>
            )}

            {listStatus === 'loading' ? (
              <p className="py-12 text-center text-sm text-stone-500" role="status">
                正在加载…
              </p>
            ) : listStatus === 'error' ? null : cards.length === 0 ? (
              <p className="py-12 text-center text-sm text-stone-500">还没有可展示的知识掌握卡片。</p>
            ) : (
              <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
                {cards.map((card) => (
                  <KnowledgeCardItem
                    card={card}
                    key={card.conversationId}
                    onSelectConversation={onSelectConversation}
                    onSelectDetails={setSelectedConversationId}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedCard && (
        <KnowledgeFactDetailPage
          card={selectedCard}
          onBack={() => setSelectedConversationId(null)}
        />
      )}
    </section>
  );
}

/** Joins conversation titles and derives display text from each published fact. */
function mapKnowledgeCards(
  items: readonly KnowledgeFactResponse[],
  conversations: readonly ConversationSummary[],
): KnowledgeCard[] {
  const titles = new Map(
    conversations.map((conversation) => [conversation.id, conversation.title]),
  );

  return items.flatMap(({ conversationId, fact }) => {
    if (
      !fact ||
      fact.generatedAt === null ||
      !fact.summary?.trim() ||
      !fact.tags ||
      !fact.masteryLevel
    ) {
      return [];
    }

    const details = fact.knowledgePointDetails
      ?.map((point) => {
        const pointLevel = point.masteryLevel
          ? `（${STATUS_PRESENTATION[point.masteryLevel].label}）`
          : '';
        return `${point.name}${pointLevel}\n${point.details}\n${point.changeDescription}`;
      })
      .join('\n\n');

    return [
      {
        conversationId,
        conversationTitle: titles.get(conversationId)?.trim() || '未命名会话',
        tags: fact.tags,
        masteryLevel: fact.masteryLevel,
        summary: fact.summary,
        details: details || null,
      },
    ];
  });
}

/** Renders the complete summary with separate detail and conversation actions. */
function KnowledgeCardItem({
  card,
  onSelectConversation,
  onSelectDetails,
}: {
  card: KnowledgeCard;
  onSelectConversation: (conversationId: string) => void;
  onSelectDetails: (conversationId: string) => void;
}) {
  const presentation = STATUS_PRESENTATION[card.masteryLevel];

  return (
    <article className={`rounded-2xl border p-5 ${presentation.cardClass}`}>
      <span
        className={`inline-flex rounded-full px-3 py-1.5 text-sm font-semibold ${presentation.badgeClass}`}
      >
        {presentation.label}
      </span>

      <h2 className="mt-4 break-words text-lg font-semibold tracking-tight text-stone-900">
        {card.conversationTitle}
      </h2>

      <ul aria-label="知识标签" className="mt-3 flex flex-wrap gap-2">
        {card.tags.map((tag) => (
          <li
            className="rounded-full bg-violet-100/80 px-3 py-1 text-sm text-violet-900"
            key={`${card.conversationId}-${tag}`}
          >
            {tag}
          </li>
        ))}
      </ul>

      <section aria-label="评估摘要" className="mt-5">
        <h3 className="text-sm font-medium text-stone-700">评估摘要</h3>
        <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-7 text-stone-900">
          {card.summary}
        </p>
      </section>

      {card.details && (
        <button
          className="mt-3 inline-flex min-h-8 items-center text-sm font-medium text-violet-700 hover:text-violet-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-800/30"
          onClick={() => onSelectDetails(card.conversationId)}
          type="button"
        >
          查看详情 →
        </button>
      )}

      <footer className="mt-5 border-t border-stone-300/70 pt-3">
        <button
          className="inline-flex min-h-9 items-center text-sm font-semibold text-violet-700 hover:text-violet-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-800/30"
          onClick={() => onSelectConversation(card.conversationId)}
          type="button"
        >
          进入会话 →
        </button>
      </footer>
    </article>
  );
}

/** Shows one conversation's full assessment on a separate view with a return action. */
function KnowledgeFactDetailPage({
  card,
  onBack,
}: {
  card: KnowledgeCard;
  onBack: () => void;
}) {
  const presentation = STATUS_PRESENTATION[card.masteryLevel];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-stone-200 bg-white px-5 py-4 md:px-8">
        <button
          aria-label="返回知识掌握列表"
          className="inline-flex min-h-9 shrink-0 items-center rounded-lg px-2 text-sm font-semibold text-violet-700 hover:bg-violet-50 hover:text-violet-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-800/30"
          onClick={onBack}
          type="button"
        >
          ← 返回
        </button>
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-stone-900">
          {card.conversationTitle}
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8 md:py-8">
        <article className="mx-auto w-full max-w-4xl rounded-2xl border border-stone-200 bg-white p-5 shadow-sm md:p-8">
          <span
            className={`inline-flex rounded-full px-3 py-1.5 text-sm font-semibold ${presentation.badgeClass}`}
          >
            {presentation.label}
          </span>

          <ul aria-label="知识标签" className="mt-4 flex flex-wrap gap-2">
            {card.tags.map((tag) => (
              <li
                className="rounded-full bg-violet-100/80 px-3 py-1 text-sm text-violet-900"
                key={`${card.conversationId}-${tag}`}
              >
                {tag}
              </li>
            ))}
          </ul>

          <section aria-label="评估摘要" className="mt-6">
            <h2 className="text-base font-semibold text-stone-800">评估摘要</h2>
            <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-7 text-stone-900">
              {card.summary}
            </p>
          </section>

          {card.details && (
            <section aria-label="评估详情" className="mt-8 border-t border-stone-200 pt-6">
              <h2 className="text-base font-semibold text-stone-800">评估详情</h2>
              <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-7 text-stone-700">
                {card.details}
              </p>
            </section>
          )}
        </article>
      </div>
    </div>
  );
}
