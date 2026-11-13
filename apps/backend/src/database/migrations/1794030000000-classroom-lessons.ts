import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the classroom lesson lifecycle table.
 *
 * Message content deliberately stays in `<configDir>/lessons/<lessonId>/messages.jsonl`, so this
 * table holds only the id, status and timestamps that the frontend and state checks query.
 */
export class ClassroomLessons1794030000000 implements MigrationInterface {
  name = 'ClassroomLessons1794030000000';

  /** Creates the lesson table and the status index used to find the active lesson. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "lessons" (
        "id" varchar PRIMARY KEY NOT NULL,
        "status" varchar NOT NULL,
        "endedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_lessons_status" ON "lessons" ("status")',
    );
  }

  /** Drops the lesson table; transcripts are separate files and survive a rollback. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_lessons_status"');
    await queryRunner.query('DROP TABLE IF EXISTS "lessons"');
  }
}
