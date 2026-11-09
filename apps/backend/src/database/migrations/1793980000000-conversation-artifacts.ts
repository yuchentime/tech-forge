import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces the placeholder artifact table with the shape the sidebar needs.
 *
 * The old table was never written to (the service was a stub), so it is rebuilt instead of
 * patched: the previous `workspaceRelativePath` was NOT NULL and could not hold an absolute
 * destination, and session-relative paths need an empty-string default rather than NULL for the
 * unique index to deduplicate.
 */
export class ConversationArtifacts1793980000000 implements MigrationInterface {
  name = 'ConversationArtifacts1793980000000';

  /** Drops the empty placeholder table and recreates it with paths, formats and turn ownership. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_artifacts_conversation_createdAt"');
    await queryRunner.query('DROP TABLE IF EXISTS "artifacts"');
    await queryRunner.query(`
      CREATE TABLE "artifacts" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "userMessageId" varchar,
        "pathKind" varchar NOT NULL,
        "relativePath" text NOT NULL DEFAULT '',
        "absolutePath" text NOT NULL DEFAULT '',
        "fileName" text NOT NULL,
        "contentFormat" varchar NOT NULL,
        "mimeType" varchar,
        "byteSize" integer,
        "fileHash" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_artifacts_conversation_path" ON "artifacts" ("conversationId", "pathKind", "relativePath", "absolutePath")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_artifacts_conversation_createdAt" ON "artifacts" ("conversationId", "createdAt")',
    );
  }

  /** Restores the legacy placeholder shape so the migration can be rolled back. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "UQ_artifacts_conversation_path"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_artifacts_conversation_createdAt"');
    await queryRunner.query('DROP TABLE IF EXISTS "artifacts"');
    await queryRunner.query(`
      CREATE TABLE "artifacts" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "contentFormat" varchar NOT NULL,
        "fileName" text NOT NULL,
        "workspaceRelativePath" text NOT NULL,
        "mimeType" varchar,
        "fileHash" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_artifacts_conversation_createdAt" ON "artifacts" ("conversationId", "createdAt")',
    );
  }
}
