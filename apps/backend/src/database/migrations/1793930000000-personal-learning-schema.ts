import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Creates the persistence schema for conversations, rehearsals, documents, and artifacts. */
export class PersonalLearningSchema1793930000000 implements MigrationInterface {
  name = 'PersonalLearningSchema1793930000000';

  /** Creates the tables and indexes represented by the current entity model. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" varchar PRIMARY KEY NOT NULL,
        "title" text,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "messages" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "sequenceNo" integer NOT NULL,
        "role" varchar NOT NULL,
        "contentJson" text NOT NULL,
        "status" varchar NOT NULL,
        "requestId" varchar,
        "contextRefsJson" text,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "IDX_messages_conversation_sequence" ON "messages" ("conversationId", "sequenceNo")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_messages_conversation_createdAt" ON "messages" ("conversationId", "createdAt")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_messages_conversation_requestId" ON "messages" ("conversationId", "requestId")',
    );

    await queryRunner.query(`
      CREATE TABLE "rehearsals" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "status" varchar NOT NULL,
        "startRequestId" varchar,
        "startedAt" datetime,
        "endedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_rehearsals_conversation_createdAt" ON "rehearsals" ("conversationId", "createdAt")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_rehearsals_conversation_startRequestId" ON "rehearsals" ("conversationId", "startRequestId")',
    );

    await queryRunner.query(`
      CREATE TABLE "rehearsal_turns" (
        "id" varchar PRIMARY KEY NOT NULL,
        "rehearsalId" varchar NOT NULL,
        "sequenceNo" integer NOT NULL,
        "question" text NOT NULL,
        "answer" text,
        "evaluationJson" text,
        "status" varchar NOT NULL,
        "answerRequestId" varchar,
        "askedAt" datetime NOT NULL,
        "answeredAt" datetime,
        "evaluatedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("rehearsalId") REFERENCES "rehearsals"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "IDX_rehearsal_turns_rehearsal_sequence" ON "rehearsal_turns" ("rehearsalId", "sequenceNo")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_rehearsal_turns_rehearsal_answerRequestId" ON "rehearsal_turns" ("rehearsalId", "answerRequestId")',
    );

    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" varchar PRIMARY KEY NOT NULL,
        "title" text NOT NULL,
        "isShared" boolean NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_documents_isShared" ON "documents" ("isShared")',
    );

    await queryRunner.query(`
      CREATE TABLE "document_versions" (
        "id" varchar PRIMARY KEY NOT NULL,
        "documentId" varchar NOT NULL,
        "versionNo" integer NOT NULL,
        "originalName" text NOT NULL,
        "mimeType" varchar NOT NULL,
        "workspaceRelativePath" text NOT NULL,
        "byteSize" integer,
        "contentHash" varchar,
        "processingStatus" varchar NOT NULL,
        "processingError" text,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_document_versions_document_versionNo" ON "document_versions" ("documentId", "versionNo")',
    );

    await queryRunner.query(`
      CREATE TABLE "conversation_documents" (
        "conversationId" varchar NOT NULL,
        "documentId" varchar NOT NULL,
        "addedAt" datetime NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY ("conversationId", "documentId"),
        FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE NO ACTION,
        FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "document_chunks" (
        "id" varchar PRIMARY KEY NOT NULL,
        "documentVersionId" varchar NOT NULL,
        "sequenceNo" integer NOT NULL,
        "content" text NOT NULL,
        "locatorJson" text,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("documentVersionId") REFERENCES "document_versions"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_document_chunks_version_sequence" ON "document_chunks" ("documentVersionId", "sequenceNo")',
    );

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

  /** Drops only the tables created by this migration, in foreign-key-safe order. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "artifacts"');
    await queryRunner.query('DROP TABLE "document_chunks"');
    await queryRunner.query('DROP TABLE "conversation_documents"');
    await queryRunner.query('DROP TABLE "document_versions"');
    await queryRunner.query('DROP TABLE "documents"');
    await queryRunner.query('DROP TABLE "rehearsal_turns"');
    await queryRunner.query('DROP TABLE "rehearsals"');
    await queryRunner.query('DROP TABLE "messages"');
    await queryRunner.query('DROP TABLE "conversations"');
  }
}
