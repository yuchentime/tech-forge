require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { ChatModule } = load('chat/chat.module.js');
const { ChatService } = load('chat/chat.service.js');
const { AttachmentsService } = load('attachments/attachments.service.js');
const { ConversationsService } = load('conversations/conversations.service.js');
const { KnowledgeService } = load('knowledge/knowledge.service.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-attachments-'));
const createdApps = [];

test.after(() => {
  for (const app of createdApps) {
    try {
      app.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** Boots the real Chat module graph against a real SQLite file and a scratch config directory. */
async function createIntegrationApp() {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  const configDirectory = mkdtempSync(join(scratchRoot, 'config-'));
  const workspacePath = join(configDirectory, 'workspace');
  // Isolate settings and workspace: a run must never touch the developer's real files.
  writeFileSync(
    join(configDirectory, 'config.toml'),
    `[workspace]\npath = ${JSON.stringify(workspacePath)}\n`,
    'utf8',
  );
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class AttachmentTestModule {}
  Module({
    imports: [TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }), ChatModule],
  })(AttachmentTestModule);

  const app = await NestFactory.createApplicationContext(AttachmentTestModule, { logger: false });
  createdApps.push(app);
  return {
    configDirectory,
    attachments: app.get(AttachmentsService),
    conversations: app.get(ConversationsService),
    dataSource: app.get(DataSource),
    /** Builds a ChatService with a recording stand-in for the model. */
    chatWith(recorder) {
      return new ChatService(
        recorder,
        app.get(ConversationsService),
        app.get(KnowledgeService),
        app.get(AttachmentsService),
      );
    },
    async close() {
      await app.close();
      const index = createdApps.indexOf(app);
      if (index >= 0) createdApps.splice(index, 1);
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

/** Writes one fixture file into the scratch directory. */
function writeFixture(name, content) {
  const path = join(scratchRoot, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Records the request it receives and ends the turn without calling a provider. */
function createRecordingLlm() {
  const calls = [];
  return {
    calls,
    stream(prompt, options) {
      calls.push({ prompt, options });
      return (async function* streamNothing() {})();
    },
  };
}

test('an attachment is copied into the conversation session directory', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('lecture.md', '# 光合作用\n\n把光能转化为化学能。');
  const conversationId = '11111111-1111-4111-8111-111111111111';

  try {
    const stored = await ctx.attachments.storeForConversation(conversationId, [
      { attachmentId: '22222222-2222-4222-8222-222222222222', path: source },
    ]);

    assert.deepEqual(stored.failures, []);
    assert.equal(stored.contents.length, 1);
    assert.match(stored.contents[0].text, /光合作用/);
    assert.deepEqual(stored.refs, [
      {
        attachmentId: '22222222-2222-4222-8222-222222222222',
        name: 'lecture.md',
        characters: 18,
      },
    ]);
    assert.match(
      readFileSync(
        join(
          ctx.configDirectory,
          'sessions',
          conversationId,
          'attachments',
          '22222222-2222-4222-8222-222222222222',
          'text.md',
        ),
        'utf8',
      ),
      /光合作用/,
      'the extracted text must be readable by later turns',
    );
    assert.ok(
      existsSync(
        join(
          ctx.configDirectory,
          'sessions',
          conversationId,
          'attachments',
          '22222222-2222-4222-8222-222222222222',
          'lecture.md',
        ),
      ),
      'the file must be stored under its own conversation',
    );
  } finally {
    await ctx.close();
  }
});

test('an unreadable or unsupported attachment is reported, not fatal', async () => {
  const ctx = await createIntegrationApp();
  const conversationId = '33333333-3333-4333-8333-333333333333';

  try {
    const stored = await ctx.attachments.storeForConversation(conversationId, [
      { attachmentId: '44444444-4444-4444-8444-444444444444', path: join(scratchRoot, 'missing.md') },
      { attachmentId: '55555555-5555-4555-8555-555555555555', path: writeFixture('image.png', 'x') },
    ]);

    assert.deepEqual(stored.contents, []);
    assert.deepEqual(
      stored.failures.map((failure) => failure.reason),
      ['missing', 'unsupported'],
    );
    // The message still shows both tags even though neither file was readable.
    assert.equal(stored.refs.length, 2);
  } finally {
    await ctx.close();
  }
});

test('a chat turn injects the full attachment text and keeps only the reference', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('handout.md', '# 细胞结构\n\n细胞膜控制物质进出。');

  try {
    const llm = createRecordingLlm();
    const chat = ctx.chatWith(llm);

    const events = [];
    for await (const event of chat.stream(
      '这份讲义讲了什么',
      undefined,
      new AbortController().signal,
      'request-1',
      [{ attachmentId: '66666666-6666-4666-8666-666666666666', path: source }],
    )) {
      events.push(event);
    }

    const conversationEvent = events.find((event) => event.type === 'conversation');
    assert.ok(conversationEvent, 'the turn must announce its conversation id');

    assert.equal(llm.calls.length, 1);
    // The user message stays clean; reference material travels beside it, not in the system prompt.
    assert.equal(llm.calls[0].prompt, '这份讲义讲了什么');
    const { options } = llm.calls[0];
    assert.match(options.promptContext, /本轮用户附加的文件/);
    assert.match(options.promptContext, /细胞膜控制物质进出/);
    assert.doesNotMatch(options.promptContext, /## 用户输入/);

    assert.ok(
      existsSync(
        join(
          ctx.configDirectory,
          'sessions',
          conversationEvent.conversationId,
          'attachments',
          '66666666-6666-4666-8666-666666666666',
          'handout.md',
        ),
      ),
      'the copy must land in the conversation that sent it',
    );

    const [userRow] = await ctx.dataSource.query(
      "SELECT contextRefsJson FROM messages WHERE conversationId = ? AND role = 'user'",
      [conversationEvent.conversationId],
    );
    assert.deepEqual(JSON.parse(userRow.contextRefsJson).attachments, [
      {
        attachmentId: '66666666-6666-4666-8666-666666666666',
        name: 'handout.md',
        characters: 18,
        injectedCharacters: 18,
      },
    ]);

    const page = await ctx.conversations.getConversationMessages(
      conversationEvent.conversationId,
    );
    const userMessage = page.messages.find((message) => message.role === 'user');
    assert.equal(userMessage.content, '这份讲义讲了什么');
    assert.deepEqual(userMessage.attachments, [
      { attachmentId: '66666666-6666-4666-8666-666666666666', name: 'handout.md' },
    ]);
  } finally {
    await ctx.close();
  }
});

test('attachment text beyond the injection limit is cut, and later files are skipped', async () => {
  const ctx = await createIntegrationApp();
  // 6000 × 7 characters ≈ 42k, just over the 40k injection limit.
  const longText = '光合作用段落。'.repeat(6000);
  const longSource = writeFixture('long-lecture.md', `# 长讲义\n\n${longText}`);
  const secondSource = writeFixture('second.md', '# 第二份\n\n只讲一个短概念。');

  try {
    const llm = createRecordingLlm();
    const chat = ctx.chatWith(llm);

    for await (const _event of chat.stream(
      '总结一下',
      undefined,
      new AbortController().signal,
      'request-2',
      [
        { attachmentId: '99999999-9999-4999-8999-999999999999', path: longSource },
        { attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', path: secondSource },
      ],
    )) {
      // The turn only needs to finish; the recorded request is what matters.
    }

    const context = llm.calls[0].options.promptContext;
    assert.ok(
      context.length < 41_000,
      `injected ${context.length} characters, which exceeds the guard`,
    );
    assert.match(context, /本轮只提供开头/);
    assert.match(context, /没有提供任何内容：.*second\.md/);
  } finally {
    await ctx.close();
  }
});

test('a later turn points the model at the stored attachment text instead of re-injecting it', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('follow-up.md', '# 细胞结构\n\n细胞膜控制物质进出。');
  const attachmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  try {
    const llm = createRecordingLlm();
    const chat = ctx.chatWith(llm);

    let conversationId;
    for await (const event of chat.stream(
      '这份讲义讲了什么',
      undefined,
      new AbortController().signal,
      'request-3',
      [{ attachmentId, path: source }],
    )) {
      if (event.type === 'conversation') conversationId = event.conversationId;
    }
    assert.ok(conversationId);
    assert.match(llm.calls[0].options.promptContext, /细胞膜控制物质进出/);

    // Second turn: no new attachments, so the text must not be injected again — only the path.
    for await (const _event of chat.stream(
      '第三节再展开讲讲',
      conversationId,
      new AbortController().signal,
      'request-4',
    )) {
      // Drain the turn.
    }

    assert.equal(llm.calls[1].prompt, '第三节再展开讲讲');
    const followUp = llm.calls[1].options.promptContext;
    assert.match(followUp, /本会话可读取的附件/);
    assert.match(followUp, /follow-up\.md/);
    assert.match(followUp, /text\.md/);
    assert.match(followUp, /已注入 \d+ 字/);
    assert.doesNotMatch(followUp, /细胞膜控制物质进出/);
  } finally {
    await ctx.close();
  }
});
