import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793900000000 implements MigrationInterface {
  name = 'InitialSchema1793900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "courses" (
        "id" varchar PRIMARY KEY NOT NULL,
        "title" varchar(160) NOT NULL,
        "description" text,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "courses"');
  }
}
