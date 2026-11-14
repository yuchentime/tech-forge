/**
 * Pi 文件工具的操作适配层。
 * Pi 分阶段调用 access/readFile/writeFile/mkdir；每个阶段都经过统一策略检查。
 */
import { constants as fsConstants } from 'node:fs';
import type {
  EditOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { ExternalWriteGrant } from './external-write-grant';
import {
  ensureWritableDirectory,
  getFilePathScope,
  resolveReadableFile,
  resolveWritableFile,
} from './workspace-file-policy';
import type {
  PiFileToolSdk,
  ReadResolutionReport,
  WorkspaceFileSystem,
  WorkspaceFileToolPolicy,
} from './workspace-file-tool-types';

/** 三类 Pi 文件操作共享的已准备策略上下文。 */
export interface WorkspaceFileOperationContext {
  workspaceRoot: string;
  protectedPaths: readonly string[];
  externalGrant?: ExternalWriteGrant;
  fileSystem: WorkspaceFileSystem;
  policy: WorkspaceFileToolPolicy;
}

/** 对同类读取判定只报告一次，避免 Pi 分阶段解析造成重复日志。 */
export function createReadResolutionReporter(
  policy: WorkspaceFileToolPolicy,
): (report: ReadResolutionReport) => void {
  const reportedReadResolutionSummaries = new Set<string>();
  return (report) => {
    if (!policy.onFileReadResolution) return;
    const key = [report.outcome, report.pathScope, report.protectedPathCount].join('|');
    if (reportedReadResolutionSummaries.has(key)) return;
    reportedReadResolutionSummaries.add(key);
    policy.onFileReadResolution(report);
  };
}

/** 创建 read 工具底层操作，并在每一步读取前校验目标。 */
export function createReadOperations(
  sdk: PiFileToolSdk,
  context: WorkspaceFileOperationContext,
  reportReadResolution: (report: ReadResolutionReport) => void,
): ReadOperations {
  const { workspaceRoot, protectedPaths, fileSystem, policy } = context;
  return {
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
          // 图片字节不进入模型快照，避免后续轮次重复携带大量 base64；返回说明告知模型图片未加载。
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
        // 仍要检查路径并汇报判定，但不返回 MIME 类型，避免 Pi 从文件字节构造图像块。
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
}

/** 创建 edit 工具底层操作；现有文件的读改写过程均受写入策略保护。 */
export function createEditOperations(
  context: WorkspaceFileOperationContext,
): EditOperations {
  const { workspaceRoot, protectedPaths, externalGrant, fileSystem, policy } = context;
  return {
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
          { allowMissing: false },
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
          { allowMissing: false },
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
            { allowMissing: true },
          );
          await fileSystem.writeFile(safePath, content, 'utf8');
          return safePath;
        },
      );
      await policy.onFileWritten?.({ absolutePath: safePath, tool: 'edit' });
    },
  };
}

/** 创建 write 工具底层操作；目录创建和文件写入分别校验授权范围。 */
export function createWriteOperations(
  context: WorkspaceFileOperationContext,
): WriteOperations {
  const { workspaceRoot, protectedPaths, externalGrant, fileSystem, policy } = context;
  return {
    mkdir: async (directoryPath) => runLoggedFileOperation(
      policy,
      workspaceRoot,
      'write',
      'mkdir',
      directoryPath,
      async () => {
        await ensureWritableDirectory(
          workspaceRoot,
          directoryPath,
          externalGrant,
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
            { allowMissing: true },
          );
          await fileSystem.writeFile(safePath, content, 'utf8');
          return safePath;
        },
      );
      await policy.onFileWritten?.({ absolutePath: safePath, tool: 'write' });
    },
  };
}

/** 包装一次 Pi 文件操作；失败时发出诊断回调，并保留原异常。 */
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
      // 诊断回调失败不能覆盖 Pi 需要处理的文件系统或策略异常。
    }
    throw error;
  }
}
