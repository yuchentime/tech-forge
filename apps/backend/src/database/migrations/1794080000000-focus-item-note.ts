import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the optional study note to saved 重点关注 excerpts.
 *
 * Notes live on the focus row, not on the message: one excerpt can have its own note, and clearing
 * the note removes the text without deleting the saved excerpt.
 */
export class FocusItemNote1794080000000 implements MigrationInterface {
  name = 'FocusItemNote1794080000000';

  /** Adds the nullable note column; existing rows simply have no note. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "focus_items" ADD COLUMN "note" text',
    );
  }

  /** SQLite cannot reliably drop columns; existing notes are harmless if the migration is ignored. */
  async down(): Promise<void> {
    // No-op by convention.
  }
}
