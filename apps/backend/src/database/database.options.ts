import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database = require('better-sqlite3');
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ArtifactEntity } from '../artifacts/artifact.entity';
import { ConversationEntity } from '../conversations/conversation.entity';
import { MessageEntity } from '../conversations/message.entity';
import { ConversationDocumentEntity } from '../documents/conversation-document.entity';
import { DocumentChunkEntity } from '../documents/document-chunk.entity';
import { DocumentEntity } from '../documents/document.entity';
import { DocumentVersionEntity } from '../documents/document-version.entity';
import { RehearsalTurnEntity } from '../rehearsals/rehearsal-turn.entity';
import { RehearsalEntity } from '../rehearsals/rehearsal.entity';
import { CourseEntity } from '../courses/course.entity';

/** Builds the SQLite TypeORM connection options and registers persisted entities. */
export function buildDatabaseOptions(): TypeOrmModuleOptions {
  const dataDirectory = process.env.TEACHFORGE_DATA_DIR ?? join(process.cwd(), '.data');
  const databasePath = join(dataDirectory, 'teachforge.db');
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    type: 'better-sqlite3',
    driver: Database,
    database: databasePath,
    entities: [
      CourseEntity,
      ConversationEntity,
      MessageEntity,
      RehearsalEntity,
      RehearsalTurnEntity,
      DocumentEntity,
      DocumentVersionEntity,
      ConversationDocumentEntity,
      DocumentChunkEntity,
      ArtifactEntity,
    ],
    migrations: [join(__dirname, 'migrations/*{.js,.ts}')],
    migrationsRun: true,
    migrationsTransactionMode: 'all',
    synchronize: false,
    prepareDatabase(database) {
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
    },
  };
}
