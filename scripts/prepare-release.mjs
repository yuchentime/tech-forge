/**
 * Clears the previous electron-builder output before a packaging run and names the process that
 * holds it when Windows refuses.
 *
 * electron-builder deletes `release/win-unpacked` at the very end of `package:win`, after the full
 * Nest/tsc/Vite build and the ~650 MB backend staging. When an editor extension previewed
 * `resources/app.asar`, or a packaged `TeachForge.exe` is still running, that delete fails with a
 * bare `EBUSY: resource busy or locked, unlink ...\release\win-unpacked\resources\app.asar` and the
 * whole run is lost. Removing the same directory up front turns that into a one-second failure with
 * the owning process listed, and leaves nothing for electron-builder to delete afterwards.
 *
 * The tree is removed bottom-up instead of through `fs.rmSync(..., { recursive: true })`: the
 * recursive variant reports the directory (which the Restart Manager cannot resolve) and its retry
 * loop keeps a busy directory for tens of seconds.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(root, 'release');
/** electron-builder's unpacked app plus the temp copy it keeps while copying the Electron dist. */
const staleDirs = ['win-unpacked.tmp', 'win-unpacked'].map((name) => path.join(releaseDir, name));
const lockReportScript = path.join(import.meta.dirname, 'release-lock-report.ps1');
const busyCodes = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** Indexer and antivirus handles clear within a few hundred milliseconds; anything longer is a user. */
const retryDelaysMs = [0, 200, 500];

/**
 * Asks the Restart Manager which processes hold `target` open.
 * Returns `[{ pid, image, app }]`; an empty list means Windows reports no owning process.
 */
function findLockers(target) {
  if (process.platform !== 'win32') return [];
  const output = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lockReportScript, target],
    { encoding: 'utf8', windowsHide: true },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\|/.test(line))
    .map((line) => {
      const [pid, image, app] = line.split('|');
      return { pid, image, app };
    });
}

/**
 * Deletes `directory` bottom-up, appending every entry Windows refused to remove to `blocked` so
 * the caller can report the exact file rather than the containing directory.
 */
function removeTree(directory, blocked) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeTree(target, blocked);
      continue;
    }
    try {
      unlinkSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') blocked.push({ target, code: error.code });
    }
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') blocked.push({ target: directory, code: error.code });
  }
}

/**
 * Throws the operator-facing failure for a path that cannot be removed, resolving the owning
 * process first. The thrown error already carries the locked path, so the CLI exits with 1 and a
 * message instead of a stack trace.
 */
function busyReleaseError(directory, blocked) {
  const lock = blocked.find((entry) => busyCodes.has(entry.code)) ?? blocked[0];
  const lines = [
    `cannot remove ${path.relative(root, directory)}: ${lock.code} on ${lock.target}`,
  ];
  let lockers = [];
  try {
    lockers = findLockers(lock.target);
  } catch (reportError) {
    lines.push(`lock lookup failed: ${reportError.message.split('\n')[0]}`);
  }
  if (lockers.length === 0) {
    lines.push(
      'no owning process reported; an antivirus scan or a permission problem is the remaining cause',
    );
  } else {
    lines.push('held open by:');
    for (const { pid, image, app } of lockers) {
      lines.push(`  pid ${pid}  ${app && app !== image ? `${image} (${app})` : image}`);
    }
  }
  lines.push(
    'close the holder and run `npm run package:win` again:',
    '  - a TeachForge.exe started from release/win-unpacked',
    '  - an editor that previewed or indexed the packaged output (in VS Code: "Developer: Reload Window")',
  );
  const error = new Error(lines.join('\n'));
  error.name = 'BusyReleaseDirectory';
  return error;
}

/** Removes one stale output directory, retrying only the transient share violations. */
async function removeStaleDir(directory) {
  if (!existsSync(directory)) return;
  let blocked = [];
  for (const delay of retryDelaysMs) {
    if (delay > 0) await sleep(delay);
    blocked = [];
    removeTree(directory, blocked);
    if (blocked.length === 0) {
      console.log(`[prepare-release] removed ${path.relative(root, directory)}`);
      return;
    }
  }
  throw busyReleaseError(directory, blocked);
}

for (const directory of staleDirs) {
  try {
    await removeStaleDir(directory);
  } catch (error) {
    if (error.name !== 'BusyReleaseDirectory') throw error;
    console.error(`[prepare-release] ${error.message}`);
    process.exit(1);
  }
}
