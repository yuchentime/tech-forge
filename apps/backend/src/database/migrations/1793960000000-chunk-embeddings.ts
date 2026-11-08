import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the dense vector store for chunks.
 *
 * Each row stamps the model id and dimension it was produced with: vectors from different models are
 * not comparable, so recall filters on the active model instead of trying to migrate in place.
 */
export class ChunkEmbeddings1793960000000 implements MigrationInterface {
  name = 'ChunkEmbeddings1793960000000';

  /** Creates the embeddings table and its lookup indexes. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chunk_embeddings" (
        "chunkId" TEXT PRIMARY KEY,
        "documentId" TEXT NOT NULL,
        "documentVersionId" TEXT NOT NULL,
        "embeddingModel" TEXT NOT NULL,
        "embeddingDim" INTEGER NOT NULL,
        "vector" BLOB NOT NULL
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_chunk_embeddings_model" ON "chunk_embeddings" ("embeddingModel", "embeddingDim")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_chunk_embeddings_document" ON "chunk_embeddings" ("documentId")',
    );
  }

  /** Drops exactly what `up` created. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "chunk_embeddings"');
  }
}
