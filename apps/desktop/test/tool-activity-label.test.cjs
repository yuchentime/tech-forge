const assert = require('node:assert/strict');
const test = require('node:test');
const { describeToolActivity } = require('../dist-electron/src/features/agent/tool-activity-label.js');

test('grep shows the pattern and only the target file name', () => {
  assert.deepEqual(
    describeToolActivity('grep', 'completed', {
      pattern: '抄袭|剽窃',
      path: 'E:\\workspace\\学生手册.docx',
      context: 3,
      limit: 20,
    }),
    { action: '已搜索', pattern: '抄袭|剽窃', fileName: '学生手册.docx' },
  );
});

test('read, write and edit use plain-language actions with the file name', () => {
  assert.deepEqual(describeToolActivity('read', 'running', { path: '/workspace/资料/通知.pdf' }), {
    action: '正在读取',
    fileName: '通知.pdf',
  });
  assert.deepEqual(describeToolActivity('write', 'completed', { path: 'b/课程大纲.md' }), {
    action: '已写入',
    fileName: '课程大纲.md',
  });
  assert.deepEqual(describeToolActivity('edit', 'failed', { path: 'C:\\x\\y\\笔记.txt' }), {
    action: '编辑失败',
    fileName: '笔记.txt',
  });
});

test('read shows the requested window so repeated reads stay distinguishable', () => {
  assert.deepEqual(
    describeToolActivity('read', 'completed', {
      path: 'C:/knowledge/guide.md',
      offset: 1486,
      limit: 180,
    }),
    { action: '已读取', fileName: 'guide.md', lineRange: '第 1486–1665 行' },
  );
  assert.deepEqual(describeToolActivity('read', 'completed', { path: 'guide.md', limit: 120 }), {
    action: '已读取',
    fileName: 'guide.md',
    lineRange: '第 1–120 行',
  });
  assert.deepEqual(describeToolActivity('read', 'completed', { path: 'guide.md', offset: 121 }), {
    action: '已读取',
    fileName: 'guide.md',
    lineRange: '第 121 行起',
  });
  assert.deepEqual(
    describeToolActivity('read', 'completed', { path: 'guide.md', offset: 7, limit: 1 }),
    { action: '已读取', fileName: 'guide.md', lineRange: '第 7 行' },
  );
});

test('only a valid read window reaches the label', () => {
  // grep 的 offset/limit 语义不同，不能显示成行范围。
  assert.deepEqual(
    describeToolActivity('grep', 'completed', { pattern: 'x', path: 'a.md', offset: 1, limit: 20 }),
    { action: '已搜索', pattern: 'x', fileName: 'a.md' },
  );
  assert.deepEqual(
    describeToolActivity('read', 'completed', { path: 'a.md', offset: '3', limit: 0 }),
    { action: '已读取', fileName: 'a.md' },
  );
  assert.deepEqual(
    describeToolActivity('read', 'completed', { path: 'a.md', offset: -5, limit: 10 }),
    { action: '已读取', fileName: 'a.md', lineRange: '第 1–10 行' },
  );
});

test('directories, globs and unrelated arguments never reach the label', () => {
  const description = describeToolActivity('grep', 'running', {
    pattern: 'aaa',
    path: '.',
    glob: '**/*.md',
  });

  assert.deepEqual(description, { action: '正在搜索', pattern: 'aaa' });
  const serialized = JSON.stringify(description);
  assert.equal(serialized.includes('grep'), false);
  assert.equal(serialized.includes('*.md'), false);
});

test('unknown tools and cancelled calls still get user-facing wording', () => {
  assert.deepEqual(describeToolActivity('search_documents', 'cancelled', { query: 'x' }), {
    action: '已取消',
  });
  assert.deepEqual(describeToolActivity('bash', 'failed', null), { action: '处理失败' });
});


test('memory tools use plain-language actions instead of raw names', () => {
  assert.deepEqual(describeToolActivity('memory_write', 'running', { content: '用户喜欢先给结论。' }), {
    action: '正在记录记忆',
  });
  assert.deepEqual(describeToolActivity('memory_search', 'completed', { query: '讲题偏好' }), {
    action: '已搜索记忆',
  });
  assert.deepEqual(describeToolActivity('memory_list', 'failed', {}), {
    action: '读取记忆失败',
  });
});

test('web tools show the query or URL instead of raw names', () => {
  assert.deepEqual(describeToolActivity('web_search', 'running', { query: '光合作用 实验' }), {
    action: '正在搜索网页',
    pattern: '光合作用 实验',
  });
  assert.deepEqual(describeToolActivity('web_fetch', 'completed', {
    url: 'https://example.com/article',
  }), {
    action: '已抓取网页',
    pattern: 'https://example.com/article',
  });
  assert.deepEqual(describeToolActivity('web_search', 'failed', { query: 'x' }), {
    action: '搜索网页失败',
    pattern: 'x',
  });
});

test('long web URLs are clipped before reaching the activity row', () => {
  const url = `https://example.com/${'a'.repeat(200)}`;
  const description = describeToolActivity('web_fetch', 'running', { url });
  assert.equal(Array.from(description.pattern).length, 120);
  assert.ok(description.pattern.endsWith('…'));
});
