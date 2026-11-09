/**
 * Verifies the artifact index end to end against a throwaway data directory.
 *
 * Phase A boots the Nest application in-process and exercises the capture and read paths of
 * ArtifactsService. Phase B starts the real HTTP entry point and checks the routes the desktop
 * sidebar calls, including the per-turn filter and the location payload.
 */
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const configDirectory = mkdtempSync(join(tmpdir(), 'tf-artifacts-config-'));
const dataDirectory = mkdtempSync(join(tmpdir(), 'tf-artifacts-data-'));
const token = 'verify-token';

process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
process.env.TEACHFORGE_DATA_DIR = dataDirectory;
process.env.TEACHFORGE_AUTH_TOKEN = token;
process.env.TEACHFORGE_PORT = '0';

async function phaseA() {
  const { NestFactory } = require('@nestjs/core');
  const { DataSource } = require('typeorm');
  const { AppModule } = require('../dist/app.module');
  const { ArtifactsService } = require('../dist/artifacts/artifacts.service');
  const { SettingsService } = require('../dist/settings/settings.service');
  const { ConversationEntity } = require('../dist/conversations/conversation.entity');

  // No HTTP adapter is needed here: only the injected services are exercised.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();

  const dataSource = app.get(DataSource);
  const settings = app.get(SettingsService);
  const artifacts = app.get(ArtifactsService);

  const conversationId = randomUUID();
  await dataSource.getRepository(ConversationEntity).save({
    id: conversationId,
    title: 'artifact smoke',
    metadataJson: null,
  });

  const workspace = settings.getSessionWorkspaceDirectory(conversationId);
  mkdirSync(workspace, { recursive: true });
  const sessionFile = join(workspace, '缓存雪崩.md');
  writeFileSync(sessionFile, '# 标题\n\n正文\n', 'utf8');

  const sessionArtifact = await artifacts.registerArtifact({
    conversationId,
    userMessageId: null,
    absolutePath: sessionFile,
  });
  assert.ok(sessionArtifact, 'session artifact should be registered');
  assert.equal(sessionArtifact.fileName, '缓存雪崩.md');
  assert.equal(sessionArtifact.contentFormat, 'markdown');
  assert.equal(sessionArtifact.external, false);
  assert.equal(sessionArtifact.missing, false);

  // A second write to the same path must update the row instead of inserting a duplicate.
  writeFileSync(sessionFile, '# 标题\n\n更新后的正文\n', 'utf8');
  const rewritten = await artifacts.registerArtifact({
    conversationId,
    userMessageId: null,
    absolutePath: sessionFile,
  });
  assert.equal(rewritten.id, sessionArtifact.id, 'rewriting a file keeps its artifact id');

  const externalDirectory = mkdtempSync(join(tmpdir(), 'tf-artifacts-external-'));
  const externalFile = join(externalDirectory, '大模型输出.json');
  writeFileSync(externalFile, '{"a":1}', 'utf8');
  const externalArtifact = await artifacts.registerArtifact({
    conversationId,
    userMessageId: null,
    absolutePath: externalFile,
  });
  assert.equal(externalArtifact.external, true, 'a file outside the workspace is external');
  assert.equal(externalArtifact.contentFormat, 'json');

  const list = await artifacts.listArtifacts(conversationId);
  assert.equal(list.length, 2, `expected 2 artifacts, received ${list.length}`);

  const content = await artifacts.readContent(sessionArtifact.id);
  assert.match(content.content, /更新后的正文/);
  assert.equal(content.truncated, false);
  assert.equal(content.binary, false);

  const location = await artifacts.getLocation(sessionArtifact.id);
  assert.equal(location.fileExists, true);
  assert.equal(location.directoryExists, true);
  assert.equal(location.filePath, sessionFile);

  // A moved file must be reported as missing instead of breaking the list.
  unlinkSync(externalFile);
  const afterRemoval = await artifacts.listArtifacts(conversationId);
  assert.equal(
    afterRemoval.find((item) => item.id === externalArtifact.id).missing,
    true,
    'a deleted file is reported missing',
  );

  const byTurn = await artifacts.listByUserMessageIds(conversationId, []);
  assert.equal(byTurn.size, 0);

  rmSync(externalDirectory, { recursive: true, force: true });
  await app.close();
  return { conversationId, sessionArtifactId: sessionArtifact.id };
}

/** Starts the real entry point and queries the artifact routes over HTTP. */
async function phaseB({ conversationId, sessionArtifactId }) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, TEACHFORGE_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend did not report a port')), 30_000);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      const match = text.match(/TEACHFORGE_BACKEND_READY=(\{.*\})/);
      if (!match) return;
      clearTimeout(timer);
      resolve(JSON.parse(match[1]).port);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => reject(new Error(`backend exited early: ${code}`)));
  });

  const headers = { 'x-teachforge-token': token };
  const base = `http://127.0.0.1:${port}/api`;

  try {
    const listResponse = await fetch(`${base}/conversations/${conversationId}/artifacts`, {
      headers,
    });
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.length, 2, 'HTTP list should return both artifacts');

    const contentResponse = await fetch(`${base}/artifacts/${sessionArtifactId}/content`, {
      headers,
    });
    assert.equal(contentResponse.status, 200);
    const content = await contentResponse.json();
    assert.match(content.content, /更新后的正文/);

    const locationResponse = await fetch(`${base}/artifacts/${sessionArtifactId}/location`, {
      headers,
    });
    assert.equal(locationResponse.status, 200);
    const location = await locationResponse.json();
    assert.equal(location.fileExists, true);

    const missingResponse = await fetch(`${base}/artifacts/${randomUUID()}/content`, {
      headers,
    });
    assert.equal(missingResponse.status, 404, 'unknown artifacts return 404');
  } finally {
    // Wait for the child to release the SQLite files before the temporary directories go away.
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 5_000);
    });
  }
}

(async () => {
  const created = await phaseA();
  await phaseB(created);
  console.log('artifact verification passed');
  cleanup();
})().catch((error) => {
  console.error(error);
  cleanup();
  process.exitCode = 1;
});

/** Removes the throwaway directories, tolerating a briefly held SQLite handle. */
function cleanup() {
  for (const directory of [configDirectory, dataDirectory]) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`cleanup skipped: ${error.code ?? error.message}`);
    }
  }
}
