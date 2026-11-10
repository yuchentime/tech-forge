import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeFailure } from '../../api/backend-error';
import type { ConversationSummary } from '../agent/conversation-store';
import {
  loadConversationKnowledgeFact,
  loadKnowledgeFacts,
  type KnowledgeFactMasteryLevel,
  type KnowledgeFactListItem,
  type KnowledgeFactView,
} from './knowledge-profile-api';
import { mapKnowledgeCards, type KnowledgeCard } from './knowledge-profile-cards';

type DetailStatus = 'idle' | 'loading' | 'ready' | 'error';

const STATUS_PRESENTATION: Record<
  KnowledgeFactMasteryLevel,
  { label: string; badgeClass: string }
> = {
  needs_improvement: {
    label: '建议加强',
    badgeClass: 'bg-orange-100 text-orange-800',
  },
  basic: {
    label: '基本掌握',
    badgeClass: 'bg-violet-100 text-violet-800',
  },
  proficient: {
    label: '熟练掌握',
    badgeClass: 'bg-emerald-100 text-emerald-800',
  },
};

/** Published facts may carry no overall level when evidence is insufficient. */
const INSUFFICIENT_PRESENTATION = {
  label: '证据不足',
  badgeClass: 'bg-stone-100 text-stone-700',
};

/** Maps a nullable overall level to its badge/card presentation. */
function getStatusPresentation(level: KnowledgeFactMasteryLevel | null) {
  return level ? STATUS_PRESENTATION[level] : INSUFFICIENT_PRESENTATION;
}

/** Shows eligible conversation facts and routes card actions back through the Agent page. */
export function KnowledgeProfilePage({
  conversations,
  onSelectConversation,
}: {
  conversations: readonly ConversationSummary[];
  onSelectConversation: (conversationId: string) => void;
}) {
  const [items, setItems] = useState<KnowledgeFactListItem[]>([]);
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [detailStatus, setDetailStatus] = useState<DetailStatus>('idle');
  const [detailFact, setDetailFact] = useState<KnowledgeFactView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestVersion = useRef(0);
  const cards = useMemo(
    () => mapKnowledgeCards(items, conversations),
    [conversations, items],
  );
  const selectedCard = cards.find(
    ({ conversationId }) => conversationId === selectedConversationId,
  );

  /** Loads only compact fact rows for the card grid. */
  const loadCards = useCallback(async () => {
    setListStatus('loading');
    setListError(null);
    try {
      setItems(await loadKnowledgeFacts());
      setListStatus('ready');
    } catch (error) {
      setListStatus('error');
      setListError(describeFailure(error, '读取知识掌握情况失败，请重试。'));
    }
  }, []);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  useEffect(
    () => () => {
      detailRequestVersion.current += 1;
    },
    [],
  );

  /** Opens a detail view and fetches its large knowledge-point payload on demand. */
  const loadDetails = useCallback(async (conversationId: string) => {
    const requestVersion = detailRequestVersion.current + 1;
    detailRequestVersion.current = requestVersion;
    setSelectedConversationId(conversationId);
    setDetailStatus('loading');
    setDetailFact(null);
    setDetailError(null);
    try {
      const fact = await loadConversationKnowledgeFact(conversationId);
      if (detailRequestVersion.current !== requestVersion) return;
      setDetailFact(fact);
      setDetailStatus('ready');
    } catch (error) {
      if (detailRequestVersion.current !== requestVersion) return;
      setDetailStatus('error');
      setDetailError(describeFailure(error, '读取评估详情失败，请重试。'));
    }
  }, []);

  /** Invalidates any in-flight detail response before returning to the preserved list. */
  const closeDetails = useCallback(() => {
    detailRequestVersion.current += 1;
    setSelectedConversationId(null);
    setDetailStatus('idle');
    setDetailFact(null);
    setDetailError(null);
  }, []);

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
              <div
                className="grid items-stretch gap-4 lg:gap-5"
                style={{
                  // Keep empty tracks so a short row does not stretch its cards across the full width.
                  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 22rem), 1fr))',
                }}
              >
                {cards.map((card) => (
                  <KnowledgeCardItem
                    card={card}
                    key={card.conversationId}
                    onSelectConversation={onSelectConversation}
                    onSelectDetails={(conversationId) => void loadDetails(conversationId)}
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
          detailError={detailError}
          detailFact={detailFact}
          detailStatus={detailStatus}
          onBack={closeDetails}
          onRetry={() => void loadDetails(selectedCard.conversationId)}
        />
      )}
    </section>
  );
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
  const presentation = getStatusPresentation(card.masteryLevel);

  return (
    <article className="flex h-full min-w-0 flex-col rounded-2xl border border-stone-200 bg-white p-4 sm:p-5">
      <span
        className={`inline-flex rounded-full px-3 py-1.5 text-sm font-semibold ${presentation.badgeClass}`}
      >
        {presentation.label}
      </span>

      <h2 className="mt-3 break-words text-base font-semibold leading-6 tracking-tight text-stone-900">
        {card.conversationTitle}
      </h2>

      <ul aria-label="知识标签" className="mt-3 flex flex-wrap gap-2">
        {card.tags.map((tag) => (
          <li
            className="rounded-full border border-violet-100 bg-violet-50 px-2.5 py-1 text-sm text-violet-800"
            key={`${card.conversationId}-${tag}`}
          >
            {tag}
          </li>
        ))}
      </ul>

      <section aria-label="评估摘要" className="mt-4">
        <h3 className="text-sm font-medium text-stone-700">评估摘要</h3>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-stone-800">
          {card.summary}
        </p>
      </section>

      <footer className="mt-auto flex items-center justify-between gap-3 border-t border-stone-200 pt-4">
        <button
          className="inline-flex min-h-9 items-center rounded-lg px-2 text-sm font-medium text-violet-700 hover:bg-violet-50 hover:text-violet-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-800/30"
          onClick={() => onSelectDetails(card.conversationId)}
          type="button"
        >
          查看详情 →
        </button>
        <button
          className="inline-flex min-h-9 items-center rounded-full bg-violet-700 px-4 text-sm font-semibold text-white hover:bg-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-800/40 focus-visible:ring-offset-2"
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
  detailError,
  detailFact,
  detailStatus,
  onBack,
  onRetry,
}: {
  card: KnowledgeCard;
  detailError: string | null;
  detailFact: KnowledgeFactView | null;
  detailStatus: DetailStatus;
  onBack: () => void;
  onRetry: () => void;
}) {
  // `null` is a real published value (insufficient evidence), not "missing"; only fall back to the
  // list card before the detail request resolves.
  const masteryLevel = detailFact ? detailFact.masteryLevel : card.masteryLevel;
  const presentation = getStatusPresentation(masteryLevel);
  const tags = detailFact?.tags ?? card.tags;
  const summary = detailFact?.summary ?? card.summary;
  const knowledgePoints = detailFact?.knowledgePointDetails ?? [];

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
            {tags.map((tag) => (
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
              {summary}
            </p>
          </section>

          {detailStatus === 'loading' && (
            <p className="mt-8 border-t border-stone-200 pt-6 text-sm text-stone-500" role="status">
              正在加载评估详情…
            </p>
          )}

          {detailStatus === 'error' && (
            <div
              className="mt-8 flex items-center gap-3 border-t border-stone-200 pt-6 text-sm text-rose-800"
              role="alert"
            >
              <span className="min-w-0 flex-1">{detailError ?? '读取评估详情失败，请重试。'}</span>
              <button
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={onRetry}
                type="button"
              >
                重试
              </button>
            </div>
          )}

          {detailStatus === 'ready' && !detailFact && (
            <p className="mt-8 border-t border-stone-200 pt-6 text-sm text-stone-500">
              该会话当前没有可展示的评估详情。
            </p>
          )}

          {detailStatus === 'ready' && detailFact && (
            <section aria-label="评估详情" className="mt-8 border-t border-stone-200 pt-6">
              <h2 className="text-base font-semibold text-stone-800">评估详情</h2>
              {knowledgePoints.length === 0 ? (
                <p className="mt-3 text-[15px] leading-7 text-stone-600">
                  当前没有可展示的知识点详情。
                </p>
              ) : (
                <div className="mt-4 space-y-6">
                  {knowledgePoints.map((point, index) => (
                    <section
                      aria-label={point.name}
                      className={index === 0 ? '' : 'border-t border-stone-200 pt-5'}
                      key={`${point.name}-${index}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-stone-900">{point.name}</h3>
                        {point.masteryLevel && (
                          <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">
                            {STATUS_PRESENTATION[point.masteryLevel].label}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-7 text-stone-700">
                        {point.details}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-stone-500">
                        {point.changeDescription}
                      </p>
                    </section>
                  ))}
                </div>
              )}
            </section>
          )}
        </article>
      </div>
    </div>
  );
}
