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
const { FocusItemEntity } = require(path.join(
  buildDirectory,
  'focus-items/focus-item.entity.js',
));
const { FocusItemsService } = require(path.join(
  buildDirectory,
  'focus-items/focus-items.service.js',
));
const { ConversationsService } = require(path.join(
  buildDirectory,
  'conversations/conversations.service.js',
));

/** Title derivation only needs the artifact port; no files are read in these cases. */
const artifactsStub = { listArtifacts: async () => [] };

/** Creates an isolated database with the three entities these cases exercise. */
async function createContext() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    driver: BetterSqlite3,
    database: ':memory:',
    entities: [ConversationEntity, MessageEntity, FocusItemEntity],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  const conversations = new ConversationsService(dataSource, undefined, artifactsStub);
  return {
    dataSource,
    conversations,
    focus: new FocusItemsService(dataSource, conversations),
  };
}

/** Seeds one visible user message and one assistant reply. */
async function seedConversation(dataSource) {
  const conversationId = randomUUID();
  const userId = randomUUID();
  const assistantId = randomUUID();
  await dataSource.getRepository(ConversationEntity).save({
    id: conversationId,
    title: null,
  });
  await dataSource.getRepository(MessageEntity).save([
    {
      id: userId,
      conversationId,
      sequenceNo: 1,
      role: 'user',
      contentJson: JSON.stringify([{ type: 'text', text: 'RabbitMQ 幂等' }]),
      status: 'completed',
      requestId: null,
      contextRefsJson: null,
    },
    {
      id: assistantId,
      conversationId,
      sequenceNo: 2,
      role: 'assistant',
      contentJson: JSON.stringify({
        format: 'teachforge-pi-message-v1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'CAS + 唯一键' }],
        },
      }),
      status: 'completed',
      requestId: null,
      contextRefsJson: null,
    },
  ]);
  return { conversationId, userId, assistantId };
}

test('saving an excerpt stores its message position and derives the conversation title', async () => {
  const ctx = await createContext();
  try {
    const { conversationId, assistantId } = await seedConversation(ctx.dataSource);
    const created = await ctx.focus.create({
      conversationId,
      messageId: assistantId,
      quote: 'CAS + 唯一键',
      messageIndex: 2,
    });

    assert.equal(created.conversationId, conversationId);
    assert.equal(created.conversationTitle, 'RabbitMQ 幂等');
    assert.equal(created.messageIndex, 2);
    assert.equal(created.quote, 'CAS + 唯一键');
    assert.equal(created.note, null);

    const row = await ctx.dataSource
      .getRepository(FocusItemEntity)
      .findOneBy({ id: created.id });
    assert.equal(row.messageSequenceNo, 2);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('the same normalized excerpt is saved once', async () => {
  const ctx = await createContext();
  try {
    const { conversationId, assistantId } = await seedConversation(ctx.dataSource);
    const first = await ctx.focus.create({
      conversationId,
      messageId: assistantId,
      quote: 'CAS + 唯一键',
      messageIndex: 2,
    });
    const second = await ctx.focus.create({
      conversationId,
      messageId: assistantId,
      quote: '  CAS + 唯一键\r\n',
      messageIndex: 2,
    });

    assert.equal(second.id, first.id);
    assert.equal((await ctx.focus.list()).length, 1);
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('only assistant messages from the requested conversation can be saved', async () => {
  const ctx = await createContext();
  try {
    const { conversationId, userId, assistantId } = await seedConversation(ctx.dataSource);

    await assert.rejects(
      () =>
        ctx.focus.create({
          conversationId,
          messageId: userId,
          quote: 'RabbitMQ 幂等',
          messageIndex: 1,
        }),
      /只能关注助手回复/,
    );
    await assert.rejects(
      () =>
        ctx.focus.create({
          conversationId: randomUUID(),
          messageId: assistantId,
          quote: 'CAS + 唯一键',
          messageIndex: 2,
        }),
      /消息不存在/,
    );
    await assert.rejects(
      () =>
        ctx.focus.create({
          conversationId,
          messageId: assistantId,
          quote: '   ',
          messageIndex: 2,
        }),
      /不能为空/,
    );
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('study notes can be saved, cleared and bounded', async () => {
  const ctx = await createContext();
  try {
    const { conversationId, assistantId } = await seedConversation(ctx.dataSource);
    const created = await ctx.focus.create({
      conversationId,
      messageId: assistantId,
      quote: 'CAS + 唯一键',
      messageIndex: 2,
    });
    assert.equal(created.note, null);

    const noted = await ctx.focus.updateNote(created.id, '  第一行\n第二行  ');
    assert.equal(noted.note, '第一行\n第二行');
    assert.equal((await ctx.focus.list())[0].note, '第一行\n第二行');

    const cleared = await ctx.focus.updateNote(created.id, '   ');
    assert.equal(cleared.note, null);

    await assert.rejects(
      () => ctx.focus.updateNote(created.id, '字'.repeat(2001)),
      /过长/,
    );
    await assert.rejects(
      () => ctx.focus.updateNote(randomUUID(), '备注'),
      /不存在/,
    );
  } finally {
    await ctx.dataSource.destroy();
  }
});

test('listing reflects conversation renames and deletion removes the saved excerpt', async () => {
  const ctx = await createContext();
  try {
    const { conversationId, assistantId } = await seedConversation(ctx.dataSource);
    const created = await ctx.focus.create({
      conversationId,
      messageId: assistantId,
      quote: 'CAS + 唯一键',
      messageIndex: 2,
    });

    await ctx.dataSource
      .getRepository(ConversationEntity)
      .update({ id: conversationId }, { title: '幂等设计' });
    const renamed = await ctx.focus.list();
    assert.equal(renamed[0].conversationTitle, '幂等设计');

    await ctx.focus.remove(created.id);
    assert.deepEqual(await ctx.focus.list(), []);
    await assert.rejects(() => ctx.focus.remove(created.id), /不存在/);
  } finally {
    await ctx.dataSource.destroy();
  }
});
