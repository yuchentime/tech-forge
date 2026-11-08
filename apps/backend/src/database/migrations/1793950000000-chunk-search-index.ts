import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the lexical index for document chunks.
 *
 * The search-term stream lives in a normal table and FTS5 mirrors it as external content, so the
 * delete path always carries the old values and the index cannot drift from its source rows.
 */
export class ChunkSearchIndex1793950000000 implements MigrationInterface {
  name = 'ChunkSearchIndex1793950000000';

  /** Creates the term table, the external-content FTS table and the sync triggers. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chunk_search_terms" (
        "rowid" INTEGER PRIMARY KEY,
        "chunkId" TEXT NOT NULL UNIQUE,
        "heading" TEXT NOT NULL,
        "body" TEXT NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE VIRTUAL TABLE "chunk_fts" USING fts5(
        "heading", "body",
        content = 'chunk_search_terms', content_rowid = 'rowid',
        tokenize = 'porter unicode61'
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER "chunk_search_terms_ai" AFTER INSERT ON "chunk_search_terms" BEGIN
        INSERT INTO "chunk_fts"("rowid", "heading", "body")
          VALUES (new.rowid, new.heading, new.body);
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER "chunk_search_terms_ad" AFTER DELETE ON "chunk_search_terms" BEGIN
        INSERT INTO "chunk_fts"("chunk_fts", "rowid", "heading", "body")
          VALUES ('delete', old.rowid, old.heading, old.body);
      END
    `);
  }

  /** Drops exactly what `up` created, including the virtual table and its triggers. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS "chunk_search_terms_ad"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "chunk_search_terms_ai"');
    await queryRunner.query('DROP TABLE IF EXISTS "chunk_fts"');
    await queryRunner.query('DROP TABLE IF EXISTS "chunk_search_terms"');
  }
}
