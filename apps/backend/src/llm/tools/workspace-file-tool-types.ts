/**
 * Agent 文件工具共用类型。
 * 集中声明 SDK、文件系统和策略回调的边界，避免各职责模块互相依赖。
 */
import * as fs from 'node:fs/promises';

/** Agent 文件工具实际使用的文件系统接口，允许测试替换实现。 */
export type WorkspaceFileSystem = Pick<
  typeof fs,
  'access' | 'lstat' | 'mkdir' | 'readFile' | 'realpath' | 'writeFile'
>;

/** Pi 文件工具 SDK 的最小依赖面。 */
export type PiFileToolSdk = Pick<
  typeof import('@earendil-works/pi-coding-agent'),
  | 'createReadToolDefinition'
  | 'createEditToolDefinition'
  | 'createWriteToolDefinition'
  | 'detectSupportedImageMimeTypeFromFile'
>;

/** 创建文件工具时注入的应用策略和副作用回调。 */
export interface WorkspaceFileToolPolicy {
  /** 应用托管的配置文件路径；文件工具不可读取或修改这些目标。 */
  protectedPaths?: readonly string[];
  /** 仅本轮原始用户请求可以生成临时的外部写入授权。 */
  currentUserRequest?: string;
  /** 文件修改成功后回调，传入已经校验的绝对路径供产物索引使用。 */
  onFileWritten?: (input: {
    absolutePath: string;
    tool: 'write' | 'edit';
  }) => Promise<void> | void;
  /** 汇报读取路径的归类结果，不包含目标路径或文件内容。 */
  onFileReadResolution?: (report: ReadResolutionReport) => void;
  /** 汇报文件操作失败，不暴露请求路径或文件内容。 */
  onFileOperationFailed?: (input: {
    toolName: 'read' | 'edit' | 'write';
    operation: 'access' | 'readFile' | 'detectImageMimeType' | 'mkdir' | 'writeFile';
    pathScope: 'workspace' | 'external' | 'invalid';
    elapsedMs: number;
    error: unknown;
  }) => void;
}

/** 一次读取路径解析的可能结果。 */
export type ReadResolutionOutcome =
  | 'resolved'
  | 'invalid_path'
  | 'path_unavailable'
  | 'not_a_file'
  | 'managed_file_denied';

/** 读取路径解析的安全摘要，不包含具体路径。 */
export interface ReadResolutionReport {
  outcome: ReadResolutionOutcome;
  /** 目标位于工作区内、外，还是输入本身无效。 */
  pathScope: 'workspace' | 'external' | 'invalid';
  /** 本次解析适用的应用托管路径数量。 */
  protectedPathCount: number;
  elapsedMs: number;
}
