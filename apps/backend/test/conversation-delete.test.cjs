require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { NotFoundException } = require('@nestjs/common');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { ConversationsModule } = load('conversations/conversations.module.js');
const { ConversationsService } = load('conversations/conversations.service.js');
const { FocusItemEntity } = load('focus-items/focus-item.entity.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-conversation-delete-'));

test.after(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** Boots the conversation domain against a real SQLite file and a scratch config directory. */
async function createIntegrationApp() {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  const configDirectory = mkdtempSync(join(scratchRoot, 'config-'));
  writeFileSync(
    join(configDirectory, 'config.toml'),
    `[workspace]\npath = ${JSON.stringify(join(configDirectory, 'workspace'))}\n`,
    'utf8',
  );
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class DeleteTestModule {}
  Module({
    imports: [TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }), ConversationsModule],
  })(DeleteTestModule);

  const app = await NestFactory.createApplicationContext(DeleteTestModule, { logger: false });
  return {
    configDirectory,
    conversations: app.get(ConversationsService),
    dataSource: app.get(DataSource),
    async close() {
      await app.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

test('deleting a conversation removes its rows, children and session files', async () => {
  const ctx = await createIntegrationApp();
  const conversationId = '77777777-7777-4777-8777-777777777777';
  const sessionDirectory = join(ctx.configDirectory, 'sessions', conversationId);

  try {
    await ctx.conversations.beginTurn(conversationId, '这份讲义讲了什么', true);
    await ctx.dataSource.query(
      'INSERT INTO pi_session_snapshots (conversation_id, entries_json) VALUES (?, ?)',
      [conversationId, '[]'],
    );
    await ctx.dataSource.getRepository(FocusItemEntity).save({
      id: '99999999-9999-4999-8999-999999999999',
      conversationId,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      messageSequenceNo: 1,
      messageIndex: 1,
      quote: '保存的摘录',
      quoteKey: 'test-quote-key',
    });
    const attachmentDirectory = join(sessionDirectory, 'attachments', 'att-1');
    mkdirSync(attachmentDirectory, { recursive: true });
    writeFileSync(join(attachmentDirectory, 'lecture.md'), '# 讲义', 'utf8');

    const result = await ctx.conversations.deleteConversation(conversationId);
    assert.deepEqual(result, { conversationId, sessionCleanup: 'complete' });

    const counts = await Promise.all([
      ctx.dataSource.query('SELECT COUNT(*) AS total FROM conversations WHERE id = ?', [
        conversationId,
      ]),
      ctx.dataSource.query('SELECT COUNT(*) AS total FROM messages WHERE "conversationId" = ?', [
        conversationId,
      ]),
      ctx.dataSource.query(
        'SELECT COUNT(*) AS total FROM pi_session_snapshots WHERE conversation_id = ?',
        [conversationId],
      ),
      ctx.dataSource.query(
        'SELECT COUNT(*) AS total FROM focus_items WHERE "conversationId" = ?',
        [conversationId],
      ),
    ]);
    assert.deepEqual(
      counts.map((rows) => Number(rows[0].total)),
      [0, 0, 0, 0],
    );
    assert.equal(existsSync(sessionDirectory), false, 'session files must be removed');
  } finally {
    await ctx.close();
  }
});

test('deleting a missing conversation reports not found', async () => {
  const ctx = await createIntegrationApp();

  try {
    await assert.rejects(
      () => ctx.conversations.deleteConversation('88888888-8888-4888-8888-888888888888'),
      NotFoundException,
    );
  } finally {
    await ctx.close();
  }
});
