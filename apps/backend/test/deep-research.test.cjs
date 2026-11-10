require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

/** Isolated build output, matching the other `.test-dist` suites. */
const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));

const {
  DEEP_RESEARCH_COMMAND,
  DEEP_RESEARCH_SKILL_NAME,
  parseDeepResearchCommand,
} = load('chat/deep-research-command.js');
const { parseTurnCommand } = load('chat/turn-command.js');
const { installBundledSkills } = load('llm/skills.js');

test('the deep-research command is a leading-token switch', () => {
  assert.equal(DEEP_RESEARCH_COMMAND, '/探索主题');
  assert.equal(DEEP_RESEARCH_SKILL_NAME, 'deep-research');

  assert.deepEqual(parseDeepResearchCommand('/探索主题 光合作用'), {
    force: true,
    prompt: '光合作用',
  });
  assert.deepEqual(parseDeepResearchCommand('  /探索主题\n光合作用'), {
    force: true,
    prompt: '光合作用',
  });

  // A bare command and a look-alike token stay literal; only real text after the command starts a
  // long research run.
  assert.deepEqual(parseDeepResearchCommand('/探索主题'), {
    force: false,
    prompt: '/探索主题',
  });
  assert.deepEqual(parseDeepResearchCommand('/探索主题   '), {
    force: false,
    prompt: '/探索主题   ',
  });
  assert.deepEqual(parseDeepResearchCommand('/探索主题化 光合作用'), {
    force: false,
    prompt: '/探索主题化 光合作用',
  });
  assert.deepEqual(parseDeepResearchCommand('请探索主题光合作用'), {
    force: false,
    prompt: '请探索主题光合作用',
  });
});

test('knowledge and research commands compose in either order', () => {
  const expected = {
    research: true,
    knowledge: true,
    prompt: '光合作用',
  };
  assert.deepEqual(parseTurnCommand('/探索主题 /查询资料库 光合作用'), expected);
  assert.deepEqual(parseTurnCommand('/查询资料库 /探索主题 光合作用'), expected);

  assert.deepEqual(parseTurnCommand('/探索主题 光合作用'), {
    research: true,
    knowledge: false,
    prompt: '光合作用',
  });
  assert.deepEqual(parseTurnCommand('/查询资料库 光合作用'), {
    research: false,
    knowledge: true,
    prompt: '光合作用',
  });
  assert.deepEqual(parseTurnCommand('光合作用'), {
    research: false,
    knowledge: false,
    prompt: '光合作用',
  });

  // A bare command is not a switch, and must not be removed from the text.
  assert.deepEqual(parseTurnCommand('/探索主题'), {
    research: false,
    knowledge: false,
    prompt: '/探索主题',
  });
});

test('the bundled deep-research skill installs into the config skills root and is discoverable', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'teachforge-skill-'));
  try {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const bundledSkills = resolve(__dirname, '..', 'assets', 'skills');
    const installedSkills = join(scratch, 'skills');
    installBundledSkills(bundledSkills, installedSkills);

    const installedFile = join(installedSkills, 'deep-research', 'SKILL.md');
    assert.match(readFileSync(installedFile, 'utf8'), /name: deep-research/);

    // Installation must not overwrite an existing user copy.
    const marker = join(installedSkills, 'deep-research', 'user-edit.txt');
    writeFileSync(marker, 'keep me', 'utf8');
    installBundledSkills(bundledSkills, installedSkills);
    assert.equal(readFileSync(marker, 'utf8'), 'keep me');

    const loader = new sdk.DefaultResourceLoader({
      cwd: scratch,
      agentDir: join(scratch, 'agent'),
      noSkills: true,
      additionalSkillPaths: [installedSkills],
    });
    await loader.reload();

    const skill = loader
      .getSkills()
      .skills.find((candidate) => candidate.name === DEEP_RESEARCH_SKILL_NAME);
    assert.ok(skill, 'deep-research must be loaded from <configDir>/skills');
    assert.match(skill.description, /探索主题|knowledge/i);
    assert.equal(
      skill.baseDir,
      join(installedSkills, 'deep-research'),
      'the skill must resolve its own installed directory for relative references',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
