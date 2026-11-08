import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Creates the per-conversation Pi session snapshot cache table. */
export class PiSessionSnapshots1793940000000 implements MigrationInterface {
  name = 'PiSessionSnapshots1793940000000';

  /** Creates one snapshot row per conversation keyed by conversation_id. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "pi_session_snapshots" (
        "conversation_id" TEXT PRIMARY KEY,
        "entries_json" TEXT NOT NULL
      )
    `);
  }

  /** Drops only the table created by this migration. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "pi_session_snapshots"');
  }
}
