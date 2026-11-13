require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { appendFileSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));
const { buildDatabaseOptions } = load('database/database.options.js');
const { SettingsService } = load('settings/settings.service.js');
const { LessonsService } = load('lessons/lessons.service.js');
const { LessonEntity } = load('lessons/lesson.entity.js');
const {
  ClassroomSummariesAgent,
} = load('llm/agents/ClassroomSummariesAgent.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-summaries-'));
test.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** Builds the real persistence stack with a fake LLM, so no provider call is made. */
async function createHarness() {
  const root = mkdtempSync(join(scratchRoot, 'run-'));
  const configDirectory = join(root, 'config');
  mkdirSync(configDirectory, { recursive: true });
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = join(root, 'data');

  const dataSource = new DataSource({ ...buildDatabaseOptions(), synchronize: false });
  await dataSource.initialize();
  const settings = new SettingsService();
  const lessons = new LessonsService(
    dataSource.getRepository(LessonEntity),
    settings,
  );
  return { dataSource, lessons, settings };
}

/** Ends a lesson with two messages; returns its id. */
async function seedEndedLesson(lessons) {
  const lesson = await lessons.startLesson();
  await lessons.appendMessage(lesson.id, 'teacher', '今天我们讲缓存雪崩。');
  await lessons.appendMessage(lesson.id, 'lin', '老师，大量 key 同时过期会怎样？');
  await lessons.endLesson(lesson.id);
  return lesson.id;
}

test('generates, stores and previews a summary for an ended lesson', async () => {
  const { dataSource, lessons } = await createHarness();
  try {
    const lessonId = await seedEndedLesson(lessons);
    const fakeLlm = {
      generate: async (prompt) => {
        assert.match(prompt, /<speaker_name>林澈<\/speaker_name>/);
        assert.match(prompt, /<speaker_name>老师<\/speaker_name>/);
        return '## 本节讲了什么\n讲了缓存雪崩。\n\n## 学生关注点\n林澈问大量 key 同时过期。';
      },
    };
    const summaries = new ClassroomSummariesAgent(lessons, fakeLlm);

    const ready = await summaries.generate(lessonId);
    assert.equal(ready.summaryStatus, 'ready');
    assert.match(ready.summaryMarkdown, /## 本节讲了什么/);
    assert.ok(ready.summaryGeneratedAt);

    const stored = await lessons.findLesson(lessonId);
    assert.equal(stored.summaryStatus, 'ready');

    const listed = await lessons.listLessons({ status: 'ended', limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, lessonId);
  } finally {
    await dataSource.destroy();
  }
});

test('a failed provider call stores a retryable failure without throwing', async () => {
  const { dataSource, lessons } = await createHarness();
  try {
    const lessonId = await seedEndedLesson(lessons);
    const summaries = new ClassroomSummariesAgent(lessons, {
      generate: async () => {
        throw new Error('provider exploded with secret text');
      },
    });

    const failed = await summaries.generate(lessonId);
    assert.equal(failed.summaryStatus, 'failed');
    assert.equal(failed.summaryError, '总结生成失败，请重试。');
    assert.equal(failed.summaryMarkdown, null);
  } finally {
    await dataSource.destroy();
  }
});

test('a corrupt transcript fails the summary without calling the model', async () => {
  const { dataSource, lessons } = await createHarness();
  try {
    const lessonId = await seedEndedLesson(lessons);
    appendFileSync(
      join(process.env.TEACHFORGE_CONFIG_DIR, 'lessons', lessonId, 'messages.jsonl'),
      '{"broken":\n',
      'utf8',
    );
    let called = false;
    const summaries = new ClassroomSummariesAgent(lessons, {
      generate: async () => {
        called = true;
        return 'should not happen';
      },
    });

    const failed = await summaries.generate(lessonId);
    assert.equal(called, false);
    assert.equal(failed.summaryStatus, 'failed');
    assert.equal(failed.summaryError, '课堂记录损坏，无法生成总结。');
  } finally {
    await dataSource.destroy();
  }
});

test('a second generation while one is running is rejected', async () => {
  const { dataSource, lessons } = await createHarness();
  try {
    const lessonId = await seedEndedLesson(lessons);
    let release;
    const gate = new Promise((resolveGate) => {
      release = resolveGate;
    });
    const summaries = new ClassroomSummariesAgent(lessons, {
      generate: () => gate.then(() => '## 本节讲了什么\n缓存雪崩。'),
    });

    const running = summaries.generate(lessonId);
    await assert.rejects(() => summaries.generate(lessonId), /already generating/);
    release();
    const ready = await running;
    assert.equal(ready.summaryStatus, 'ready');
  } finally {
    await dataSource.destroy();
  }
});

test('interrupted generations are reset to failed on startup', async () => {
  const { dataSource, lessons } = await createHarness();
  try {
    const lessonId = await seedEndedLesson(lessons);
    await dataSource
      .getRepository(LessonEntity)
      .update({ id: lessonId }, { summaryStatus: 'generating' });

    const summaries = new ClassroomSummariesAgent(lessons, {
      generate: async () => '',
    });
    await summaries.onModuleInit();

    const stored = await lessons.findLesson(lessonId);
    assert.equal(stored.summaryStatus, 'failed');
    assert.equal(stored.summaryError, '生成被中断，请重试。');
  } finally {
    await dataSource.destroy();
  }
});
