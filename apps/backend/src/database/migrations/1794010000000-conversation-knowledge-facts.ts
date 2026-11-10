import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the single derived knowledge-mastery fact row per conversation.
 *
 * No historical conversation is backfilled: rows appear only when a new rehearsal report commits.
 * The table is derived data, so `down` removes it without touching reports, messages or snapshots.
 */
export class ConversationKnowledgeFacts1794010000000
  implements MigrationInterface
{
  name = 'ConversationKnowledgeFacts1794010000000';

  /** Creates the fact table and the status scan index. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "conversation_knowledge_facts" (
        "conversationId" varchar PRIMARY KEY NOT NULL,
        "summary" text,
        "knowledgePointDetailsJson" text,
        "tagsJson" text,
        "masteryLevel" varchar,
        "generationStatus" varchar NOT NULL DEFAULT ('pending'),
        "lastError" text,
        "generatedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_conversation_knowledge_facts_generationStatus" ON "conversation_knowledge_facts" ("generationStatus")',
    );
  }

  /** Drops only the derived table and index. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_conversation_knowledge_facts_generationStatus"',
    );
    await queryRunner.query('DROP TABLE "conversation_knowledge_facts"');
  }
}
