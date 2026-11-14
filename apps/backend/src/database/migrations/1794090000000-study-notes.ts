import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the user-written note table behind 学习笔记.
 *
 * A study note is free text, so it lives apart from `focus_items`: an excerpt must anchor to one
 * assistant message, while a note may be attached to a conversation or stand alone.
 */
export class StudyNotes1794090000000 implements MigrationInterface {
  name = 'StudyNotes1794090000000';

  /** Creates the table plus the ordering and conversation indexes the list uses. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "study_notes" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar,
        "content" text NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_study_notes_conversation" FOREIGN KEY ("conversationId")
          REFERENCES "conversations" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_study_notes_createdAt" ON "study_notes" ("createdAt")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_study_notes_conversation" ON "study_notes" ("conversationId")',
    );
  }

  /** Drops the table; notes have no meaning without their own rows. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_study_notes_conversation"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_study_notes_createdAt"');
    await queryRunner.query('DROP TABLE IF EXISTS "study_notes"');
  }
}
