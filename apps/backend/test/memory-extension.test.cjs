const assert = require('node:assert/strict');
const test = require('node:test');
const { join } = require('node:path');

const buildDirectory = join(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const {
  createMemoryToolsExtension,
  MEMORY_TOOL_NAMES,
} = require(join(buildDirectory, 'memory/memory-extension.js'));

/** Captures the tool definitions one Pi extension registers. */
function createFakePi() {
  const tools = [];
  return {
    tools,
    pi: {
      registerTool(tool) {
        tools.push(tool);
      },
    },
  };
}

/** Minimal service double with deterministic results. */
function createService(overrides = {}) {
  return {
    write: async () => ({ status: 'saved', id: 'm1' }),
    search: async () => [
      {
        id: 'm1',
        content: '用户偏好：先给结论。',
        tags: [],
        createdAt: '2026-11-11T00:00:00.000Z',
        score: 0.9,
      },
    ],
    list: async () => [
      { id: 'm1', content: '用户偏好：先给结论。', tags: [], createdAt: '2026-11-11T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

test('extension registers the three memory tools with object schemas', () => {
  const { tools, pi } = createFakePi();
  createMemoryToolsExtension(createService())(pi);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...MEMORY_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.label, 'string');
  }
});

test('write returns the saved status and a Pi tool result shape', async () => {
  const { tools, pi } = createFakePi();
  createMemoryToolsExtension(createService())(pi);
  const write = tools.find((tool) => tool.name === 'memory_write');
  const result = await write.execute('call-1', { content: '用户喜欢先给结论。' });
  assert.deepEqual(result.details, { status: 'saved' });
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /"saved"/u);
});

test('search and list project records with scores and caps', async () => {
  const { tools, pi } = createFakePi();
  createMemoryToolsExtension(createService())(pi);
  const search = tools.find((tool) => tool.name === 'memory_search');
  const searchResult = await search.execute('call-2', { query: '讲题偏好', limit: 3 });
  assert.equal(searchResult.details.count, 1);
  assert.equal(JSON.parse(searchResult.content[0].text)[0].score, 0.9);

  const list = tools.find((tool) => tool.name === 'memory_list');
  const listResult = await list.execute('call-3', {});
  assert.equal(listResult.details.count, 1);
});

test('service failures map to model-facing text instead of throwing', async () => {
  const { MemoryRejectedError, MemoryUnavailableError } = require(
    join(buildDirectory, 'memory/memory.service.js'),
  );
  const rejected = createFakePi();
  createMemoryToolsExtension(
    createService({
      write: async () => {
        throw new MemoryRejectedError('这类内容不写入长期记忆。');
      },
    }),
  )(rejected.pi);
  const write = rejected.tools.find((tool) => tool.name === 'memory_write');
  const rejectedResult = await write.execute('call-4', { content: '学生正确率 60%' });
  assert.match(rejectedResult.content[0].text, /未写入/u);

  const unavailable = createFakePi();
  createMemoryToolsExtension(
    createService({
      search: async () => {
        throw new MemoryUnavailableError();
      },
    }),
  )(unavailable.pi);
  const search = unavailable.tools.find((tool) => tool.name === 'memory_search');
  const unavailableResult = await search.execute('call-5', { query: '偏好' });
  assert.match(unavailableResult.content[0].text, /暂不可用/u);
});
