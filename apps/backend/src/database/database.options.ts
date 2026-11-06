import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database = require('better-sqlite3');
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { CourseEntity } from '../courses/course.entity';

export function buildDatabaseOptions(): TypeOrmModuleOptions {
  const dataDirectory = process.env.TEACHFORGE_DATA_DIR ?? join(process.cwd(), '.data');
  const databasePath = join(dataDirectory, 'teachforge.db');
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    type: 'better-sqlite3',
    driver: Database,
    database: databasePath,
    entities: [CourseEntity],
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
