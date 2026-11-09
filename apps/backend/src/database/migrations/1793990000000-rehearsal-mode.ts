import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the rehearsal tables with the state needed by the Feynman-style drill.
 *
 * The lifecycle columns already exist; this migration adds the learning plan, persona, counters,
 * per-turn follow-up relationships and the final report. Existing rows are backfilled as base
 * questions so the new NOT NULL columns are valid on an already-populated database.
 */
export class RehearsalMode1793990000000 implements MigrationInterface {
  name = 'RehearsalMode1793990000000';

  /** Adds drill columns, backfills legacy turns, and enforces one active rehearsal per conversation. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "rehearsals" ADD COLUMN "personaText" text');
    await queryRunner.query(
      'ALTER TABLE "rehearsals" ADD COLUMN "contextUpToSequenceNo" integer',
    );
    await queryRunner.query('ALTER TABLE "rehearsals" ADD COLUMN "planJson" text');
    await queryRunner.query(
      'ALTER TABLE "rehearsals" ADD COLUMN "askedQuestionCount" integer NOT NULL DEFAULT 0',
    );
    await queryRunner.query(
      'ALTER TABLE "rehearsals" ADD COLUMN "baseQuestionCount" integer NOT NULL DEFAULT 0',
    );
    await queryRunner.query(
      'ALTER TABLE "rehearsals" ADD COLUMN "skippedCount" integer NOT NULL DEFAULT 0',
    );
    await queryRunner.query(
      'ALTER TABLE "rehearsals" ADD COLUMN "overallEvaluationJson" text',
    );
    await queryRunner.query('ALTER TABLE "rehearsals" ADD COLUMN "endReason" varchar');

    await queryRunner.query(
      'ALTER TABLE "rehearsal_turns" ADD COLUMN "kind" varchar NOT NULL DEFAULT \'base\'',
    );
    await queryRunner.query(
      'ALTER TABLE "rehearsal_turns" ADD COLUMN "baseSequenceNo" integer NOT NULL DEFAULT 0',
    );
    await queryRunner.query(
      'ALTER TABLE "rehearsal_turns" ADD COLUMN "followUpDepth" integer NOT NULL DEFAULT 0',
    );
    await queryRunner.query(
      'ALTER TABLE "rehearsal_turns" ADD COLUMN "pointId" varchar',
    );

    // Legacy rows have no follow-up metadata: treat every row as a base question.
    await queryRunner.query(
      'UPDATE "rehearsal_turns" SET "baseSequenceNo" = "sequenceNo" WHERE "baseSequenceNo" = 0',
    );
    await queryRunner.query(`
      UPDATE "rehearsals" SET
        "askedQuestionCount" = (
          SELECT COUNT(*) FROM "rehearsal_turns" t WHERE t."rehearsalId" = "rehearsals"."id"
        ),
        "baseQuestionCount" = (
          SELECT COUNT(*) FROM "rehearsal_turns" t
          WHERE t."rehearsalId" = "rehearsals"."id" AND t."kind" = 'base'
        ),
        "skippedCount" = (
          SELECT COUNT(*) FROM "rehearsal_turns" t
          WHERE t."rehearsalId" = "rehearsals"."id" AND t."status" = 'skipped'
        )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rehearsals_conversation_active"
      ON "rehearsals" ("conversationId")
      WHERE "status" IN (
        'preparing', 'awaiting_answer', 'evaluating', 'preparing_next', 'reporting'
      )
    `);
  }

  /** Drops the drill index and columns, leaving the original lifecycle tables intact. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "UQ_rehearsals_conversation_active"');

    for (const column of [
      'personaText',
      'contextUpToSequenceNo',
      'planJson',
      'askedQuestionCount',
      'baseQuestionCount',
      'skippedCount',
      'overallEvaluationJson',
      'endReason',
    ]) {
      await queryRunner.query(`ALTER TABLE "rehearsals" DROP COLUMN "${column}"`);
    }

    for (const column of ['kind', 'baseSequenceNo', 'followUpDepth', 'pointId']) {
      await queryRunner.query(`ALTER TABLE "rehearsal_turns" DROP COLUMN "${column}"`);
    }
  }
}
