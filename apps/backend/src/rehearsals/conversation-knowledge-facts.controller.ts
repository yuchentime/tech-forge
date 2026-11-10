import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ConversationKnowledgeFactsService } from './conversation-knowledge-facts.service';
import type {
  ConversationKnowledgeFactsListView,
  ConversationKnowledgeFactsView,
} from './conversation-knowledge-facts.types';

/**
 * Exposes read-only knowledge fact resources.
 *
 * The collection is top-level (`/knowledge-facts`) because it spans conversations; the item read
 * stays conversation-scoped. The global auth/Origin hook in `main.ts` protects both.
 */
@Controller()
export class ConversationKnowledgeFactsController {
  /** Injects the read/query side of the fact service. */
  constructor(private readonly facts: ConversationKnowledgeFactsService) {}

  /**
   * Returns every stored fact without knowledge-point details.
   *
   * The detail column is intentionally not selected or serialized; consumers that need it use the
   * single-conversation endpoint.
   */
  @Get('knowledge-facts')
  list(): Promise<ConversationKnowledgeFactsListView> {
    return this.facts.listAll();
  }

  /** Returns the latest published fact plus its generation status; never triggers generation. */
  @Get('conversations/:conversationId/knowledge-facts')
  get(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
  ): Promise<ConversationKnowledgeFactsView> {
    return this.facts.getForConversation(conversationId);
  }
}
