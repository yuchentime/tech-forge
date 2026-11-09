import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the one-shot delivery flag for the normal-chat rehearsal digest.
 *
 * Existing completed rehearsals start as "not delivered", so an upgraded conversation carries their
 * evaluation into the Pi history on its next normal turn instead of losing it silently.
 */
export class RehearsalLoadedContext1794000000000 implements MigrationInterface {
  name = 'RehearsalLoadedContext1794000000000';

  /** Adds the flag; older rows default to false so their digest is still delivered once. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "rehearsals" ADD COLUMN "loadedContext" boolean NOT NULL DEFAULT (0)',
    );
  }

  /** Drops the flag and returns the table to the rehearsal-mode shape. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "rehearsals" DROP COLUMN "loadedContext"',
    );
  }
}
