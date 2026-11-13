require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} = require('node:fs');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));
const { buildDatabaseOptions } = load('database/database.options.js');
const { ClassroomModule } = load('classroom/classroom.module.js');
const { LessonsService } = load('lessons/lessons.service.js');
const { LessonEntity } = load('lessons/lesson.entity.js');
const { ClassroomTurnsService } = load('classroom/classroom-turns.service.js');
const { ClassroomSummariesService } = load('classroom/classroom-summaries.service.js');

const LOCAL_TOKEN = 'classroom-test-token';
const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-classroom-'));
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

/** Boots the real classroom module with a throwaway config root and SQLite file. */
async function createServer() {
  const root = mkdtempSync(join(scratchRoot, 'app-'));
  const configDirectory = join(root, 'config');
  mkdirSync(configDirectory, { recursive: true });
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = join(root, 'data');

  class IntegrationModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      ClassroomModule,
    ],
  })(IntegrationModule);

  const app = await NestFactory.create(
    IntegrationModule,
    new FastifyAdapter({ bodyLimit: 1_048_576 }),
    { logger: false },
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Mirrors the real bootstrap hook in `main.ts`; the controller itself has no auth code.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin) {
      reply.code(403).send({ statusCode: 403, message: 'Origin is not allowed.' });
      return;
    }
    if (request.headers['x-teachforge-token'] !== LOCAL_TOKEN) {
      reply.code(401).send({ statusCode: 401, message: 'Unauthorized.' });
    }
  });
  await app.listen(0, '127.0.0.1');
  createdApps.push(app);
  const address = app.getHttpServer().address();

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    lessons: app.get(LessonsService),
    dataSource: app.get(DataSource),
  };
}

/** Sends one request with optional auth/origin/method overrides. */
async function request(ctx, path, options = {}) {
  const headers = {};
  if (options.token !== false) {
    headers['x-teachforge-token'] = options.token ?? LOCAL_TOKEN;
  }
  if (options.origin) headers.origin = options.origin;
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body
      ? { ...headers, 'content-type': 'application/json' }
      : headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

test('GET /api/lessons/:id/messages attributes every line to its speaker', async () => {
  const ctx = await createServer();
  try {
    const lesson = await ctx.lessons.startLesson();
    await ctx.lessons.appendMessage(lesson.id, 'teacher', '今天我们讲缓存雪崩。');
    await ctx.lessons.appendMessage(lesson.id, 'lin', '老师，大量 key 同时过期会怎样？');

    const result = await request(ctx, `/api/lessons/${lesson.id}/messages`);
    assert.equal(result.status, 200);
    assert.equal(result.data.lessonId, lesson.id);
    assert.equal(result.data.status, 'active');
    assert.deepEqual(result.data.integrity, {
      status: 'ok',
      corruptLineCount: 0,
      corruptLineNumbers: [],
    });
    assert.equal(result.data.messages.length, 2);

    const [teacherMessage, studentMessage] = result.data.messages;
    assert.equal(teacherMessage.speaker, 'teacher');
    assert.equal(teacherMessage.role, 'teacher');
    assert.equal(teacherMessage.name, '老师');
    assert.equal(teacherMessage.text, '今天我们讲缓存雪崩。');
    assert.equal(typeof teacherMessage.id, 'string');
    assert.equal(typeof teacherMessage.createdAt, 'string');

    assert.equal(studentMessage.speaker, 'lin');
    assert.equal(studentMessage.role, 'student');
    assert.equal(studentMessage.name, '林澈');
    assert.equal(studentMessage.text, '老师，大量 key 同时过期会怎样？');
    assert.notEqual(studentMessage.id, teacherMessage.id);
  } finally {
    await cleanup(ctx);
  }
});

test('POST /api/lessons creates a lesson and POST /:id/end is idempotent', async () => {
  const ctx = await createServer();
  try {
    const created = await request(ctx, '/api/lessons', { method: 'POST' });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, 'active');
    assert.equal(created.data.endedAt, null);

    const ended = await request(ctx, `/api/lessons/${created.data.id}/end`, {
      method: 'POST',
    });
    assert.equal(ended.status, 200);
    assert.equal(ended.data.status, 'ended');
    assert.equal(typeof ended.data.endedAt, 'string');

    const endedAgain = await request(ctx, `/api/lessons/${created.data.id}/end`, {
      method: 'POST',
    });
    assert.equal(endedAgain.status, 200);
    assert.equal(endedAgain.data.status, 'ended');

    const messages = await request(ctx, `/api/lessons/${created.data.id}/messages`);
    assert.equal(messages.status, 200);
    assert.equal(messages.data.status, 'ended');
    assert.equal(messages.data.messages.length, 0);
  } finally {
    await cleanup(ctx);
  }
});

test('ending an unknown lesson is 404', async () => {
  const ctx = await createServer();
  try {
    const result = await request(ctx, `/api/lessons/${randomUUID()}/end`, {
      method: 'POST',
    });
    assert.equal(result.status, 404);
  } finally {
    await cleanup(ctx);
  }
});

test('a corrupt transcript degrades the read but blocks appending', async () => {
  const ctx = await createServer();
  try {
    const lesson = await ctx.lessons.startLesson();
    await ctx.lessons.appendMessage(lesson.id, 'teacher', '第一句。');
    await ctx.lessons.appendMessage(lesson.id, 'su', '第二句。');

    const transcriptPath = join(
      process.env.TEACHFORGE_CONFIG_DIR,
      'lessons',
      lesson.id,
      'messages.jsonl',
    );
    appendFileSync(transcriptPath, '{"broken":\n', 'utf8');

    const read = await request(ctx, `/api/lessons/${lesson.id}/messages`);
    assert.equal(read.status, 200);
    assert.equal(read.data.integrity.status, 'degraded');
    assert.equal(read.data.integrity.corruptLineCount, 1);
    assert.deepEqual(read.data.integrity.corruptLineNumbers, [3]);
    assert.equal(read.data.messages.length, 2);
    assert.equal(read.data.messages[1].name, '苏小满');

    // A turn must not append into a damaged file; recovery is "start a new lesson" instead.
    await assert.rejects(() => ctx.lessons.readMessages(lesson.id), /corrupt at line/);
    await assert.rejects(
      () => ctx.lessons.appendMessage(lesson.id, 'teacher', '第三句。'),
      /corrupt at line/,
    );
  } finally {
    await cleanup(ctx);
  }
});

test('unknown lesson is 404 and a malformed id is 400', async () => {
  const ctx = await createServer();
  try {
    const missing = await request(ctx, `/api/lessons/${randomUUID()}/messages`);
    assert.equal(missing.status, 404);

    const malformed = await request(ctx, '/api/lessons/not-a-uuid/messages');
    assert.equal(malformed.status, 400);
  } finally {
    await cleanup(ctx);
  }
});

test('GET /api/lessons returns lifecycle rows with summary previews', async () => {
  const ctx = await createServer();
  try {
    const ended = await ctx.lessons.startLesson();
    await ctx.lessons.appendMessage(ended.id, 'teacher', '讲完的内容。');
    await ctx.lessons.endLesson(ended.id);
    // Only one active lesson may exist; create it after the ended one.
    const active = await ctx.lessons.startLesson();
    await ctx.dataSource.getRepository(LessonEntity).update(
      { id: ended.id },
      {
        summaryStatus: 'ready',
        summaryMarkdown: '## 本节讲了什么\n缓存雪崩。',
        summaryGeneratedAt: new Date(),
      },
    );

    const all = await request(ctx, '/api/lessons');
    assert.equal(all.status, 200);
    assert.equal(all.data.lessons.length, 2);
    const endedRow = all.data.lessons.find((lesson) => lesson.id === ended.id);
    assert.equal(endedRow.status, 'ended');
    assert.equal(endedRow.summaryStatus, 'ready');
    assert.match(endedRow.summaryPreview, /本节讲了什么/);

    const onlyActive = await request(ctx, '/api/lessons?status=active');
    assert.equal(onlyActive.status, 200);
    assert.deepEqual(
      onlyActive.data.lessons.map((lesson) => lesson.id),
      [active.id],
    );

    const onlyEnded = await request(ctx, '/api/lessons?status=ended');
    assert.deepEqual(
      onlyEnded.data.lessons.map((lesson) => lesson.id),
      [ended.id],
    );

    const invalid = await request(ctx, '/api/lessons?status=paused');
    assert.equal(invalid.status, 400);
  } finally {
    await cleanup(ctx);
  }
});

test('summary endpoint returns stored Markdown and refuses active lessons', async () => {
  const ctx = await createServer();
  try {
    const active = await ctx.lessons.startLesson();
    const activeResult = await request(ctx, `/api/lessons/${active.id}/summary`, {
      method: 'POST',
    });
    assert.equal(activeResult.status, 409);
    await ctx.lessons.endLesson(active.id);

    const ended = await ctx.lessons.startLesson();
    await ctx.lessons.endLesson(ended.id);
    await ctx.dataSource.getRepository(LessonEntity).update(
      { id: ended.id },
      {
        summaryStatus: 'ready',
        summaryMarkdown: '## 本节讲了什么\n缓存雪崩。',
        summaryGeneratedAt: new Date(),
      },
    );

    const read = await request(ctx, `/api/lessons/${ended.id}/summary`);
    assert.equal(read.status, 200);
    assert.equal(read.data.summaryStatus, 'ready');
    assert.equal(read.data.summary, '## 本节讲了什么\n缓存雪崩。');
    assert.equal(typeof read.data.generatedAt, 'string');
    assert.equal(read.data.error, null);
  } finally {
    await cleanup(ctx);
  }
});

test('summary generation on a corrupt record fails without calling the model', async () => {
  const ctx = await createServer();
  try {
    const lesson = await ctx.lessons.startLesson();
    await ctx.lessons.appendMessage(lesson.id, 'teacher', '一句。');
    await ctx.lessons.endLesson(lesson.id);
    appendFileSync(
      join(process.env.TEACHFORGE_CONFIG_DIR, 'lessons', lesson.id, 'messages.jsonl'),
      '{"broken":\n',
      'utf8',
    );

    const result = await request(ctx, `/api/lessons/${lesson.id}/summary`, {
      method: 'POST',
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.summaryStatus, 'failed');
    assert.equal(result.data.error, '课堂记录损坏，无法生成总结。');
  } finally {
    await cleanup(ctx);
  }
});

test('POST turns validates lesson state and text before any model call', async () => {
  const ctx = await createServer();
  try {
    const lesson = await ctx.lessons.startLesson();
    const path = `/api/lessons/${lesson.id}/turns`;

    const blank = await request(ctx, path, { method: 'POST', body: { text: '   ' } });
    assert.equal(blank.status, 400);

    const missing = await request(
      ctx,
      `/api/lessons/${randomUUID()}/turns`,
      { method: 'POST', body: { text: '你好' } },
    );
    assert.equal(missing.status, 404);

    await ctx.lessons.endLesson(lesson.id);
    const ended = await request(ctx, path, { method: 'POST', body: { text: '你好' } });
    assert.equal(ended.status, 409);
  } finally {
    await cleanup(ctx);
  }
});

test('starting a new classroom closes the previous active one', async () => {
  const ctx = await createServer();
  try {
    const first = await request(ctx, '/api/lessons', { method: 'POST' });
    assert.equal(first.status, 201);

    const second = await request(ctx, '/api/lessons', { method: 'POST' });
    assert.equal(second.status, 201);
    assert.notEqual(second.data.id, first.data.id);

    const repository = ctx.dataSource.getRepository(LessonEntity);
    const activeRows = await repository.find({ where: { status: 'active' } });
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].id, second.data.id);

    const previous = await repository.findOne({ where: { id: first.data.id } });
    assert.equal(previous.status, 'ended');
    assert.ok(previous.endedAt);
  } finally {
    await cleanup(ctx);
  }
});

test('the HTTP turn endpoint returns the enriched transcript', async () => {
  const ctx = await createServer();
  try {
    const lesson = await ctx.lessons.startLesson();
    const turns = ctx.app.get(ClassroomTurnsService);
    // Replace only the model-backed runner; persistence and the controller stay real.
    turns.runTurn = async (lessonId, text) => {
      await ctx.lessons.appendMessage(lessonId, 'teacher', text);
      await ctx.lessons.appendMessage(lessonId, 'lin', '学生回应');
      return { lessonId, messages: await ctx.lessons.readMessages(lessonId) };
    };

    const result = await request(ctx, `/api/lessons/${lesson.id}/turns`, {
      method: 'POST',
      body: { text: '讲解内容' },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.data.messages.map((message) => [message.speaker, message.name, message.text]),
      [
        ['teacher', '老师', '讲解内容'],
        ['lin', '林澈', '学生回应'],
      ],
    );
    assert.deepEqual(result.data.integrity, {
      status: 'ok',
      corruptLineCount: 0,
      corruptLineNumbers: [],
    });
  } finally {
    await cleanup(ctx);
  }
});

test('DELETE removes a history lesson and its transcript', async () => {
  const ctx = await createServer();
  try {
    const lesson = await ctx.lessons.startLesson();
    await ctx.lessons.appendMessage(lesson.id, 'teacher', '一条记录');
    await ctx.lessons.endLesson(lesson.id);
    const directory = join(
      process.env.TEACHFORGE_CONFIG_DIR,
      'lessons',
      lesson.id,
    );
    assert.equal(existsSync(directory), true);

    const deleted = await request(ctx, `/api/lessons/${lesson.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.data, { lessonId: lesson.id });
    assert.equal(existsSync(directory), false);

    const gone = await request(ctx, `/api/lessons/${lesson.id}`);
    assert.equal(gone.status, 404);
    const messages = await request(ctx, `/api/lessons/${lesson.id}/messages`);
    assert.equal(messages.status, 404);
  } finally {
    await cleanup(ctx);
  }
});

test('active and generating lessons cannot be deleted', async () => {
  const ctx = await createServer();
  try {
    const active = await ctx.lessons.startLesson();
    const activeDelete = await request(ctx, `/api/lessons/${active.id}`, {
      method: 'DELETE',
    });
    assert.equal(activeDelete.status, 409);
    assert.equal(await ctx.lessons.findLesson(active.id) !== null, true);

    await ctx.lessons.endLesson(active.id);
    const summaries = ctx.app.get(ClassroomSummariesService);
    summaries.isGenerating = () => true;
    const generatingDelete = await request(ctx, `/api/lessons/${active.id}`, {
      method: 'DELETE',
    });
    assert.equal(generatingDelete.status, 409);
    summaries.isGenerating = () => false;

    const missing = await request(ctx, `/api/lessons/${randomUUID()}`, {
      method: 'DELETE',
    });
    assert.equal(missing.status, 404);
    const malformed = await request(ctx, '/api/lessons/not-a-uuid', {
      method: 'DELETE',
    });
    assert.equal(malformed.status, 400);
  } finally {
    await cleanup(ctx);
  }
});

test('the route is protected by the local token and rejects browser origins', async () => {
  const ctx = await createServer();
  try {
    const lesson = await ctx.lessons.startLesson();
    const path = `/api/lessons/${lesson.id}/messages`;

    const unauthorized = await request(ctx, path, { token: false });
    assert.equal(unauthorized.status, 401);

    const fromBrowser = await request(ctx, path, { origin: 'http://localhost:5173' });
    assert.equal(fromBrowser.status, 403);
  } finally {
    await cleanup(ctx);
  }
});

/** Closes the server created for this test and forgets it for the global cleanup. */
async function cleanup(ctx) {
  await ctx.app.close();
  const index = createdApps.indexOf(ctx.app);
  if (index >= 0) createdApps.splice(index, 1);
}
