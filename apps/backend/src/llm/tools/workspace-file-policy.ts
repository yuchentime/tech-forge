/**
 * 工作区路径解析与文件系统安全策略。
 * 本模块准备工作区、校验目标和安全创建目录，不负责构造 Pi 工具。
 */
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExternalWriteGrant } from './external-write-grant';
import type {
  ReadResolutionOutcome,
  ReadResolutionReport,
  WorkspaceFileSystem,
} from './workspace-file-tool-types';

/** 准备工作区目录，并返回规范化后的真实目录路径。 */
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
    // 此处只负责创建配置指定的工作区根目录。
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

/** 仅按工作区内外归类目标，不把具体路径写入日志。 */
export function getFilePathScope(
  workspaceRoot: string,
  filePath: string,
): 'workspace' | 'external' | 'invalid' {
  if (typeof filePath !== 'string' || filePath.trim() === '') return 'invalid';
  return isPathWithin(workspaceRoot, resolve(workspaceRoot, filePath))
    ? 'workspace'
    : 'external';
}

/** 解析可读取文件；普通文件可以位于工作区之外。 */
export async function resolveReadableFile(
  workspaceRoot: string,
  filePath: string,
  protectedPaths: readonly string[],
  fileSystem: WorkspaceFileSystem,
  reportReadResolution?: (report: ReadResolutionReport) => void,
): Promise<string> {
  const startedAt = Date.now();
  const pathScope = getFilePathScope(workspaceRoot, filePath);
  // 所有退出路径都汇报摘要和最终判定，便于诊断，同时不记录目标路径。
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
      // 诊断回调失败不能改变已经作出的读取判定。
    }
  }
}

/** 解析可写目标；目标必须位于工作区或本轮临时授权范围内。 */
export async function resolveWritableFile(
  workspaceRoot: string,
  filePath: string,
  protectedPaths: readonly string[],
  externalGrant: ExternalWriteGrant | undefined,
  fileSystem: WorkspaceFileSystem,
  options: { allowMissing: boolean },
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
      { allowMissing: options.allowMissing },
    );
  } else if (
    externalGrant?.kind === 'directory' &&
    isPathWithin(externalGrant.targetPath, requestedPath)
  ) {
    const externalRoot = await prepareGrantedExternalDirectory(
      externalGrant.targetPath,
      fileSystem,
    );
    const relativePath = relative(externalGrant.targetPath, requestedPath);
    safePath = await resolveWorkspaceFile(
      externalRoot,
      resolve(externalRoot, relativePath),
      fileSystem,
      { allowMissing: options.allowMissing },
    );
  } else if (
    externalGrant?.kind === 'file' &&
    areSamePath(externalGrant.targetPath, requestedPath)
  ) {
    safePath = await resolveGrantedExternalFile(
      externalGrant.targetPath,
      fileSystem,
      { allowMissing: options.allowMissing },
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

/** 按路径、真实路径和文件身份拒绝访问应用托管文件。 */
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

    // realpath 无法识别硬链接别名，因此还要比较设备号和 inode。
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

/** 同时保护 SettingsService 原子替换配置时使用的同目录临时文件。 */
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

/** 校验单文件授权目标，不把授权扩大到它的父目录。 */
async function resolveGrantedExternalFile(
  filePath: string,
  fileSystem: WorkspaceFileSystem,
  options: { allowMissing: boolean },
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
    if (!options.allowMissing || !isMissingPathError(error)) throw error;
  }
  return canonicalTarget;
}

/** 只创建用户本轮明确授权的外部目录。 */
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

/** 单文件授权时只允许检查已存在的父目录，不允许借此创建目录。 */
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

/** 逐级校验工作区路径，拒绝符号链接和越出授权根目录的路径。 */
async function resolveWorkspaceFile(
  workspaceRoot: string,
  filePath: string,
  fileSystem: WorkspaceFileSystem,
  options: { allowMissing?: boolean; allowWorkspaceRoot?: boolean } = {},
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw workspaceBoundaryError();
  }

  const absolutePath = resolve(workspaceRoot, filePath);
  if (!isPathWithin(workspaceRoot, absolutePath)) {
    throw workspaceBoundaryError();
  }
  if (areSamePath(absolutePath, workspaceRoot)) {
    if (options.allowWorkspaceRoot) return workspaceRoot;
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
      if (options.allowMissing && isMissingPathError(error)) return absolutePath;
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

/** 在已授权根目录内逐级创建目录，并复查每一级的实际类型。 */
async function ensureWorkspaceDirectory(
  workspaceRoot: string,
  directoryPath: string,
  fileSystem: WorkspaceFileSystem,
): Promise<void> {
  const safeDirectory = await resolveWorkspaceFile(
    workspaceRoot,
    directoryPath,
    fileSystem,
    { allowMissing: true, allowWorkspaceRoot: true },
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

/** 按工作区或本轮授权创建目录；单文件授权只允许检查现有父目录。 */
export async function ensureWritableDirectory(
  workspaceRoot: string,
  directoryPath: string,
  externalGrant: ExternalWriteGrant | undefined,
  fileSystem: WorkspaceFileSystem,
): Promise<void> {
  const requestedPath = resolve(workspaceRoot, directoryPath);
  if (isPathWithin(workspaceRoot, requestedPath)) {
    await ensureWorkspaceDirectory(workspaceRoot, requestedPath, fileSystem);
    return;
  }

  if (
    externalGrant?.kind === 'directory' &&
    isPathWithin(externalGrant.targetPath, requestedPath)
  ) {
    const externalRoot = await prepareGrantedExternalDirectory(
      externalGrant.targetPath,
      fileSystem,
    );
    const relativePath = relative(externalGrant.targetPath, requestedPath);
    await ensureWorkspaceDirectory(
      externalRoot,
      resolve(externalRoot, relativePath),
      fileSystem,
    );
    return;
  }

  // Pi 写单个指定文件前也会调用 mkdir(parent)，这里只对现有父目录做无副作用校验。
  if (
    externalGrant?.kind === 'file' &&
    areSamePath(dirname(externalGrant.targetPath), requestedPath)
  ) {
    await verifyExistingExternalDirectory(requestedPath, fileSystem);
    return;
  }

  throw workspaceBoundaryError();
}

/** 判断规范化路径是否为根目录本身或其后代。 */
export function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

/** 比较绝对路径，并兼容 Windows 路径不区分大小写的规则。 */
function areSamePath(firstPath: string, secondPath: string): boolean {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

/** 仅在目标存在时读取元数据，让新建目标与其他文件错误保持区分。 */
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

/** 只将 ENOENT 识别为路径不存在，其他文件系统错误原样保留。 */
function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

/** 识别并发创建目录时的 EEXIST，随后仍检查目录的实际状态。 */
function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

/** 根据 Node 稳定的错误码判断文件系统错误类型。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/** 生成模型可理解的拒绝原因，但不泄露本机路径细节。 */
function workspaceBoundaryError(): Error & { code: string } {
  const error = new Error(
    'Agent file access was denied by the local file policy. Reads may use ordinary files from any source except TeachForge-owned settings. Writes must stay inside the configured workspace unless the current user request explicitly names one external absolute target; quote paths containing spaces and name a single destination.',
  ) as Error & { code: string };
  error.code = 'EWORKSPACE';
  return error;
}
