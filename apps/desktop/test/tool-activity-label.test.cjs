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
