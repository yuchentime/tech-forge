import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the knowledge-point status bar.
 *
 * Only the point's first message id and a short label are stored; turn counts are derived from the
 * transcript and the decision to finish the point belongs to the director. Message content stays in
 * JSONL.
 */
export class LessonPointState1794060000000 implements MigrationInterface {
  name = 'LessonPointState1794060000000';

  /** Adds the point start id and label. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "pointStartMessageId" varchar',
    );
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "pointLabel" varchar',
    );
  }

  /** SQLite cannot reliably drop columns; the state is derived and safe to ignore. */
  async down(): Promise<void> {
    // No-op by convention.
  }
}
