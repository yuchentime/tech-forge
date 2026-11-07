const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspaceFileTools } = require('../dist/llm/tools/workspace-file-tools.js');

const piSdkPromise = import('@earendil-works/pi-coding-agent');

/** Creates an isolated workspace and removes it after the test completes. */
async function createWorkspace(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'teachforge-workspace-'));
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

test('rejects absolute and traversal paths outside the workspace for each file tool', async (t) => {
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
  await assert.rejects(
    executeTool(readTool, { path: outsideFile }, workspace),
    (error) => error.code === 'EWORKSPACE' || error.message.includes('EWORKSPACE'),
  );
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
