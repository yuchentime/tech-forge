import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds per-lesson knowledge-point state.
 *
 * The state is small, updated once per turn and deleted with the lesson row, so it lives in SQLite
 * next to the lifecycle. Message content stays in JSONL; only the point start id, label and a
 * closed flag are stored here.
 */
export class LessonPointState1794060000000 implements MigrationInterface {
  name = 'LessonPointState1794060000000';

  /** Adds the point start id, label, closed flag and update time. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "pointStartMessageId" varchar',
    );
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "pointLabel" varchar',
    );
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "pointClosed" boolean NOT NULL DEFAULT 0',
    );
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "pointUpdatedAt" datetime',
    );
  }

  /** SQLite cannot reliably drop columns; the state is derived and safe to ignore. */
  async down(): Promise<void> {
    // No-op by convention.
  }
}
