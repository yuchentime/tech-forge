require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { BadRequestException, Module, NotFoundException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { ConversationsModule } = load('conversations/conversations.module.js');
const { ConversationsService } = load('conversations/conversations.service.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-conversation-rename-'));

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

  class RenameTestModule {}
  Module({
    imports: [TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }), ConversationsModule],
  })(RenameTestModule);

  const app = await NestFactory.createApplicationContext(RenameTestModule, { logger: false });
  return {
    conversations: app.get(ConversationsService),
    async close() {
      await app.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

test('a stored title survives later turns and outranks the first prompt', async () => {
  const ctx = await createIntegrationApp();

  try {
    const { conversationId } = await ctx.conversations.createConversation();
    await ctx.conversations.beginTurn(conversationId, '帮我设计一节关于缓存的课', false);

    const renamed = await ctx.conversations.renameConversation(
      conversationId,
      '  期末   复习  ',
    );
    assert.deepEqual(renamed, { id: conversationId, title: '期末 复习' });

    const [firstSummary] = await ctx.conversations.listConversations();
    assert.equal(firstSummary.title, '期末 复习');

    await ctx.conversations.beginTurn(conversationId, '第二节内容', false);
    const [laterSummary] = await ctx.conversations.listConversations();
    assert.equal(laterSummary.title, '期末 复习');
  } finally {
    await ctx.close();
  }
});

test('titles are bounded at 20 code points and reject empty or missing conversations', async () => {
  const ctx = await createIntegrationApp();

  try {
    const { conversationId } = await ctx.conversations.createConversation();
    const twentyCharacters = '一二三四五六七八九十一二三四五六七八九十';
    assert.equal(Array.from(twentyCharacters).length, 20);

    await ctx.conversations.renameConversation(conversationId, twentyCharacters);
    const [summary] = await ctx.conversations.listConversations();
    assert.equal(summary.title, twentyCharacters);

    await assert.rejects(
      () => ctx.conversations.renameConversation(conversationId, `${twentyCharacters}二`),
      BadRequestException,
    );
    await assert.rejects(
      () => ctx.conversations.renameConversation(conversationId, '   '),
      BadRequestException,
    );
    await assert.rejects(
      () => ctx.conversations.renameConversation('99999999-9999-4999-8999-999999999999', '名称'),
      NotFoundException,
    );

    const [unchanged] = await ctx.conversations.listConversations();
    assert.equal(unchanged.title, twentyCharacters);
  } finally {
    await ctx.close();
  }
});
