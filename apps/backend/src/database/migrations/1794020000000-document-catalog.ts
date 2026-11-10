import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds validated, provider-produced catalog metadata without removing legacy retrieval rows. */
export class DocumentCatalog1794020000000 implements MigrationInterface {
  name = 'DocumentCatalog1794020000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "document_versions" ADD COLUMN "catalogStatus" varchar NOT NULL DEFAULT (\'pending\')');
    await queryRunner.query('ALTER TABLE "document_versions" ADD COLUMN "catalogSummary" text');
    await queryRunner.query('ALTER TABLE "document_versions" ADD COLUMN "catalogKeywordsJson" text');
    await queryRunner.query('ALTER TABLE "document_versions" ADD COLUMN "catalogDocumentType" varchar');
    await queryRunner.query('ALTER TABLE "document_versions" ADD COLUMN "catalogError" text');
    await queryRunner.query('ALTER TABLE "document_versions" ADD COLUMN "catalogedAt" datetime');
    await queryRunner.query('CREATE INDEX "IDX_document_versions_catalogStatus" ON "document_versions" ("catalogStatus")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_document_versions_catalogStatus"');
    // SQLite cannot reliably drop columns across all supported versions; legacy down migrations are
    // intentionally non-destructive because catalog data is derived and can be ignored on rollback.
  }
}
