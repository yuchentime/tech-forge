require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { DataSource } = require('typeorm');
const buildDirectory = path.resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { ConversationEntity } = require(path.join(buildDirectory, 'conversations/conversation.entity.js'));
const { MessageEntity } = require(path.join(buildDirectory, 'conversations/message.entity.js'));
const { ConversationsService } = require(path.join(buildDirectory, 'conversations/conversations.service.js'));

/** Creates an isolated in-memory database with the production conversation entities. */
async function createTestDatabase() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [ConversationEntity, MessageEntity],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  return dataSource;
}

/** Creates the native Pi message envelope used by persisted assistant/tool rows. */
function piMessage(role, text) {
  return JSON.stringify({
    format: 'teachforge-pi-message-v1',
    message: { role, content: [{ type: 'text', text }] },
  });
}

/** Creates an ordered SQLite row fixture with the same fields as MessageEntity. */
function messageRow(conversationId, sequenceNo, role, contentJson, id = randomUUID()) {
  return {
    id,
    conversationId,
    sequenceNo,
    role,
    contentJson,
    status: 'completed',
    requestId: null,
    contextRefsJson: null,
  };
}

/** Creates a persisted tool execution row, including private fields to assert non-disclosure. */
function toolExecutionRow(conversationId, sequenceNo, callNumber, includeDisplayPath = true) {
  return messageRow(
    conversationId,
    sequenceNo,
    'toolExecution',
    JSON.stringify({
      format: 'teachforge-tool-execution-v1',
      toolCallId: `call-${callNumber}`,
      toolName: 'write',
      ...(includeDisplayPath
        ? { displayPath: `C:/workspace/file-${callNumber}.txt` }
        : {}),
      status: 'completed',
      durationMs: 42,
      partialResult: { secret: 'must not leave storage' },
      result: { secret: 'must not leave storage' },
    }),
  );
}

/** Seeds one conversation turn with a user message, execution row, and assistant response. */
async function seedTurn(repository, conversationId, turnIndex, sequenceNo, includeDisplayPath = true) {
  const userId = `00000000-0000-4000-8000-${String(turnIndex + 1).padStart(12, '0')}`;
  const rows = [
    messageRow(
      conversationId,
      sequenceNo,
      'user',
      JSON.stringify([{ type: 'text', text: `prompt-${turnIndex}` }]),
      userId,
    ),
    messageRow(
      conversationId,
      sequenceNo + 1,
      'assistantTurn',
      JSON.stringify({ format: 'teachforge-assistant-turn-v1' }),
    ),
    toolExecutionRow(conversationId, sequenceNo + 2, turnIndex + 1, includeDisplayPath),
    messageRow(
      conversationId,
      sequenceNo + 3,
      'assistant',
      piMessage('assistant', `answer-${turnIndex}`),
    ),
  ];
  await repository.save(rows);
  return { userId, nextSequenceNo: sequenceNo + 4 };
}

test('history nests durable tool execution under its user without exposing results', async () => {
  const dataSource = await createTestDatabase();
  try {
    const conversationId = randomUUID();
    await dataSource.getRepository(ConversationEntity).save({ id: conversationId, title: null });
    const { userId } = await seedTurn(
      dataSource.getRepository(MessageEntity),
      conversationId,
      0,
      1,
    );

    const page = await new ConversationsService(dataSource).getConversationMessages(
      conversationId,
    );
    const user = page.messages.find(({ id }) => id === userId);
    const assistant = page.messages.find(({ role }) => role === 'assistant');

    assert.deepEqual(user.toolActivities, [
      {
        toolCallId: 'call-1',
        toolName: 'write',
        path: 'C:/workspace/file-1.txt',
        status: 'completed',
        durationMs: 42,
      },
    ]);
    assert.equal(Object.hasOwn(assistant, 'toolActivities'), false);
    assert.deepEqual(page.messages.map(({ role }) => role), ['user', 'assistant']);
    assert.equal(JSON.stringify(page).includes('must not leave storage'), false);
  } finally {
    await dataSource.destroy();
  }
});

test('cursor history keeps tool activity attached to the earlier user turn', async () => {
  const dataSource = await createTestDatabase();
  try {
    const conversationId = randomUUID();
    await dataSource.getRepository(ConversationEntity).save({ id: conversationId, title: null });
    const repository = dataSource.getRepository(MessageEntity);
    const users = [];
    let sequenceNo = 1;
    for (let turnIndex = 0; turnIndex < 16; turnIndex += 1) {
      const turn = await seedTurn(repository, conversationId, turnIndex, sequenceNo);
      users.push(turn.userId);
      sequenceNo = turn.nextSequenceNo;
    }

    const service = new ConversationsService(dataSource);
    const latestPage = await service.getConversationMessages(conversationId);
    const earlierPage = await service.getConversationMessages(
      conversationId,
      latestPage.messages[0].id,
    );

    assert.equal(latestPage.messages.length, 30);
    assert.equal(latestPage.hasMore, true);
    assert.equal(earlierPage.messages[0].id, users[0]);
    assert.deepEqual(earlierPage.messages.map(({ role }) => role), ['user', 'assistant']);
    assert.deepEqual(earlierPage.messages[0].toolActivities, [
      {
        toolCallId: 'call-1',
        toolName: 'write',
        path: 'C:/workspace/file-1.txt',
        status: 'completed',
        durationMs: 42,
      },
    ]);
  } finally {
    await dataSource.destroy();
  }
});

test('legacy tool executions without a display path remain visible', async () => {
  const dataSource = await createTestDatabase();
  try {
    const conversationId = randomUUID();
    await dataSource.getRepository(ConversationEntity).save({ id: conversationId, title: null });
    const { userId } = await seedTurn(
      dataSource.getRepository(MessageEntity),
      conversationId,
      0,
      1,
      false,
    );

    const page = await new ConversationsService(dataSource).getConversationMessages(
      conversationId,
    );
    const user = page.messages.find(({ id }) => id === userId);

    assert.deepEqual(user.toolActivities, [
      {
        toolCallId: 'call-1',
        toolName: 'write',
        status: 'completed',
        durationMs: 42,
      },
    ]);
  } finally {
    await dataSource.destroy();
  }
});
