import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces one active classroom at a time.
 *
 * Older databases may already hold several `active` rows (the first implementation never ended the
 * previous lesson). The migration keeps the newest one and closes the rest before adding the partial
 * unique index, so existing transcripts stay readable as history instead of blocking startup.
 */
export class LessonActiveUnique1794050000000 implements MigrationInterface {
  name = 'LessonActiveUnique1794050000000';

  /** Deduplicates active lessons, then adds the partial unique index. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "lessons"
      SET "status" = 'ended', "endedAt" = COALESCE("endedAt", datetime('now'))
      WHERE "status" = 'active'
        AND "id" NOT IN (
          SELECT "id" FROM "lessons"
          WHERE "status" = 'active'
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT 1
        )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_lessons_active" ON "lessons" ("status") WHERE "status" = \'active\'',
    );
  }

  /** Removes the index; previously closed lessons stay ended. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "UQ_lessons_active"');
  }
}
