import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/** File-system methods used by workspace tools; injectable to test denied root mkdir calls. */
export type WorkspaceFileSystem = Pick<
  typeof fs,
  'access' | 'lstat' | 'mkdir' | 'readFile' | 'realpath' | 'writeFile'
>;

/** Creates Pi's native read, edit, and write tools with operations confined to one directory. */
export async function createWorkspaceFileTools(
  sdk: PiFileToolSdk,
  workspaceDirectory: string,
  fileSystem: WorkspaceFileSystem = fs,
) {
  const workspaceRoot = await fileSystem.realpath(resolve(workspaceDirectory));
  const rootInfo = await fileSystem.lstat(workspaceRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('The Agent workspace must be an existing directory.');
  }

  const readOperations: ReadOperations = {
    access: async (filePath) => {
      const safePath = await resolveWorkspaceFile(
        workspaceRoot,
        filePath,
        fileSystem,
      );
      await fileSystem.access(safePath, fsConstants.R_OK);
    },
    readFile: async (filePath) => {
      const safePath = await resolveWorkspaceFile(
        workspaceRoot,
        filePath,
        fileSystem,
      );
      return fileSystem.readFile(safePath);
    },
    detectImageMimeType: async (filePath) => {
      const safePath = await resolveWorkspaceFile(
        workspaceRoot,
        filePath,
        fileSystem,
      );
      return sdk.detectSupportedImageMimeTypeFromFile(safePath);
    },
  };

  const editOperations: EditOperations = {
    access: async (filePath) => {
      const safePath = await resolveWorkspaceFile(
        workspaceRoot,
        filePath,
        fileSystem,
      );
      await fileSystem.access(safePath, fsConstants.R_OK | fsConstants.W_OK);
    },
    readFile: async (filePath) => {
      const safePath = await resolveWorkspaceFile(
        workspaceRoot,
        filePath,
        fileSystem,
      );
      return fileSystem.readFile(safePath);
    },
    writeFile: async (filePath, content) => {
      const safePath = await resolveWorkspaceFile(
        workspaceRoot,
        filePath,
        fileSystem,
      );
      await fileSystem.writeFile(safePath, content, 'utf8');
    },
  };

  const writeOperations: WriteOperations = {
    mkdir: (directoryPath) =>
      ensureWorkspaceDirectory(workspaceRoot, directoryPath, fileSystem),
    writeFile: async (filePath, content) => {
      const safePath = await resolveWorkspaceFile(
        workspaceRoot,
        filePath,
        fileSystem,
        true,
      );
      await fileSystem.writeFile(safePath, content, 'utf8');
    },
  };

  return [
    sdk.createReadToolDefinition(workspaceRoot, { operations: readOperations }),
    sdk.createEditToolDefinition(workspaceRoot, { operations: editOperations }),
    sdk.createWriteToolDefinition(workspaceRoot, { operations: writeOperations }),
  ];
}

/** Resolves an existing file or an allowed new file without following workspace symlinks. */
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
  if (!isPathWithinWorkspace(workspaceRoot, absolutePath)) {
    throw workspaceBoundaryError();
  }
  if (absolutePath === workspaceRoot) {
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
    if (currentPath !== absolutePath && !entryInfo.isDirectory()) {
      throw workspaceBoundaryError();
    }

    const realPath = await fileSystem.realpath(currentPath);
    if (!isPathWithinWorkspace(workspaceRoot, realPath)) {
      throw workspaceBoundaryError();
    }
  }

  return absolutePath;
}

/** Creates nested directories one level at a time and never mkdirs the workspace root itself. */
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
  if (safeDirectory === workspaceRoot) return;

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
        await fileSystem.mkdir(currentPath);
      } catch (mkdirError) {
        if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
      }
      entryInfo = await fileSystem.lstat(currentPath);
    }

    if (entryInfo.isSymbolicLink() || !entryInfo.isDirectory()) {
      throw workspaceBoundaryError();
    }
    const realPath = await fileSystem.realpath(currentPath);
    if (!isPathWithinWorkspace(workspaceRoot, realPath)) {
      throw workspaceBoundaryError();
    }
  }
}

/** Checks that a resolved path is the workspace itself or a child path. */
function isPathWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(workspaceRoot, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

/** Identifies expected missing-path errors while creating nested directories. */
function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

/** Identifies a concurrent directory creation so the caller can verify the resulting entry. */
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

/** Produces a model-readable boundary error without asking for interactive approval. */
function workspaceBoundaryError(): Error & { code: string } {
  const error = new Error(
    'File operations are limited to the configured Agent workspace. Use a path inside that directory.',
  ) as Error & { code: string };
  error.code = 'EWORKSPACE';
  return error;
}
