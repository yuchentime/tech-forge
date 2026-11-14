require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { DataSource } = require('typeorm');
const BetterSqlite3 = require('better-sqlite3');

const buildDirectory = path.resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const { ConversationEntity } = require(path.join(
  buildDirectory,
  'conversations/conversation.entity.js',
));
const { MessageEntity } = require(path.join(
  buildDirectory,
  'conversations/message.entity.js',
));
const { StudyNoteEntity } = require(path.join(
  buildDirectory,
  'study-notes/study-note.entity.js',
));
const { StudyNotesService } = require(path.join(
  buildDirectory,
  'study-notes/study-notes.service.js',
));
const { ConversationsService } = require(path.join(
  buildDirectory,
  'conversations/conversations.service.js',
));

/** Title derivation only needs the artifact port; no files are read in these cases. */
const artifactsStub = { listArtifacts: async () => [] };

/** Creates an isolated database with the entities these cases exercise. */
async function createContext() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    driver: BetterSqlite3,
    database: ':memory:',
    entities: [ConversationEntity, MessageEntity, StudyNoteEntity],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  const conversations = new ConversationsService(dataSource, undefined, artifactsStub);
  return {
    dataSource,
    notes: new StudyNotesService(dataSource, conversations),
  };
}

/** Seeds one conversation whose title must be derived from its first user message. */
async function seedConversation(dataSource) {
  const conversationId = randomUUID();
  await dataSource.getRepository(ConversationEntity).save({
    id: conversationId,
    title: null,
  });
  await dataSource.getRepository(MessageEntity).save({
    id: randomUUID(),
    conversationId,
    sequenceNo: 1,
    role: 'user',
    contentJson: JSON.stringify([{ type: 'text', text: 'RabbitMQ 幂等' }]),
    status: 'completed',
    requestId: null,
    contextRefsJson: null,
  });
  return { conversationId };
}

test('a note keeps its conversation and derived title', async () => {
  const ctx = await createContext();
  try {
    const { conversationId } = await seedConversation(ctx.dataSource);
    const created = await ctx.notes.create({
      conversationId,
      content: '  第一行\r\n第二行  ',
    });

    assert.equal(created.conversationId, conversationId);
    assert.equal(created.conversationTitle, 'RabbitMQ 幂等');
    assert.equal(created.content, '第一行\n第二行');
    assert.deepEqual(await ctx.notes.list(), [created]);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('a note without a conversation reports no title', async () => {
  const ctx = await createContext();
  try {
    const created = await ctx.notes.create({ content: '幂等键要覆盖重试' });
    assert.equal(created.conversationId, null);
    assert.equal(created.conversationTitle, null);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('notes are listed newest first', async () => {
  const ctx = await createContext();
  try {
    const older = await ctx.notes.create({ content: '先写' });
    const newer = await ctx.notes.create({ content: '后写' });
    assert.deepEqual(
      (await ctx.notes.list()).map((note) => note.id),
      [newer.id, older.id],
    );
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('empty, oversized and dangling-conversation notes are rejected', async () => {
  const ctx = await createContext();
  try {
    await assert.rejects(() => ctx.notes.create({ content: ' \n ' }), /不能为空/);
    await assert.rejects(
      () => ctx.notes.create({ content: '字'.repeat(2001) }),
      /过长/,
    );
    await assert.rejects(
      () => ctx.notes.create({ content: '孤儿笔记', conversationId: randomUUID() }),
      /会话不存在/,
    );
    assert.equal((await ctx.notes.list()).length, 0);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('removing a note deletes only that row and reports a missing one', async () => {
  const ctx = await createContext();
  try {
    const kept = await ctx.notes.create({ content: '保留' });
    const removed = await ctx.notes.create({ content: '删除' });

    assert.deepEqual(await ctx.notes.remove(removed.id), { id: removed.id });
    assert.deepEqual(
      (await ctx.notes.list()).map((note) => note.id),
      [kept.id],
    );
    await assert.rejects(() => ctx.notes.remove(removed.id), /不存在/);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('editing a note replaces its text and keeps its creation time', async () => {
  const ctx = await createContext();
  try {
    const { conversationId } = await seedConversation(ctx.dataSource);
    const created = await ctx.notes.create({ conversationId, content: '第一版' });

    const updated = await ctx.notes.update(created.id, { content: '  第二版  ' });
    assert.equal(updated.id, created.id);
    assert.equal(updated.content, '第二版');
    assert.equal(updated.createdAt, created.createdAt);
    // 省略 conversationId 时保留原来的关联。
    assert.equal(updated.conversationId, conversationId);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('editing a note can re-link or unlink its conversation', async () => {
  const ctx = await createContext();
  try {
    const { conversationId } = await seedConversation(ctx.dataSource);
    const created = await ctx.notes.create({ content: '笔记' });

    const linked = await ctx.notes.update(created.id, {
      content: '笔记',
      conversationId,
    });
    assert.equal(linked.conversationId, conversationId);
    assert.equal(linked.conversationTitle, 'RabbitMQ 幂等');

    const unlinked = await ctx.notes.update(created.id, {
      content: '笔记',
      conversationId: null,
    });
    assert.equal(unlinked.conversationId, null);
    assert.equal(unlinked.conversationTitle, null);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('editing rejects empty, oversized and dangling values', async () => {
  const ctx = await createContext();
  try {
    const created = await ctx.notes.create({ content: '原始' });

    await assert.rejects(
      () => ctx.notes.update(created.id, { content: ' \n ' }),
      /不能为空/,
    );
    await assert.rejects(
      () => ctx.notes.update(created.id, { content: '字'.repeat(2001) }),
      /过长/,
    );
    await assert.rejects(
      () =>
        ctx.notes.update(created.id, {
          content: '改坏了',
          conversationId: randomUUID(),
        }),
      /会话不存在/,
    );
    await assert.rejects(
      () => ctx.notes.update(randomUUID(), { content: '不存在的行' }),
      /不存在/,
    );
    assert.equal((await ctx.notes.list())[0].content, '原始');
  } finally {
    await ctx.dataSource.destroy();
  }
});
