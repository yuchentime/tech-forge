const assert = require('node:assert/strict');
const test = require('node:test');
const { join } = require('node:path');

const buildDirectory = join(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const {
  WEB_TOOL_NAMES,
  areWebToolsEnabled,
  createWebTools,
} = require(join(buildDirectory, 'llm/tools/web-tools.js'));

/** Creates a JSON response with the headers the tool expects. */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Keeps the test output focused on assertions. */
const silentLogger = { log() {}, warn() {}, error() {}, debug() {} };

/** Builds the tools with a fake transport and a deterministic test key. */
function createTools(fetchImpl, options = {}) {
  return createWebTools({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    requestId: 'req-web-1',
    originalQuestion: '光合作用为什么需要光',
    logger: silentLogger,
    fetchImpl,
    ...options,
  });
}

/** Finds one registered tool by name. */
function getTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test('registers exactly the two documented tools with object schemas', () => {
  const tools = createTools(async () => jsonResponse({}));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...WEB_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(typeof tool.label, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
  }
});

test('web_search posts the documented body and formats model-facing results', async () => {
  let captured;
  const tool = getTool(
    createTools(async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        results: [
          {
            title: '光合作用入门',
            url: 'https://example.com/photosynthesis',
            snippet: '短摘要',
            summary: '长摘要：光合作用把光能转化为化学能。',
            content: '网页正文',
            site_name: 'Example 生物',
            site_icon: 'https://example.com/favicon.ico',
            date: '2026-06-01T00:00:00+00:00',
            authority: 3,
            rerank_score: 2.4,
          },
        ],
      });
    }),
    'web_search',
  );

  const result = await tool.execute(
    'call-1',
    { query: '光合作用', count: 3, include_content: true },
    new AbortController().signal,
  );

  assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(captured.init.body), {
    query: '光合作用',
    count: 3,
    need_content: true,
    ori_question: '光合作用为什么需要光',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, { tool: 'web_search', count: 1, truncated: false });
  const text = result.content[0].text;
  assert.match(text, /1\. 光合作用入门/u);
  assert.match(text, /URL: https:\/\/example\.com\/photosynthesis/u);
  assert.match(text, /Example 生物/u);
  assert.match(text, /2026-06-01/u);
  assert.match(text, /权威性 3/u);
  assert.match(text, /长摘要/u);
  assert.match(text, /正文摘录: 网页正文/u);
  assert.equal(text.includes('favicon'), false);
  assert.equal(text.includes('2.4'), false);
});

test('web_search default count is 5 and content stays off unless requested', async () => {
  let body;
  let text;
  const tool = getTool(
    createTools(async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({
        results: [
          {
            title: 'A',
            url: 'https://a.example',
            snippet: '回退摘要',
            summary: '',
            content: '不应出现的正文',
          },
        ],
      });
    }),
    'web_search',
  );

  const result = await tool.execute('call-2', { query: '光合作用' });
  text = result.content[0].text;
  assert.equal(body.count, 5);
  assert.equal(body.need_content, false);
  assert.match(text, /回退摘要/u);
  assert.equal(text.includes('不应出现的正文'), false);
  assert.equal(text.includes('正文摘录'), false);
});

test('web_search truncates ori_question to 128 Unicode characters', async () => {
  let body;
  const tool = getTool(
    createTools(
      async (_url, init) => {
        body = JSON.parse(init.body);
        return jsonResponse({ results: [] });
      },
      { originalQuestion: '问'.repeat(300) },
    ),
    'web_search',
  );

  await tool.execute('call-3', { query: 'x' });
  assert.equal([...body.ori_question].length, 128);
});

test('web_search omits ori_question when there is no current user text', async () => {
  let body;
  const tool = getTool(
    createTools(
      async (_url, init) => {
        body = JSON.parse(init.body);
        return jsonResponse({ results: [] });
      },
      { originalQuestion: undefined },
    ),
    'web_search',
  );

  await tool.execute('call-4', { query: 'x' });
  assert.equal('ori_question' in body, false);
});

test('empty search results are a normal answer, not a tool error', async () => {
  const tool = getTool(createTools(async () => jsonResponse({ results: [] })), 'web_search');
  const result = await tool.execute('call-5', { query: '不存在的主题' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, { tool: 'web_search', count: 0, truncated: false });
  assert.match(result.content[0].text, /未找到/u);
});

test('search output is capped and reports truncation', async () => {
  const results = Array.from({ length: 30 }, (_, index) => ({
    title: `结果 ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    summary: '长'.repeat(1000),
  }));
  const tool = getTool(createTools(async () => jsonResponse({ results })), 'web_search');
  const result = await tool.execute('call-6', { query: '长结果' });
  assert.equal(result.details.truncated, true);
  assert.ok(result.content[0].text.length <= 12_200);
  assert.match(result.content[0].text, /结果已截断/u);
});

test('web_fetch posts the URL and returns the Markdown page', async () => {
  let captured;
  const tool = getTool(
    createTools(async (url, init) => {
      captured = { url, init };
      return jsonResponse({ title: '文章', content: '# 正文\n\n页面内容。' });
    }),
    'web_fetch',
  );

  const result = await tool.execute('call-7', { url: 'https://example.com/article' });
  assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.deepEqual(JSON.parse(captured.init.body), { url: 'https://example.com/article' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^# 文章/u);
  assert.match(result.content[0].text, /来源: https:\/\/example\.com\/article/u);
  assert.match(result.content[0].text, /# 正文/u);
});

test('web_fetch rejects non-http URLs before calling the API', async () => {
  let called = false;
  const tool = getTool(
    createTools(async () => {
      called = true;
      return jsonResponse({});
    }),
    'web_fetch',
  );

  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:pass@example.com/page',
    'not-a-url',
  ]) {
    const result = await tool.execute('call-8', { url });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /http\/https/u);
  }
  assert.equal(called, false);
});

test('web_fetch treats an empty body as a failure', async () => {
  const tool = getTool(
    createTools(async () => jsonResponse({ title: '空页面', content: '   ' })),
    'web_fetch',
  );
  const result = await tool.execute('call-9', { url: 'https://example.com/empty' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /没有可提取/u);
});

test('HTTP errors map to model-facing messages with the documented retry policy', async () => {
  const cases = [
    { status: 400, retries: 0, pattern: /参数/u },
    { status: 401, retries: 0, pattern: /API Key/u },
    { status: 402, retries: 0, pattern: /余额/u },
    { status: 403, retries: 0, pattern: /安全策略/u },
    { status: 404, retries: 0, pattern: /网页内容/u },
    { status: 428, retries: 0, pattern: /HTTP 428/u },
    { status: 429, retries: 1, pattern: /频繁/u },
    { status: 500, retries: 1, pattern: /内部错误/u },
    { status: 504, retries: 1, pattern: /超时/u },
  ];

  for (const testCase of cases) {
    let calls = 0;
    const tool = getTool(
      createTools(async () => {
        calls += 1;
        return jsonResponse({ error: { message: 'ignored' } }, testCase.status, {
          'retry-after': '0',
        });
      }),
      'web_search',
    );
    const result = await tool.execute('call-10', { query: 'x' });
    assert.equal(result.isError, true, `status ${testCase.status}`);
    assert.match(result.content[0].text, testCase.pattern, `status ${testCase.status}`);
    assert.equal(calls, testCase.retries + 1, `status ${testCase.status}`);
  }
});

test('transient failures retry once and can succeed', async () => {
  let calls = 0;
  const tool = getTool(
    createTools(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({}, 500)
        : jsonResponse({ results: [{ title: 'A', url: 'https://a.example' }] });
    }),
    'web_search',
  );

  const result = await tool.execute('call-11', { query: 'x' });
  assert.equal(calls, 2);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /A/u);
});

test('caller cancellation aborts the request instead of becoming a tool error', async () => {
  const controller = new AbortController();
  const tool = getTool(
    createTools(async (_url, init) => {
      if (init.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }),
    'web_search',
  );

  const pending = tool.execute('call-12', { query: 'x' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
});

test('a request timeout is a retryable tool error', async () => {
  const tool = getTool(
    createTools(
      async (_url, init) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          init.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
        return jsonResponse({ results: [] });
      },
      { timeouts: { searchMs: 10 } },
    ),
    'web_search',
  );

  const result = await tool.execute('call-13', { query: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /超时/u);
});

test('structured logs correlate the call without recording query text or URLs', async () => {
  const events = [];
  const logger = {
    log: (message) => events.push(JSON.parse(message)),
    warn: (message) => events.push(JSON.parse(message)),
    error: (message) => events.push(JSON.parse(message)),
    debug: (message) => events.push(JSON.parse(message)),
  };
  const tool = getTool(
    createTools(
      async () =>
        jsonResponse({
          results: [{ title: 'A', url: 'https://secret.example/page', summary: '内容' }],
        }),
      { logger },
    ),
    'web_search',
  );

  await tool.execute('call-14', { query: '私密查询词' });
  const completed = events.find((event) => event.event === 'llm.web_tool.completed');
  assert.ok(completed);
  assert.equal(completed.requestId, 'req-web-1');
  assert.equal(completed.toolName, 'web_search');
  assert.equal(completed.resultCount, 1);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('私密查询词'), false);
  assert.equal(serialized.includes('secret.example'), false);
});

test('web tools are enabled whenever a key is configured and not explicitly disabled', () => {
  const configured = { apiKey: 'key' };
  assert.equal(areWebToolsEnabled(configured), true);
  assert.equal(areWebToolsEnabled({ apiKey: '   ' }), false);
  assert.equal(areWebToolsEnabled(configured, { enabled: false }), false);
});
