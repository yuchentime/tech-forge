import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the post-class summary to each lesson.
 *
 * The summary lives in SQLite (unlike transcript messages, which stay in JSONL) because the
 * classroom landing page lists historical lessons with a summary preview and needs to query it
 * without opening every transcript file.
 */
export class ClassroomSummaries1794040000000 implements MigrationInterface {
  name = 'ClassroomSummaries1794040000000';

  /** Adds summary status, Markdown and error columns; existing lessons start as `none`. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "summaryStatus" varchar NOT NULL DEFAULT \'none\'',
    );
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "summaryMarkdown" text',
    );
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "summaryError" text',
    );
    await queryRunner.query(
      'ALTER TABLE "lessons" ADD COLUMN "summaryGeneratedAt" datetime',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_lessons_summaryStatus" ON "lessons" ("summaryStatus")',
    );
  }

  /** SQLite cannot reliably drop columns; summary data is derived and can be regenerated. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_lessons_summaryStatus"',
    );
  }
}
