/**
 * Stages the NestJS backend as a self-contained folder for the Windows installer:
 * `build/backend/{dist,assets,node_modules}`.
 *
 * electron-builder only collects dependencies of the app package, and this repository keeps every
 * backend dependency in the `@teachforge/backend` workspace. Copying the installed production
 * closure (`npm ls --parseable --omit=dev`) keeps exactly the versions that development ran with,
 * including the workspace-nested `apps/backend/node_modules/better-sqlite3`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stageDir = path.join(root, 'build', 'backend');
const files = { dist: 'dist', assets: 'assets', nodeModules: 'node_modules' };
const workspacePrefix = `${path.sep}node_modules${path.sep}`;

/** Runs `npm ls` and returns the absolute directories of the backend production closure. */
function listProductionPackages() {
  const command = 'npm ls --workspace @teachforge/backend --omit=dev --all --parseable --loglevel=error';
  const result = spawnSync(command, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`npm ls failed with code ${result.status}: ${result.stderr || result.error}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(workspacePrefix));
}

/**
 * Maps an installed package directory to its staged location. Root-hoisted packages keep their
 * `node_modules/...` path; packages nested under the backend workspace are flattened so the staged
 * backend resolves them from its own `node_modules`, mirroring what Node did in development.
 *
 * @returns The staged relative path, or `undefined` for workspace symlinks that must not be copied.
 */
function stagedPathFor(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (normalized.startsWith('node_modules/@teachforge/')) return undefined;
  if (normalized.startsWith('node_modules/')) return normalized;
  if (normalized.startsWith('apps/backend/node_modules/')) {
    return `node_modules/${normalized.slice('apps/backend/node_modules/'.length)}`;
  }
  if (normalized.startsWith('apps/desktop/node_modules/')) {
    return `node_modules/${normalized.slice('apps/desktop/node_modules/'.length)}`;
  }
  return undefined;
}

/** Accepts only native package targets that have a supported installer command. */
function parseTarget(args) {
  const [platform, arch, ...extra] = args;
  const targetKey = `${platform}-${arch}`;
  const supportedTargets = new Set(['win32-x64', 'darwin-arm64']);
  if (extra.length > 0 || !supportedTargets.has(targetKey)) {
    throw new Error(
      `Unsupported staging target ${targetKey}; expected one of: ${[...supportedTargets].join(', ')}`,
    );
  }
  return { platform, arch, key: targetKey };
}

/** Keeps only the selected platform's prebuilt files for backend native dependencies. */
function pruneOtherPlatforms(stage, target) {
  const sqlitePrebuilds = path.join(stage, files.nodeModules, 'better-sqlite3', 'prebuilds');
  const sqliteTarget = `${target.key}.node`;
  const sqliteTargetPath = path.join(sqlitePrebuilds, sqliteTarget);
  if (!existsSync(sqliteTargetPath)) {
    throw new Error(`Missing ${target.key} prebuild for better-sqlite3 at ${sqliteTargetPath}`);
  }
  for (const entry of readdirSync(sqlitePrebuilds)) {
    if (entry !== sqliteTarget) rmSync(path.join(sqlitePrebuilds, entry), { force: true });
  }

  const ortPlatforms = path.join(stage, files.nodeModules, 'onnxruntime-node', 'bin', 'napi-v6');
  const ortTarget = path.join(ortPlatforms, target.platform, target.arch);
  const ortBinding = path.join(ortTarget, 'onnxruntime_binding.node');
  if (!existsSync(ortBinding)) {
    throw new Error(`Missing ${target.key} ONNX Runtime binding at ${ortBinding}`);
  }
  for (const platform of readdirSync(ortPlatforms)) {
    const platformPath = path.join(ortPlatforms, platform);
    if (platform !== target.platform) {
      rmSync(platformPath, { recursive: true, force: true });
      continue;
    }
    for (const arch of readdirSync(platformPath)) {
      if (arch !== target.arch) rmSync(path.join(platformPath, arch), { recursive: true, force: true });
    }
  }
}

/** Copies backend output and the production dependencies for one supported native package target. */
function stageBackend(target) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  cpSync(path.join(root, 'apps', 'backend', files.dist), path.join(stageDir, files.dist), {
    recursive: true,
  });
  cpSync(path.join(root, 'apps', 'backend', files.assets), path.join(stageDir, files.assets), {
    recursive: true,
  });

  const packages = listProductionPackages()
    .map((absolute) => ({
      source: absolute,
      relative: path.relative(root, absolute),
    }))
    .map((entry) => ({ ...entry, target: stagedPathFor(entry.relative) }))
    .filter((entry) => entry.target !== undefined)
    .sort((left, right) => left.target.split('/').length - right.target.split('/').length);

  const sources = new Map();
  let copied = 0;
  for (const entry of packages) {
    const destination = path.join(stageDir, entry.target);
    const existing = sources.get(entry.target);
    if (existing !== undefined) {
      if (existing !== entry.source) {
        throw new Error(
          `Two installed packages map to ${entry.target}: ${existing} and ${entry.source}. ` +
            'Extend the staging layout instead of overwriting one of them.',
        );
      }
      continue;
    }
    sources.set(entry.target, entry.source);
    // A parent package copy already contains its nested `node_modules` subtree.
    if (existsSync(destination)) continue;
    cpSync(entry.source, destination, { recursive: true, verbatimSymlinks: true });
    copied += 1;
  }

  pruneOtherPlatforms(stageDir, target);

  const bytes = directorySize(stageDir);
  console.log(
    `[stage-backend] ${copied} packages staged at ${path.relative(root, stageDir)} ` +
      `(${(bytes / 1024 / 1024).toFixed(0)} MB)`,
  );
}

/** Recursively sums file sizes so the log reports how large the staged backend is. */
function directorySize(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else if (entry.isFile()) total += statSync(target).size;
  }
  return total;
}

stageBackend(parseTarget(process.argv.slice(2)));
