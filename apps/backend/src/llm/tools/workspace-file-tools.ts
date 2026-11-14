import { constants as fsConstants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  EditOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent';

type PiFileToolSdk = Pick<
  typeof import('@earendil-works/pi-coding-agent'),
  | 'createReadToolDefinition'
  | 'createEditToolDefinition'
  | 'createWriteToolDefinition'
  | 'detectSupportedImageMimeTypeFromFile'
>;

/** File-system methods used by Agent file tools; injectable at the boundary. */
export type WorkspaceFileSystem = Pick<
  typeof fs,
  'access' | 'lstat' | 'mkdir' | 'readFile' | 'realpath' | 'writeFile'
>;

/** Supplies app-owned files and the unmodified current user request for one session. */
export interface WorkspaceFileToolPolicy {
  /** App-owned config and style files must never become Agent file-tool targets. */
  protectedPaths?: readonly string[];
  /** Only the current stream request may grant a temporary external write target. */
  currentUserRequest?: string;
  /**
   * Called after one file mutation succeeded, with the already-resolved absolute path.
   *
   * The artifact index subscribes here instead of inspecting tool events: the resolved path is only
   * known inside these operations, and the tool event payload does not carry it.
   */
  onFileWritten?: (input: {
    absolutePath: string;
    tool: 'write' | 'edit';
  }) => Promise<void> | void;
  /**
   * Reports how one read target was classified, including which check rejected it.
   *
   * `onFileOperationFailed` reports a failure but not whether the rejection came from the app-owned
   * path check or from the filesystem, so a denied read needs this refinement to be diagnosable.
   * The target is reported as a path scope, never as text.
   */
  onFileReadResolution?: (report: ReadResolutionReport) => void;
  /** Reports failed file-tool operations without exposing the requested path or file contents. */
  onFileOperationFailed?: (input: {
    toolName: 'read' | 'edit' | 'write';
    operation: 'access' | 'readFile' | 'detectImageMimeType' | 'mkdir' | 'writeFile';
    pathScope: 'workspace' | 'external' | 'invalid';
    elapsedMs: number;
    error: unknown;
  }) => void;
}

/** Describes a one-session exception derived from one explicit user path. */
interface ExternalPathGrant {
  kind: 'directory' | 'file';
  path: string;
}

/** Names how one read target was accepted or which check rejected it. */
export type ReadResolutionOutcome =
  | 'resolved'
  | 'invalid_path'
  | 'path_unavailable'
  | 'not_a_file'
  | 'managed_file_denied';

/** Describes one read-target resolution as an input summary plus the deciding check. */
export interface ReadResolutionReport {
  outcome: ReadResolutionOutcome;
  /** Where the target points: the workspace, outside it, or an unusable input. */
  pathScope: 'workspace' | 'external' | 'invalid';
  /** Input shape: how many app-owned paths applied to this read. */
  protectedPathCount: number;
  elapsedMs: number;
}

/** Creates the configured workspace and returns its canonical, non-symlink root. */
export async function prepareWorkspaceDirectory(
  workspaceDirectory: string,
  fileSystem: WorkspaceFileSystem = fs,
): Promise<string> {
  const configuredRoot = resolve(workspaceDirectory);
  let rootInfo: Awaited<ReturnType<typeof fileSystem.lstat>> | undefined;
  try {
    rootInfo = await fileSystem.lstat(configuredRoot);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  if (!rootInfo) {
    // Only the path selected as the workspace root may be created here.
    await fileSystem.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    rootInfo = await fileSystem.lstat(configuredRoot);
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('The Agent workspace must be a real directory.');
  }

  const canonicalRoot = await fileSystem.realpath(configuredRoot);
  const canonicalInfo = await fileSystem.lstat(canonicalRoot);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
    throw new Error('The Agent workspace must be a real directory.');
  }
  return canonicalRoot;
}

/**
 * Creates Pi's native file tools with separate read and write boundaries.
 * Reads may target any ordinary file except app-owned settings; all mutation is
 * enforced here, with a one-session exception only for an explicit user target.
 */
export async function createWorkspaceFileTools(
  sdk: PiFileToolSdk,
  workspaceDirectory: string,
  fileSystem: WorkspaceFileSystem = fs,
  policy: WorkspaceFileToolPolicy = {},
) {
  const workspaceRoot = await prepareWorkspaceDirectory(
    workspaceDirectory,
    fileSystem,
  );
  const protectedPaths = (policy.protectedPaths ?? []).map((path) => resolve(path));
  const currentUserRequest = policy.currentUserRequest ?? '';
  const externalGrant = deriveExternalWriteGrant(currentUserRequest, workspaceRoot);

  // Pi resolves one target once per operation (access, readFile, mime detection). Identical reports
  // are collapsed so a single read tool call does not repeat the same line, and a report carries no
  // distinguishing text once the path is reduced to its scope anyway.
  const reportedReadResolutions = new Set<string>();
  const reportReadResolution = (report: ReadResolutionReport): void => {
    if (!policy.onFileReadResolution) return;
    const key = [
      report.outcome,
      report.pathScope,
      report.protectedPathCount,
    ].join('|');
    if (reportedReadResolutions.has(key)) return;
    reportedReadResolutions.add(key);
    policy.onFileReadResolution(report);
  };

  const readOperations: ReadOperations = {
    access: async (filePath) => runLoggedFileOperation(
      policy,
      workspaceRoot,
      'read',
      'access',
      filePath,
      async () => {
        const safePath = await resolveReadableFile(
          workspaceRoot,
          filePath,
          protectedPaths,
          fileSystem,
          reportReadResolution,
        );
        await fileSystem.access(safePath, fsConstants.R_OK);
      },
    ),
    readFile: async (filePath) => runLoggedFileOperation(
      policy,
      workspaceRoot,
      'read',
      'readFile',
      filePath,
      async () => {
        const safePath = await resolveReadableFile(
          workspaceRoot,
          filePath,
          protectedPaths,
          fileSystem,
          reportReadResolution,
        );
        const imageMimeType = await sdk.detectSupportedImageMimeTypeFromFile(safePath);
        if (imageMimeType) {
          // Images are never handed to the model as bytes: one read of a PNG already put ~180 KB of
          // base64 into a snapshot that every later turn replayed. The note keeps the read honest.
          return Buffer.from(
            `[image not loaded: ${imageMimeType}. Images are never read into the conversation.]\n`,
            'utf8',
          );
        }
        return fileSystem.readFile(safePath);
      },
    ),
    detectImageMimeType: async (filePath) => runLoggedFileOperation(
      policy,
      workspaceRoot,
      'read',
      'detectImageMimeType',
      filePath,
      async () => {
        // Resolving still enforces the read policy and reports the decision, but the type is never
        // returned: Pi would build an image block from the file bytes.
        await resolveReadableFile(
          workspaceRoot,
          filePath,
          protectedPaths,
          fileSystem,
          reportReadResolution,
        );
        return undefined;
      },
    ),
  };

  const editOperations: EditOperations = {
    access: async (filePath) => runLoggedFileOperation(
      policy,
      workspaceRoot,
      'edit',
      'access',
      filePath,
      async () => {
        const safePath = await resolveWritableFile(
          workspaceRoot,
          filePath,
          protectedPaths,
          externalGrant,
          fileSystem,
          false,
        );
        await fileSystem.access(safePath, fsConstants.R_OK | fsConstants.W_OK);
      },
    ),
    readFile: async (filePath) => runLoggedFileOperation(
      policy,
      workspaceRoot,
      'edit',
      'readFile',
      filePath,
      async () => {
        const safePath = await resolveWritableFile(
          workspaceRoot,
          filePath,
          protectedPaths,
          externalGrant,
          fileSystem,
          false,
        );
        return fileSystem.readFile(safePath);
      },
    ),
    writeFile: async (filePath, content) => {
      const safePath = await runLoggedFileOperation(
        policy,
        workspaceRoot,
        'edit',
        'writeFile',
        filePath,
        async () => {
          const safePath = await resolveWritableFile(
            workspaceRoot,
            filePath,
            protectedPaths,
            externalGrant,
            fileSystem,
            true,
          );
          await fileSystem.writeFile(safePath, content, 'utf8');
          return safePath;
        },
      );
      await policy.onFileWritten?.({ absolutePath: safePath, tool: 'edit' });
    },
  };

  const writeOperations: WriteOperations = {
    mkdir: async (directoryPath) => runLoggedFileOperation(
      policy,
      workspaceRoot,
      'write',
      'mkdir',
      directoryPath,
      async () => {
        const requestedPath = resolve(workspaceRoot, directoryPath);
        if (isPathWithin(workspaceRoot, requestedPath)) {
          await ensureWorkspaceDirectory(
            workspaceRoot,
            requestedPath,
            fileSystem,
          );
          return;
        }

        if (
          externalGrant?.kind !== 'directory' ||
          !isPathWithin(externalGrant.path, requestedPath)
        ) {
          // Pi's native write tool calls mkdir(parent) even for an exact-file
          // grant. Permit only a no-op check of that already-existing parent.
          if (
            externalGrant?.kind === 'file' &&
            areSamePath(dirname(externalGrant.path), requestedPath)
          ) {
            await verifyExistingExternalDirectory(requestedPath, fileSystem);
            return;
          }
          throw workspaceBoundaryError();
        }
        const externalRoot = await prepareGrantedExternalDirectory(
          externalGrant.path,
          fileSystem,
        );
        const relativePath = relative(externalGrant.path, requestedPath);
        await ensureWorkspaceDirectory(
          externalRoot,
          resolve(externalRoot, relativePath),
          fileSystem,
        );
      },
    ),
    writeFile: async (filePath, content) => {
      const safePath = await runLoggedFileOperation(
        policy,
        workspaceRoot,
        'write',
        'writeFile',
        filePath,
        async () => {
          const safePath = await resolveWritableFile(
            workspaceRoot,
            filePath,
            protectedPaths,
            externalGrant,
            fileSystem,
            true,
          );
          await fileSystem.writeFile(safePath, content, 'utf8');
          return safePath;
        },
      );
      await policy.onFileWritten?.({ absolutePath: safePath, tool: 'write' });
    },
  };

  return [
    // The stock description promises "Images are sent as attachments", which this tool no longer
    // does; leaving it would have the model plan a read that cannot deliver an image.
    {
      ...sdk.createReadToolDefinition(workspaceRoot, { operations: readOperations }),
      description:
        'Read the contents of a file. Text and SVG files return their text. Images are never attached and are not read: reading one returns a note that the file exists but cannot be loaded, because image bytes must not enter the conversation.',
      promptGuidelines: [
        'Use read to examine files instead of cat or sed.',
        'Reading an image only reports that the file exists; do not retry it expecting content.',
      ],
    },
    sdk.createEditToolDefinition(workspaceRoot, { operations: editOperations }),
    sdk.createWriteToolDefinition(workspaceRoot, { operations: writeOperations }),
  ];
}

/** Runs one Pi file operation and reports failures while preserving the original exception. */
async function runLoggedFileOperation<T>(
  policy: WorkspaceFileToolPolicy,
  workspaceRoot: string,
  toolName: 'read' | 'edit' | 'write',
  operation: 'access' | 'readFile' | 'detectImageMimeType' | 'mkdir' | 'writeFile',
  filePath: string,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await execute();
  } catch (error) {
    try {
      policy.onFileOperationFailed?.({
        toolName,
        operation,
        pathScope: getFilePathScope(workspaceRoot, filePath),
        elapsedMs: Date.now() - startedAt,
        error,
      });
    } catch {
      // A diagnostic failure must never hide the filesystem or policy error Pi needs to handle.
    }
    throw error;
  }
}

/** Classifies a requested target without adding its path to logs. */
function getFilePathScope(
  workspaceRoot: string,
  filePath: string,
): 'workspace' | 'external' | 'invalid' {
  if (typeof filePath !== 'string' || filePath.trim() === '') return 'invalid';
  return isPathWithin(workspaceRoot, resolve(workspaceRoot, filePath))
    ? 'workspace'
    : 'external';
}

/** Resolves a read target without restricting it to the workspace root. */
async function resolveReadableFile(
  workspaceRoot: string,
  filePath: string,
  protectedPaths: readonly string[],
  fileSystem: WorkspaceFileSystem,
  reportReadResolution?: (report: ReadResolutionReport) => void,
): Promise<string> {
  const startedAt = Date.now();
  const pathScope = getFilePathScope(workspaceRoot, filePath);
  // Every exit path reports the same input summary plus the check that decided the outcome, so a
  // denied read is diagnosable without logging the target path.
  let outcome: ReadResolutionOutcome = 'resolved';
  try {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      outcome = 'invalid_path';
      throw workspaceBoundaryError();
    }
    const requestedPath = resolve(workspaceRoot, filePath);
    let canonicalPath: string;
    let fileInfo: Stats;
    try {
      canonicalPath = await fileSystem.realpath(requestedPath);
      fileInfo = await fileSystem.lstat(canonicalPath);
    } catch (error) {
      outcome = 'path_unavailable';
      throw error;
    }
    if (!fileInfo.isFile()) {
      outcome = 'not_a_file';
      throw workspaceBoundaryError();
    }
    try {
      await assertNotManagedFile(
        requestedPath,
        canonicalPath,
        protectedPaths,
        fileInfo,
        fileSystem,
      );
    } catch (error) {
      outcome = hasErrorCode(error, 'EWORKSPACE')
        ? 'managed_file_denied'
        : 'path_unavailable';
      throw error;
    }
    return canonicalPath;
  } finally {
    try {
      reportReadResolution?.({
        outcome,
        pathScope,
        protectedPathCount: protectedPaths.length,
        elapsedMs: Date.now() - startedAt,
      });
    } catch {
      // A diagnostic failure must never change the read decision.
    }
  }
}

/** Resolves a write/edit target under the workspace or the current-turn grant. */
async function resolveWritableFile(
  workspaceRoot: string,
  filePath: string,
  protectedPaths: readonly string[],
  externalGrant: ExternalPathGrant | undefined,
  fileSystem: WorkspaceFileSystem,
  allowMissing: boolean,
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw workspaceBoundaryError();
  }
  const requestedPath = resolve(workspaceRoot, filePath);
  let safePath: string;

  if (isPathWithin(workspaceRoot, requestedPath)) {
    safePath = await resolveWorkspaceFile(
      workspaceRoot,
      requestedPath,
      fileSystem,
      allowMissing,
    );
  } else if (
    externalGrant?.kind === 'directory' &&
    isPathWithin(externalGrant.path, requestedPath)
  ) {
    const externalRoot = await prepareGrantedExternalDirectory(
      externalGrant.path,
      fileSystem,
    );
    const relativePath = relative(externalGrant.path, requestedPath);
    safePath = await resolveWorkspaceFile(
      externalRoot,
      resolve(externalRoot, relativePath),
      fileSystem,
      allowMissing,
    );
  } else if (
    externalGrant?.kind === 'file' &&
    areSamePath(externalGrant.path, requestedPath)
  ) {
    safePath = await resolveGrantedExternalFile(
      externalGrant.path,
      fileSystem,
      allowMissing,
    );
  } else {
    throw workspaceBoundaryError();
  }

  const targetInfo = await lstatIfPresent(fileSystem, safePath);
  if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
    throw workspaceBoundaryError();
  }
  await assertNotManagedFile(
    requestedPath,
    safePath,
    protectedPaths,
    undefined,
    fileSystem,
  );
  return safePath;
}

/** Resolves an existing arbitrary file and denies app config by path or identity. */
async function assertNotManagedFile(
  requestedPath: string,
  resolvedPath: string,
  protectedPaths: readonly string[],
  knownFileInfo: Awaited<ReturnType<WorkspaceFileSystem['lstat']>> | undefined,
  fileSystem: WorkspaceFileSystem,
): Promise<void> {
  const requested = resolve(requestedPath);
  const resolved = resolve(resolvedPath);
  const candidateInfo =
    knownFileInfo ?? (await lstatIfPresent(fileSystem, resolved));

  for (const managedPath of protectedPaths) {
    const managedLexical = resolve(managedPath);
    if (
      areSamePath(requested, managedLexical) ||
      areSamePath(resolved, managedLexical) ||
      isManagedTemporarySibling(requested, managedLexical) ||
      isManagedTemporarySibling(resolved, managedLexical)
    ) {
      throw workspaceBoundaryError();
    }


    const managedCanonical = await fileSystem
      .realpath(managedLexical)
      .catch(() => managedLexical);
    if (
      areSamePath(resolved, managedCanonical) ||
      isManagedTemporarySibling(resolved, managedCanonical)
    ) {
      throw workspaceBoundaryError();
    }

    // realpath does not reveal hard links, so compare the file identity too.
    const managedInfo = await lstatIfPresent(fileSystem, managedCanonical);
    if (
      candidateInfo?.isFile() &&
      managedInfo?.isFile() &&
      candidateInfo.ino !== 0 &&
      candidateInfo.dev === managedInfo.dev &&
      candidateInfo.ino === managedInfo.ino
    ) {
      throw workspaceBoundaryError();
    }
  }
}

/** Protects the same-directory temporary files SettingsService uses for atomic replacement. */
function isManagedTemporarySibling(
  candidatePath: string,
  managedPath: string,
): boolean {
  const candidate = resolve(candidatePath);
  const prefix = `${resolve(managedPath)}.`;
  const normalizedCandidate =
    process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const normalizedPrefix =
    process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  const normalizedSuffix = '.tmp';
  return (
    normalizedCandidate.startsWith(normalizedPrefix) &&
    normalizedCandidate.endsWith(normalizedSuffix)
  );
}

/** Resolves an app-authorized exact file target without granting its parent directory. */
async function resolveGrantedExternalFile(
  filePath: string,
  fileSystem: WorkspaceFileSystem,
  allowMissing: boolean,
): Promise<string> {
  const target = resolve(filePath);
  const parentPath = dirname(target);
  const parentRealPath = await fileSystem.realpath(parentPath);
  const parentInfo = await fileSystem.lstat(parentRealPath);
  if (!parentInfo.isDirectory()) throw workspaceBoundaryError();

  const canonicalTarget = join(parentRealPath, basename(target));
  try {
    const targetInfo = await fileSystem.lstat(target);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw workspaceBoundaryError();
    }
  } catch (error) {
    if (!allowMissing || !isMissingPathError(error)) throw error;
  }
  return canonicalTarget;
}

/** Creates only the exact external directory named by the current user request. */
async function prepareGrantedExternalDirectory(
  directoryPath: string,
  fileSystem: WorkspaceFileSystem,
): Promise<string> {
  const target = resolve(directoryPath);
  let targetInfo: Awaited<ReturnType<typeof fileSystem.lstat>> | undefined;
  try {
    targetInfo = await fileSystem.lstat(target);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  if (!targetInfo) {
    const parentPath = dirname(target);
    const parentRealPath = await fileSystem.realpath(parentPath);
    const parentInfo = await fileSystem.lstat(parentRealPath);
    if (!parentInfo.isDirectory()) throw workspaceBoundaryError();
    try {
      await fileSystem.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    targetInfo = await fileSystem.lstat(target);
  }

  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw workspaceBoundaryError();
  }
  const canonicalRoot = await fileSystem.realpath(target);
  const canonicalInfo = await fileSystem.lstat(canonicalRoot);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
    throw workspaceBoundaryError();
  }
  return canonicalRoot;
}

/** Allows Pi's required parent mkdir call only when an exact-file grant's parent exists. */
async function verifyExistingExternalDirectory(
  directoryPath: string,
  fileSystem: WorkspaceFileSystem,
): Promise<void> {
  const requestedDirectory = resolve(directoryPath);
  const directoryInfo = await fileSystem.lstat(requestedDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw workspaceBoundaryError();
  }
  const canonicalDirectory = await fileSystem.realpath(requestedDirectory);
  const canonicalInfo = await fileSystem.lstat(canonicalDirectory);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
    throw workspaceBoundaryError();
  }
}

/** Resolves an existing or new workspace file without following symlinks. */
async function resolveWorkspaceFile(
  workspaceRoot: string,
  filePath: string,
  fileSystem: WorkspaceFileSystem,
  allowMissing = false,
  allowWorkspaceRoot = false,
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw workspaceBoundaryError();
  }

  const absolutePath = resolve(workspaceRoot, filePath);
  if (!isPathWithin(workspaceRoot, absolutePath)) {
    throw workspaceBoundaryError();
  }
  if (areSamePath(absolutePath, workspaceRoot)) {
    if (allowWorkspaceRoot) return workspaceRoot;
    throw workspaceBoundaryError();
  }

  const pathParts = relative(workspaceRoot, absolutePath).split(sep);
  let currentPath = workspaceRoot;
  for (const pathPart of pathParts) {
    currentPath = join(currentPath, pathPart);
    let entryInfo: Awaited<ReturnType<typeof fileSystem.lstat>>;
    try {
      entryInfo = await fileSystem.lstat(currentPath);
    } catch (error) {
      if (allowMissing && isMissingPathError(error)) return absolutePath;
      throw error;
    }

    if (entryInfo.isSymbolicLink()) throw workspaceBoundaryError();
    if (!areSamePath(currentPath, absolutePath) && !entryInfo.isDirectory()) {
      throw workspaceBoundaryError();
    }

    const realPath = await fileSystem.realpath(currentPath);
    if (!isPathWithin(workspaceRoot, realPath)) {
      throw workspaceBoundaryError();
    }
  }

  return absolutePath;
}

/** Creates nested directories one level at a time inside an authorized root. */
async function ensureWorkspaceDirectory(
  workspaceRoot: string,
  directoryPath: string,
  fileSystem: WorkspaceFileSystem,
): Promise<void> {
  const safeDirectory = await resolveWorkspaceFile(
    workspaceRoot,
    directoryPath,
    fileSystem,
    true,
    true,
  );
  if (areSamePath(safeDirectory, workspaceRoot)) return;

  const directoryParts = relative(workspaceRoot, safeDirectory).split(sep);
  let currentPath = workspaceRoot;
  for (const directoryPart of directoryParts) {
    currentPath = join(currentPath, directoryPart);
    let entryInfo: Awaited<ReturnType<typeof fileSystem.lstat>>;
    try {
      entryInfo = await fileSystem.lstat(currentPath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        await fileSystem.mkdir(currentPath, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
      }
      entryInfo = await fileSystem.lstat(currentPath);
    }

    if (entryInfo.isSymbolicLink() || !entryInfo.isDirectory()) {
      throw workspaceBoundaryError();
    }
    const realPath = await fileSystem.realpath(currentPath);
    if (!isPathWithin(workspaceRoot, realPath)) {
      throw workspaceBoundaryError();
    }
  }
}

/** Extracts at most one explicit absolute write destination from this user turn. */
function deriveExternalWriteGrant(
  currentUserRequest: string,
  workspaceRoot: string,
): ExternalPathGrant | undefined {
  const candidates = extractAbsolutePromptPaths(currentUserRequest);
  if (candidates.length !== 1) return undefined;

  const candidate = candidates[0];
  const lineStart = currentUserRequest.lastIndexOf('\n', candidate.start - 1) + 1;
  const nextNewline = currentUserRequest.indexOf('\n', candidate.end);
  const lineEnd = nextNewline < 0 ? currentUserRequest.length : nextNewline;
  const line = currentUserRequest.slice(lineStart, lineEnd);
  if (!HAS_WRITE_INTENT.test(line) || hasNegatedWriteIntent(line)) return undefined;
  if (!candidate.quoted && !hasClearUnquotedPathBoundary(currentUserRequest, candidate.end, lineEnd)) {
    return undefined;
  }
  if (!isAbsolute(candidate.path)) return undefined;

  const targetPath = resolve(candidate.path);
  if (isPathWithin(workspaceRoot, targetPath)) return undefined;
  const kind = classifyExternalTarget(candidate.path, line);
  if (!kind) return undefined;
  return {
    kind,
    path: targetPath,
  };
}

/** Extracts quoted paths with spaces and unquoted platform-absolute path tokens. */
function extractAbsolutePromptPaths(
  prompt: string,
): Array<{ path: string; start: number; end: number; quoted: boolean }> {
  const quotedRanges: Array<{ start: number; end: number }> = [];
  const candidates: Array<{
    path: string;
    start: number;
    end: number;
    quoted: boolean;
  }> = [];
  const quotedPattern = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^"'`\r\n]+?)\1/g;
  for (const match of prompt.matchAll(quotedPattern)) {
    const path = match[2].trim();
    const start = match.index! + 1;
    const end = start + match[2].length;
    quotedRanges.push({ start: match.index!, end: match.index! + match[0].length });
    candidates.push({ path, start, end, quoted: true });
  }

  const unquotedPattern = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'`<>|,;，；。！？!?]+/g;
  for (const match of prompt.matchAll(unquotedPattern)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (quotedRanges.some((range) => start >= range.start && end <= range.end)) {
      continue;
    }
    candidates.push({ path: match[0], start, end, quoted: false });
  }

  return candidates;
}

/** Rejects unquoted path prefixes that may be followed by a spaced path segment. */
function hasClearUnquotedPathBoundary(
  prompt: string,
  pathEnd: number,
  lineEnd: number,
): boolean {
  const trailingText = prompt.slice(pathEnd, lineEnd).trim();
  return trailingText === '' || /^[.!?。！？,，;；]+$/u.test(trailingText);
}

/** Detects an explicit request to create or change a file in this same prompt line. */
const HAS_WRITE_INTENT =
  /\b(?:write|save|create|generate|export|store|put)\b|写入|写到|保存|创建|生成|导出|输出|存放|放到|新建/iu;

/** Rejects language that explicitly forbids the write action in this prompt. */
function hasNegatedWriteIntent(line: string): boolean {
  return (
    /(?:不要|别|无需|不需要|禁止|勿)\s*(?:写|保存|创建|生成|导出|输出|存放|放)/u.test(
      line,
    ) || /\b(?:do not|don't|never|not)\s+(?:write|save|create|generate|export|store)\b/i.test(line)
  );
}

/** Distinguishes a named directory grant from an exact file grant conservatively. */
function classifyExternalTarget(
  path: string,
  promptLine: string,
): ExternalPathGrant['kind'] | undefined {
  const pathIndex = promptLine.indexOf(path);
  const before = promptLine.slice(Math.max(0, pathIndex - 32), pathIndex);
  const after = promptLine.slice(pathIndex + path.length, pathIndex + path.length + 24);
  const destinationContext = `${before} ${after}`;
  if (
    /(?:文件名|文件路径|保存为|命名为|filename|file name|save as|named as)/iu.test(
      before,
    )
  ) {
    return 'file';
  }
  if (
    /[\\/]$/.test(path) ||
    /(?:目录|文件夹|\b(?:directory|folder)\b)/iu.test(destinationContext)
  ) {
    return 'directory';
  }
  if (/\.[A-Za-z0-9]{1,16}$/.test(basename(path))) return 'file';
  if (/(?:到|至|在|下面|之下|目录下|文件夹下)\s*$/u.test(before)) {
    return 'directory';
  }
  if (/\b(?:to|into|under|at)\s*$/iu.test(before)) return 'directory';
  return undefined;
}

/** Checks that a resolved path is the root itself or a descendant. */
export function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

/** Compares fully resolved paths with Windows' case-insensitive path semantics. */
function areSamePath(firstPath: string, secondPath: string): boolean {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

/** Reads metadata only when a path exists, keeping missing write targets distinct. */
async function lstatIfPresent(
  fileSystem: WorkspaceFileSystem,
  filePath: string,
): Promise<Awaited<ReturnType<WorkspaceFileSystem['lstat']>> | undefined> {
  try {
    return await fileSystem.lstat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

/** Identifies an expected missing-path error while preserving other failures. */
function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

/** Identifies a concurrent directory creation so the resulting entry can be checked. */
function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

/** Narrows file-system errors to their stable Node error code. */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/** Produces a model-readable denial without leaking local path details. */
function workspaceBoundaryError(): Error & { code: string } {
  const error = new Error(
    'Agent file access was denied by the local file policy. Reads may use ordinary files from any source except TeachForge-owned settings. Writes must stay inside the configured workspace unless the current user request explicitly names one external absolute target; quote paths containing spaces and name a single destination.',
  ) as Error & { code: string };
  error.code = 'EWORKSPACE';
  return error;
}
