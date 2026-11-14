import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Replaces the saved-excerpt table with the Learn Notes table without dropping user rows. */
export class RenameFocusItemsToLearnNotes1794100000000 implements MigrationInterface {
  name = 'RenameFocusItemsToLearnNotes1794100000000';

  /** Copies the existing rows into the renamed table and replaces the old schema atomically. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "learn_notes" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "messageId" varchar NOT NULL,
        "messageSequenceNo" integer NOT NULL,
        "messageIndex" integer NOT NULL,
        "quote" text NOT NULL,
        "quoteKey" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        "note" text,
        CONSTRAINT "FK_learn_notes_conversation" FOREIGN KEY ("conversationId")
          REFERENCES "conversations" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      INSERT INTO "learn_notes" (
        "id", "conversationId", "messageId", "messageSequenceNo", "messageIndex",
        "quote", "quoteKey", "createdAt", "updatedAt", "note"
      )
      SELECT
        "id", "conversationId", "messageId", "messageSequenceNo", "messageIndex",
        "quote", "quoteKey", "createdAt", "updatedAt", "note"
      FROM "focus_items"
    `);
    await queryRunner.query('DROP TABLE "focus_items"');
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_learn_notes_message_quote" ON "learn_notes" ("messageId", "quoteKey")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_learn_notes_createdAt" ON "learn_notes" ("createdAt")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_learn_notes_conversation" ON "learn_notes" ("conversationId")',
    );
  }

  /** Restores the previous table name and constraints if the migration is reverted. */
  async down(queryRunner: QueryRunner): Promise<void> {
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
        "note" text,
        CONSTRAINT "FK_focus_items_conversation" FOREIGN KEY ("conversationId")
          REFERENCES "conversations" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      INSERT INTO "focus_items" (
        "id", "conversationId", "messageId", "messageSequenceNo", "messageIndex",
        "quote", "quoteKey", "createdAt", "updatedAt", "note"
      )
      SELECT
        "id", "conversationId", "messageId", "messageSequenceNo", "messageIndex",
        "quote", "quoteKey", "createdAt", "updatedAt", "note"
      FROM "learn_notes"
    `);
    await queryRunner.query('DROP TABLE "learn_notes"');
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
}
