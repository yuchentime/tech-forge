const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// `dist` is the packaged build; `BACKEND_TEST_BUILD_DIR` lets the same suite run from `.test-dist`
// when a dev backend holds `dist` open on Windows.
const buildDirectory = path.resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? 'dist');
const { createWorkspaceFileTools } = require(
  path.join(buildDirectory, 'llm', 'tools', 'workspace-file-tools.js'),
);

const piSdkPromise = import('@earendil-works/pi-coding-agent');

/** Creates an isolated workspace and removes it after the test completes. */
async function createWorkspace(t) {
  // macOS exposes os.tmpdir() as /var while realpath is /private/var; resolve it so the
  // workspace boundary and the test's guarded filesystem see the same absolute path.
  const parent = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'teachforge-workspace-')),
  );
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, workspace };
}

/** Executes one SDK tool definition with the isolated workspace as its cwd. */
function executeTool(tool, input, cwd) {
  return tool.execute(
    'workspace-test-call',
    input,
    undefined,
    () => undefined,
    { cwd },
  );
}

test('writes at workspace root without mkdir and creates nested workspace folders', async (t) => {
  const { workspace } = await createWorkspace(t);
  let rootMkdirCalls = 0;
  const guardedFileSystem = {
    ...fs,
    async mkdir(directory, options) {
      if (path.resolve(directory) === path.resolve(workspace)) {
        rootMkdirCalls += 1;
        const error = new Error('simulated root mkdir denial');
        error.code = 'EPERM';
        throw error;
      }
      return fs.mkdir(directory, options);
    },
  };
  const sdk = await piSdkPromise;
  const tools = await createWorkspaceFileTools(sdk, workspace, guardedFileSystem);
  const writeTool = tools.find((tool) => tool.name === 'write');

  await executeTool(writeTool, { path: 'root.txt', content: 'root output' }, workspace);
  await executeTool(
    writeTool,
    { path: path.join('notes', 'nested.txt'), content: 'nested output' },
    workspace,
  );

  assert.equal(rootMkdirCalls, 0);
  assert.equal(await fs.readFile(path.join(workspace, 'root.txt'), 'utf8'), 'root output');
  assert.equal(
    await fs.readFile(path.join(workspace, 'notes', 'nested.txt'), 'utf8'),
    'nested output',
  );
});

test('reads external files but rejects ungranted external writes and edits', async (t) => {
  const { parent, workspace } = await createWorkspace(t);
  const outsideFile = path.join(parent, 'outside.txt');
  await fs.writeFile(outsideFile, 'original', 'utf8');
  const sdk = await piSdkPromise;
  const tools = await createWorkspaceFileTools(sdk, workspace);
  const readTool = tools.find((tool) => tool.name === 'read');
  const editTool = tools.find((tool) => tool.name === 'edit');
  const writeTool = tools.find((tool) => tool.name === 'write');

  await assert.rejects(
    executeTool(writeTool, { path: outsideFile, content: 'changed' }, workspace),
    (error) => error.code === 'EWORKSPACE' || error.message.includes('EWORKSPACE'),
  );
  await assert.rejects(
    executeTool(writeTool, { path: path.join('..', 'outside.txt'), content: 'changed' }, workspace),
    (error) => error.code === 'EWORKSPACE' || error.message.includes('EWORKSPACE'),
  );
  await executeTool(readTool, { path: outsideFile }, workspace);
  await assert.rejects(
    executeTool(
      editTool,
      { path: outsideFile, edits: [{ oldText: 'original', newText: 'changed' }] },
      workspace,
    ),
    (error) => error.code === 'EWORKSPACE' || error.message.includes('EWORKSPACE'),
  );

  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'original');
  assert.equal(existsSync(path.join(workspace, 'outside.txt')), false);
});

test('guards a directory by default but honours an explicit user request', async (t) => {
  const { parent, workspace } = await createWorkspace(t);
  const knowledge = path.join(parent, 'knowledge');
  await fs.mkdir(knowledge);
  const original = path.join(knowledge, 'origin.md');
  await fs.writeFile(original, 'uploaded original bytes');
  const sdk = await piSdkPromise;
  const guardedReports = [];

  // The model naming a path on its own is not permission: default deny.
  const guarded = await createWorkspaceFileTools(sdk, workspace, undefined, {
    guardedDirectories: [knowledge],
    onFileReadResolution: (report) => guardedReports.push(report),
  });
  const guardedRead = guarded.find((tool) => tool.name === 'read');
  await assert.rejects(executeTool(guardedRead, { path: original }, workspace));
  await assert.rejects(
    executeTool(guardedRead, { path: path.join('..', 'knowledge', 'origin.md') }, workspace),
  );
  assert.deepEqual(
    guardedReports.map(({ outcome, grantLiftedGuard, readGrantKind }) => ({
      outcome,
      grantLiftedGuard,
      readGrantKind,
    })),
    [
      { outcome: 'guarded_directory_denied', grantLiftedGuard: false, readGrantKind: 'none' },
    ],
  );

  // The user asking for that exact file in this turn lifts the default.
  const grantedReports = [];
  const granted = await createWorkspaceFileTools(sdk, workspace, undefined, {
    guardedDirectories: [knowledge],
    currentUserRequest: `请读一下 ${original}`,
    onFileReadResolution: (report) => grantedReports.push(report),
  });
  const grantedRead = granted.find((tool) => tool.name === 'read');
  const result = await executeTool(grantedRead, { path: original }, workspace);
  assert.match(JSON.stringify(result), /uploaded original bytes/);
  assert.deepEqual(grantedReports.map(({ outcome, grantLiftedGuard }) => ({
    outcome,
    grantLiftedGuard,
  })), [{ outcome: 'resolved', grantLiftedGuard: true }]);

  // A contradictory request ("don't read ...") must not grant anything.
  const negated = await createWorkspaceFileTools(sdk, workspace, undefined, {
    guardedDirectories: [knowledge],
    currentUserRequest: `不要读 ${original}`,
  });
  const negatedRead = negated.find((tool) => tool.name === 'read');
  await assert.rejects(executeTool(negatedRead, { path: original }, workspace));

  assert.equal(await fs.readFile(original, 'utf8'), 'uploaded original bytes');
});

test('reads the generated catalog inside a guarded directory but keeps its siblings denied', async (t) => {
  const { parent, workspace } = await createWorkspace(t);
  const knowledge = path.join(parent, 'knowledge');
  await fs.mkdir(knowledge);
  const catalog = path.join(knowledge, 'index.md');
  const original = path.join(knowledge, 'origin.md');
  const sibling = path.join(knowledge, 'other.md');
  await fs.writeFile(catalog, '## 资料目录\n\n（资料库当前为空，尚未导入任何资料。）');
  await fs.writeFile(original, 'uploaded original bytes');
  await fs.writeFile(sibling, 'sibling bytes');
  const sdk = await piSdkPromise;

  const tools = await createWorkspaceFileTools(sdk, workspace, undefined, {
    guardedDirectories: [knowledge],
    readableGuardedPaths: [catalog],
  });
  const readTool = tools.find((tool) => tool.name === 'read');

  const result = await executeTool(readTool, { path: catalog }, workspace);
  assert.match(JSON.stringify(result), /资料库当前为空/);
  await assert.rejects(executeTool(readTool, { path: original }, workspace));
  // The exemption names one file, so it never widens to the directory.
  await assert.rejects(executeTool(readTool, { path: sibling }, workspace));
});

/**
 * Minimal PNG: signature plus one IHDR chunk. Enough for the SDK's sniffing to report image/png,
 * and never opened by an image decoder because the read must answer in text.
 */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.alloc(13),
]);

test('never returns an image block: a read of a PNG answers with a note', async (t) => {
  const { workspace } = await createWorkspace(t);
  await fs.writeFile(path.join(workspace, 'shot.png'), PNG_BYTES);
  const sdk = await piSdkPromise;
  const tools = await createWorkspaceFileTools(sdk, workspace);
  const readTool = tools.find((tool) => tool.name === 'read');

  const result = await executeTool(readTool, { path: 'shot.png' }, workspace);

  assert.equal(result.content.some((block) => block.type === 'image'), false);
  assert.equal(result.content.length, 1);
  assert.match(result.content[0].text, /\[image not loaded: image\/png\./);
  assert.match(result.content[0].text, /Images are never read into the conversation/);
  // The file bytes must not leak into the result in any form.
  assert.equal(result.content[0].text.includes('iVBORw0KGgo'), false);
  assert.ok(result.content[0].text.length < 200);
});

test('keeps text reads on the normal path', async (t) => {
  const { workspace } = await createWorkspace(t);
  await fs.writeFile(path.join(workspace, 'map.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const sdk = await piSdkPromise;
  const tools = await createWorkspaceFileTools(sdk, workspace);
  const readTool = tools.find((tool) => tool.name === 'read');

  const result = await executeTool(readTool, { path: 'map.svg' }, workspace);

  assert.match(result.content[0].text, /<svg/);
});
