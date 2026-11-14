/**
 * Agent 工作区文件工具的组合入口。
 * 工作区准备、Pi 操作适配、路径策略和外部授权解析分别由专门模块负责。
 */
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { deriveExternalWriteGrant } from './external-write-grant';
import {
  createEditOperations,
  createReadOperations,
  createReadResolutionReporter,
  createWriteOperations,
  type WorkspaceFileOperationContext,
} from './workspace-file-operations';
import { prepareWorkspaceDirectory } from './workspace-file-policy';
import type {
  PiFileToolSdk,
  WorkspaceFileSystem,
  WorkspaceFileToolPolicy,
} from './workspace-file-tool-types';

export type {
  ReadResolutionOutcome,
  ReadResolutionReport,
  WorkspaceFileSystem,
  WorkspaceFileToolPolicy,
} from './workspace-file-tool-types';
export { isPathWithin, prepareWorkspaceDirectory } from './workspace-file-policy';

/**
 * 创建 Pi 原生 read/edit/write 工具，并在文件系统操作边界执行本地权限策略。
 * 相对路径以当前会话工作区为根，超出策略范围的目标会在 I/O 前被拒绝。
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
  const externalGrant = deriveExternalWriteGrant(
    policy.currentUserRequest ?? '',
    workspaceRoot,
  );
  const context: WorkspaceFileOperationContext = {
    workspaceRoot,
    protectedPaths,
    externalGrant,
    fileSystem,
    policy,
  };
  const reportReadResolution = createReadResolutionReporter(policy);

  // Pi 的默认 read 描述会误导模型认为图片作为附件发送，因此覆盖成真实行为。
  const readTool = {
    ...sdk.createReadToolDefinition(workspaceRoot, {
      operations: createReadOperations(sdk, context, reportReadResolution),
    }),
    description: [
      'Read the contents of a file.',
      'Text and SVG files return their text.',
      'Images are never attached or read: reading one returns a note that the file exists but cannot be loaded, because image bytes must not enter the conversation.',
    ].join(' '),
    promptGuidelines: [
      'Use read to examine files instead of cat or sed.',
      'Reading an image only reports that the file exists; do not retry it expecting content.',
    ],
  };

  return [
    readTool,
    sdk.createEditToolDefinition(workspaceRoot, {
      operations: createEditOperations(context),
    }),
    sdk.createWriteToolDefinition(workspaceRoot, {
      operations: createWriteOperations(context),
    }),
  ];
}
