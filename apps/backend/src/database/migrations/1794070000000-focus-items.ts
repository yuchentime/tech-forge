import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the saved-highlight table behind 学习笔记.
 *
 * Rows reference the conversation (for title and cascade cleanup) and the stable message id (for
 * navigation). The quote is stored as plain text; message content itself stays in `messages`.
 */
export class FocusItems1794070000000 implements MigrationInterface {
  name = 'FocusItems1794070000000';

  /** Creates the table plus the unique and lookup indexes used by the list and dedupe paths. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "focus_items" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "messageId" varchar NOT NULL,
        "messageSequenceNo" integer NOT NULL,
        "messageIndex" integer NOT NULL,
        "quote" text NOT NULL,
        "quoteKey" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_focus_items_conversation" FOREIGN KEY ("conversationId")
          REFERENCES "conversations" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_focus_items_message_quote" ON "focus_items" ("messageId", "quoteKey")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_focus_items_createdAt" ON "focus_items" ("createdAt")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_focus_items_conversation" ON "focus_items" ("conversationId")',
    );
  }

  /** Drops the table; focus rows have no value without their conversation. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "focus_items"');
  }
}
