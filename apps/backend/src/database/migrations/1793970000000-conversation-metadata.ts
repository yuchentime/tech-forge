import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the generic per-conversation metadata column.
 *
 * First use is the knowledge scope (`{"knowledge":{"documentIds":[...]}}`): which documents this
 * conversation may search. A single JSON column keeps conversation-level preferences out of
 * message rows, where they would be duplicated per turn and could drift from the history.
 */
export class ConversationMetadata1793970000000 implements MigrationInterface {
  name = 'ConversationMetadata1793970000000';

  /** Adds the nullable column; existing rows keep working without a backfill. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "conversations" ADD COLUMN "metadataJson" TEXT');
  }

  /** Drops the column; the knowledge scope then falls back to the default range. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "conversations" DROP COLUMN "metadataJson"');
  }
}
