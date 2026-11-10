import type { ConversationSummary } from '../agent/conversation-store';
import type {
  KnowledgeFactListItem,
  KnowledgeFactMasteryLevel,
} from './knowledge-profile-api';

/** One card shown in the knowledge-profile grid. */
export interface KnowledgeCard {
  conversationId: string;
  conversationTitle: string;
  tags: string[];
  /** Null means the fact was published with insufficient overall evidence. */
  masteryLevel: KnowledgeFactMasteryLevel | null;
  summary: string;
  updatedAt: string;
}

/**
 * Joins conversation titles and keeps every published fact.
 *
 * Overall mastery may be null when evidence is insufficient; that is a published fact, not a
 * missing one, so it must still produce a card. Pre-publication rows stay hidden.
 */
export function mapKnowledgeCards(
  items: readonly KnowledgeFactListItem[],
  conversations: readonly ConversationSummary[],
): KnowledgeCard[] {
  const titles = new Map(
    conversations.map((conversation) => [conversation.id, conversation.title]),
  );

  return items.flatMap((item) => {
    if (item.generatedAt === null || !item.summary?.trim() || !item.tags) {
      return [];
    }

    return [
      {
        conversationId: item.conversationId,
        conversationTitle: titles.get(item.conversationId)?.trim() || '未命名会话',
        tags: item.tags,
        masteryLevel: item.masteryLevel,
        summary: item.summary,
        updatedAt: item.updatedAt,
      },
    ];
  }).sort((left, right) => {
    const masteryOrder =
      masteryPriority(left.masteryLevel) - masteryPriority(right.masteryLevel);
    if (masteryOrder !== 0) return masteryOrder;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

/** Orders weak signals first, then insufficient evidence, then stronger mastery. */
export function masteryPriority(level: KnowledgeFactMasteryLevel | null): number {
  if (level === 'needs_improvement') return 0;
  if (level === null) return 1;
  return level === 'basic' ? 2 : 3;
}
