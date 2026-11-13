#!/usr/bin/env node
/**
 * Packages the static marketing site (`apps/website`) and installs it on the remote web root over
 * SSH.
 *
 * Why a tarball instead of one `scp` per file: the live directory must never be half-written. The
 * archive is uploaded to `/tmp`, checksum-verified, extracted into a staging directory, and only
 * then copied over the web root. Anything else living in the web root — `downloads/`, `latest.json`
 * — is preserved: the script only adds/overwrites files, it never deletes the target.
 *
 * Auth: the system OpenSSH client is used, so key or interactive password both work. Without a key
 * an interactive run asks twice (one `scp`, one `ssh`); install a key (`ssh-copy-id root@host`) for
 * one-prompt-free deploys.
 *
 * Usage:
 *   node scripts/deploy-website.mjs --dry-run
 *   node scripts/deploy-website.mjs
 *   node scripts/deploy-website.mjs --user root --dir /www/wwwroot/techforge --key ~/.ssh/id_ed25519
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const siteDir = path.join(root, 'apps', 'website');
/** Remote-side scratch/deploy bookkeeping lives outside the web root so nginx can never serve it. */
const remoteStateDir = '/www/wwwroot/.teachforge-deploy';
const releaseKeep = 5;

/**
 * Parses `--flag value` / `--flag=value` pairs. Anything unknown aborts: a typo silently ignored
 * would otherwise deploy to the default host instead of the one the operator meant.
 */
function parseArgs(argv) {
  const options = {
    host: '121.43.54.210',
    user: 'root',
    port: 22,
    dir: '/www/wwwroot/techforge',
    key: '',
    dryRun: false,
    checkUrl: '',
  };
  const valued = new Map([
    ['--host', 'host'],
    ['--user', 'user'],
    ['--port', 'port'],
    ['--dir', 'dir'],
    ['--key', 'key'],
    ['--check-url', 'checkUrl'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node scripts/deploy-website.mjs [options]',
          '',
          '  --host <ip>        SSH host           (default 121.43.54.210)',
          '  --user <name>      SSH user           (default root)',
          '  --port <n>         SSH port           (default 22)',
          '  --dir <path>       remote web root    (default /www/wwwroot/techforge)',
          '  --key <path>       private key file   (default: ssh agent / default identity)',
          '  --check-url <url>  HTTP check after deploy (default http://<host>/)',
          '  --dry-run          package locally, print the remote plan, no network',
          '',
          'The web root keeps files the site does not ship (downloads/, latest.json).',
          'Server-side archive history: ' + remoteStateDir + '/releases (last ' + releaseKeep + ').',
        ].join('\n'),
      );
      process.exit(0);
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [flag, inlineValue] = arg.split(/=(.*)/s);
    const field = valued.get(flag);
    if (!field) throw new Error('unknown argument: ' + arg);
    const value = inlineValue ?? argv[(i += 1)];
    if (value === undefined) throw new Error('missing value for ' + flag);
    options[field] = field === 'port' ? Number(value) : value;
  }
  // Remote paths are interpolated into a shell command, so only unquoted-safe characters pass.
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(options.dir)) {
    throw new Error('--dir must be an absolute path without shell metacharacters: ' + options.dir);
  }
  if (!/^[A-Za-z0-9.:_-]+$/.test(options.host)) throw new Error('invalid --host: ' + options.host);
  if (!/^[A-Za-z0-9._-]+$/.test(options.user)) throw new Error('invalid --user: ' + options.user);
  return options;
}

/** Recursively lists files under `directory` as paths relative to it, using forward slashes. */
function listFiles(directory, base = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolute, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, absolute).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

/**
 * Decides which site files belong in the archive.
 *
 * The directory also keeps full-resolution screenshots (`assets/*.png`, ~9 MB) that the HTML never
 * references — only the resized `.webp` derivatives are shipped. Rather than hardcode names, every
 * `assets/...` URL found in the HTML/CSS is resolved, and asset files that no page references are
 * dropped. A referenced-but-missing asset is a hard error: that is a broken page.
 */
function collectSiteFiles() {
  if (!existsSync(path.join(siteDir, 'index.html'))) {
    throw new Error('missing ' + path.join(siteDir, 'index.html'));
  }
  const all = listFiles(siteDir);
  const textFiles = all.filter((file) => /\.(html|css|js)$/i.test(file));
  const referenced = new Set();
  for (const file of textFiles) {
    const text = readFileSync(path.join(siteDir, file), 'utf8');
    for (const match of text.matchAll(/assets\/[^\s"'`<>()]+/g)) {
      referenced.add(match[0].replace(/[?#].*$/, ''));
    }
  }
  const missing = [...referenced].filter((asset) => !all.includes(asset));
  if (missing.length > 0) throw new Error('referenced assets missing: ' + missing.join(', '));

  const packaged = all.filter((file) => {
    if (file.toLowerCase().endsWith('.md')) return false; // repo docs, not published pages
    if (file.startsWith('assets/')) return referenced.has(file);
    return true;
  });
  return { packaged, skipped: all.filter((file) => !packaged.includes(file)) };
}

/** Copies the packaged files into `staging`, preserving their relative layout. */
function stageSite(files, staging) {
  for (const file of files) {
    const target = path.join(staging, ...file.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(siteDir, ...file.split('/')), target);
  }
}

/** SHA-256 of a file as lowercase hex. */
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Builds the remote install script. Everything is interpolated as a validated literal, and the
 * script is passed as one `ssh` argument (not through stdin), so the archive upload and the install
 * stay two independent steps.
 *
 * @param {object} params
 * @param {string} params.dir        absolute remote web root
 * @param {string} params.archive    remote path of the uploaded tarball
 * @param {string} params.sha256     expected archive checksum
 * @param {string} params.releaseDir remote archive history directory
 */
function buildRemoteScript({ dir, archive, sha256, releaseDir }) {
  return [
    'set -eu',
    `dir="${dir}"`,
    `archive="${archive}"`,
    `expected="${sha256}"`,
    `release_dir="${releaseDir}"`,
    'actual=$(sha256sum "$archive" | cut -d" " -f1)',
    'if [ "$actual" != "$expected" ]; then',
    '  echo "upload corrupt: $actual != $expected" >&2',
    '  exit 1',
    'fi',
    `mkdir -p "$dir" "$release_dir"`,
    // Release names are `YYYYmmdd-HHMMSS.tar.gz`, and `ls` sorts by name, so the last line is the
    // newest. `ls -t` would be wrong: `cp -a` copies the source mtime, so ties break arbitrarily.
    'prev=$(ls -1 "$release_dir"/*.tar.gz 2>/dev/null | tail -n 1) || true',
    'tar -tzf "$archive" | grep -qx "./index.html"',
    'work=$(mktemp -d /tmp/teachforge-install.XXXXXX)',
    'trap \'rm -rf "$work"\' EXIT',
    'tar -xzf "$archive" -C "$work"',
    // Overlay instead of replacing: downloads/ and latest.json must survive a site deploy.
    'cp -a "$work/." "$dir/"',
    // Files this site shipped before but no longer ships (dropped page, removed screenshot) are
    // deleted; anything the deploy never shipped (installer, latest.json) is never a candidate.
    'tar -tzf "$archive" > "$work/.new-files"',
    'if [ -n "$prev" ]; then',
    '  for entry in $(tar -tzf "$prev"); do',
    '    case "$entry" in',
    '      ./*) if [ -f "$dir/$entry" ] && ! grep -qxF "$entry" "$work/.new-files"; then rm -f "$dir/$entry"; fi ;;',
    '    esac',
    '  done',
    'fi',
    'cp -a "$archive" "$release_dir/$(date +%Y%m%d-%H%M%S).tar.gz"',
    'all=$(ls -1 "$release_dir"/*.tar.gz)',
    'total=$(printf "%s\\n" "$all" | wc -l)',
    'drop=$((total - ' + releaseKeep + '))',
    'if [ "$drop" -gt 0 ]; then printf "%s\\n" "$all" | head -n "$drop" | while read -r old; do rm -f "$old"; done; fi',
    'echo "INDEX_SHA=$(sha256sum "$dir/index.html" | cut -d" " -f1)"',
  ].join('\n');
}

/** Runs `ssh`/`scp` with the terminal attached for password prompts, capturing stdout only. */
function runOpenSsh(command, args, label) {
  const result = spawnSync(command, args, { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  if (result.error) throw new Error(label + ' failed: ' + result.error.message);
  if (result.status !== 0) throw new Error(label + ' exited with code ' + result.status);
  return result.stdout ?? '';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { packaged, skipped } = collectSiteFiles();

  const workspace = mkdtempSync(path.join(tmpdir(), 'teachforge-site-'));
  const staging = path.join(workspace, 'site');
  const archive = path.join(workspace, 'site.tar.gz');
  mkdirSync(staging, { recursive: true });
  stageSite(packaged, staging);

  // Relative paths with an explicit cwd: GNU tar reads `C:\...` as a `host:file` remote spec.
  execFileSync('tar', ['-czf', 'site.tar.gz', '-C', 'site', '.'], { cwd: workspace, stdio: 'inherit' });

  const archiveSha = sha256File(archive);
  const indexSha = sha256File(path.join(staging, 'index.html'));
  const archiveKb = (statSync(archive).size / 1024).toFixed(0);
  const protoBar = /proto-bar/.test(readFileSync(path.join(staging, 'index.html'), 'utf8'));

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const remoteArchive = '/tmp/teachforge-site-' + stamp + '.tar.gz';
  const releaseDir = remoteStateDir + '/releases';
  const target = options.user + '@' + options.host;
  const sshFlags = ['-p', String(options.port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15'];
  if (options.key) sshFlags.push('-i', options.key);
  const scpFlags = ['-P', String(options.port), '-o', 'StrictHostKeyChecking=accept-new'];
  if (options.key) scpFlags.push('-i', options.key);
  const remoteScript = buildRemoteScript({ dir: options.dir, archive: remoteArchive, sha256: archiveSha, releaseDir });

  console.log('site      : ' + packaged.length + ' files, ' + archiveKb + ' KB (' + skipped.length + ' local-only files skipped)');
  console.log('archive   : ' + archive);
  console.log('checksum  : ' + archiveSha);
  console.log('target    : ' + target + ':' + options.dir);
  if (protoBar) {
    console.warn('warning   : index.html still contains the .proto-bar prototype banner');
  }

  if (options.dryRun) {
    console.log('dry-run   : no upload performed');
    console.log('files     :');
    for (const file of packaged) console.log('  ' + file);
    console.log('remote    :');
    console.log(remoteScript.split('\n').map((line) => '  ' + line).join('\n'));
    console.log('kept      : ' + archive);
    return;
  }

  runOpenSsh('scp', [...scpFlags, archive, target + ':' + remoteArchive], 'scp upload');
  const stdout = runOpenSsh('ssh', [...sshFlags, target, remoteScript], 'ssh install');

  const remoteIndex = /INDEX_SHA=([0-9a-f]{64})/.exec(stdout)?.[1];
  if (remoteIndex !== indexSha) {
    throw new Error('index.html checksum differs after install: ' + remoteIndex + ' != ' + indexSha);
  }
  console.log('deployed  : index.html ' + indexSha.slice(0, 12) + '… verified');

  const checkUrl = options.checkUrl || 'http://' + options.host + '/';
  try {
    const response = await fetch(checkUrl, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      console.log('http      : ' + response.status + ' ' + checkUrl);
    } else {
      console.warn('warning   : ' + checkUrl + ' returned ' + response.status + ' (site may be served by domain only)');
    }
  } catch (error) {
    console.warn('warning   : ' + checkUrl + ' unreachable: ' + error.message);
  }

  rmSync(workspace, { recursive: true, force: true });
}

await main();
