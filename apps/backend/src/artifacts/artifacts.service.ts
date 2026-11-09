import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DataSource, type Repository } from 'typeorm';
import { ArtifactEntity } from './artifact.entity';
import { SettingsService } from '../settings/settings.service';
import type {
  ArtifactContentDto,
  ArtifactLocationDto,
  ArtifactSummaryDto,
} from './artifacts.dto';
import { getSafeErrorLogFields, writeStructuredEvent } from '../logging/structured-logger';

/** Preview cap; larger files return their head with `truncated` set. */
const MAX_PREVIEW_BYTES = 512 * 1024;

/** Content hashing stops here so one huge write cannot stall a turn. */
const MAX_HASH_BYTES = 2 * 1024 * 1024;

/** Bytes inspected for NUL characters when deciding whether a file is text. */
const BINARY_SNIFF_BYTES = 4096;

/** Path kind for files written below the session workspace. */
const PATH_KIND_SESSION = 'session';

/** Path kind for a destination the user named explicitly. */
const PATH_KIND_EXTERNAL = 'external';

/** Preview families keyed by lower-case extension. */
const CONTENT_FORMATS: Readonly<Record<string, { format: string; mimeType: string }>> = {
  '.md': { format: 'markdown', mimeType: 'text/markdown' },
  '.markdown': { format: 'markdown', mimeType: 'text/markdown' },
  '.mmd': { format: 'mermaid', mimeType: 'text/plain' },
  '.svg': { format: 'svg', mimeType: 'image/svg+xml' },
  '.json': { format: 'json', mimeType: 'application/json' },
  '.jsonl': { format: 'jsonl', mimeType: 'application/x-ndjson' },
  '.ndjson': { format: 'jsonl', mimeType: 'application/x-ndjson' },
  '.txt': { format: 'text', mimeType: 'text/plain' },
  '.csv': { format: 'text', mimeType: 'text/csv' },
  '.log': { format: 'text', mimeType: 'text/plain' },
  '.yml': { format: 'text', mimeType: 'text/plain' },
  '.yaml': { format: 'text', mimeType: 'text/plain' },
};

/** Describes one file the Agent created or modified, as reported by the file tools. */
export interface ArtifactWriteInput {
  conversationId: string;
  userMessageId: string | null;
  absolutePath: string;
}

/**
 * Owns the artifact index: one row per file the Agent wrote, the preview text behind each row, and
 * the on-disk location the desktop shell reveals.
 *
 * Rows are keyed by the conversation plus a root-relative path, so a relocated configuration
 * directory keeps working; only files the user moved individually go missing.
 */
@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);
  private readonly artifacts: Repository<ArtifactEntity>;

  /** Injects the repository and the settings owner of the session directory layout. */
  constructor(
    dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {
    this.artifacts = dataSource.getRepository(ArtifactEntity);
  }

  /**
   * Records one successful write or edit.
   *
   * Failures are logged and swallowed: an artifact index problem must never turn a completed file
   * write into a failed tool call for the model.
   */
  async registerArtifact(input: ArtifactWriteInput): Promise<ArtifactSummaryDto | undefined> {
    try {
      const absolutePath = resolve(input.absolutePath);
      const workspaceRoot = this.settings.getSessionWorkspaceDirectory(input.conversationId);
      const insideWorkspace = isPathWithin(workspaceRoot, absolutePath);
      const relativePath = insideWorkspace
        ? relative(workspaceRoot, absolutePath).split(sep).join('/')
        : '';
      const pathKind = insideWorkspace ? PATH_KIND_SESSION : PATH_KIND_EXTERNAL;
      const fileName = basename(absolutePath);
      const format = resolveContentFormat(fileName);
      const fileInfo = readFileInfo(absolutePath);

      const existing = await this.artifacts.findOneBy({
        conversationId: input.conversationId,
        pathKind,
        relativePath,
        absolutePath: insideWorkspace ? '' : absolutePath,
      });
      const row: ArtifactEntity = existing ?? this.artifacts.create({
        id: randomUUID(),
        conversationId: input.conversationId,
        pathKind,
        relativePath,
        absolutePath: insideWorkspace ? '' : absolutePath,
        createdAt: new Date(),
      });
      row.userMessageId = input.userMessageId;
      row.fileName = fileName;
      row.contentFormat = format.format;
      row.mimeType = format.mimeType;
      row.byteSize = fileInfo.byteSize;
      row.fileHash = fileInfo.fileHash;
      row.updatedAt = new Date();
      // Saving the loaded entity keeps the row id stable across rewrites, so open tabs stay valid.
      const saved = await this.artifacts.save(row);

      writeStructuredEvent(this.logger, 'log', 'artifacts.register.completed', {
        conversationId: input.conversationId,
        artifactId: saved.id,
        pathKind,
        contentFormat: saved.contentFormat,
        byteSize: saved.byteSize,
        existed: Boolean(existing),
      });
      return this.toSummary(saved);
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'artifacts.register.failed', {
        conversationId: input.conversationId,
        ...getSafeErrorLogFields(error),
      });
      return undefined;
    }
  }

  /** Lists one conversation's artifacts, optionally narrowed to a single turn. */
  async listArtifacts(
    conversationId: string,
    options: { userMessageId?: string } = {},
  ): Promise<ArtifactSummaryDto[]> {
    const rows = await this.artifacts.find({
      where: {
        conversationId,
        ...(options.userMessageId ? { userMessageId: options.userMessageId } : {}),
      },
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => this.toSummary(row));
  }

  /** Groups artifacts by turn so the history projection can attach them to one message. */
  async listByUserMessageIds(
    conversationId: string,
    userMessageIds: readonly string[],
  ): Promise<Map<string, ArtifactSummaryDto[]>> {
    const grouped = new Map<string, ArtifactSummaryDto[]>();
    if (userMessageIds.length === 0) return grouped;
    const rows = await this.artifacts.find({
      where: userMessageIds.map((userMessageId) => ({ conversationId, userMessageId })),
      order: { createdAt: 'ASC' },
    });
    for (const row of rows) {
      if (!row.userMessageId) continue;
      const list = grouped.get(row.userMessageId) ?? [];
      list.push(this.toSummary(row));
      grouped.set(row.userMessageId, list);
    }
    return grouped;
  }

  /**
   * Removes one artifact index row.
   *
   * Only the index record goes away; the file on disk is never touched, because the index is a
   * record of what the conversation produced, not an owner of the user's files. Deleting a row of
   * a file that still exists only drops it from the sidebar; a later write to the same path
   * registers a fresh row.
   */
  async removeArtifact(artifactId: string): Promise<{ artifactId: string }> {
    const row = await this.getRow(artifactId);
    const absolutePath = this.resolveAbsolutePathQuietly(row);
    await this.artifacts.delete({ id: row.id });
    writeStructuredEvent(this.logger, 'log', 'artifacts.delete.completed', {
      conversationId: row.conversationId,
      artifactId: row.id,
      pathKind: row.pathKind,
      contentFormat: row.contentFormat,
      fileExists: absolutePath !== undefined && isExistingFile(absolutePath),
    });
    return { artifactId: row.id };
  }

  /** Reads the preview text of one artifact, capped and NUL-sniffed. */
  async readContent(artifactId: string): Promise<ArtifactContentDto> {
    const row = await this.getRow(artifactId);
    const absolutePath = this.resolveAbsolutePath(row);
    const fileInfo = readFileInfo(absolutePath);
    const preview = readPreview(absolutePath);
    return {
      id: row.id,
      fileName: row.fileName,
      contentFormat: row.contentFormat,
      content: preview.content,
      truncated: preview.truncated,
      binary: preview.binary,
      byteSize: fileInfo.byteSize ?? row.byteSize,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Resolves the directory and file for one artifact so the shell can reveal it. */
  async getLocation(artifactId: string): Promise<ArtifactLocationDto> {
    const row = await this.getRow(artifactId);
    const absolutePath = this.resolveAbsolutePath(row);
    const directory = dirname(absolutePath);
    return {
      directory,
      filePath: absolutePath,
      fileExists: isExistingFile(absolutePath),
      directoryExists: isExistingDirectory(directory),
    };
  }

  /** Loads one row or reports a missing artifact without leaking stored paths. */
  private async getRow(artifactId: string): Promise<ArtifactEntity> {
    const row = await this.artifacts.findOneBy({ id: artifactId });
    if (!row) throw new NotFoundException('Artifact not found.');
    return row;
  }

  /**
   * Resolves one row to an absolute path.
   *
   * Session files are rebuilt from the conversation, which is what makes a moved configuration
   * directory harmless; the resolved path is still checked to stay inside the workspace.
   */
  private resolveAbsolutePath(row: ArtifactEntity): string {
    if (row.pathKind === PATH_KIND_EXTERNAL) {
      if (!isAbsolute(row.absolutePath)) {
        throw new NotFoundException('Artifact path is not absolute.');
      }
      return row.absolutePath;
    }
    const workspaceRoot = this.settings.getSessionWorkspaceDirectory(row.conversationId);
    const absolutePath = resolve(workspaceRoot, row.relativePath);
    if (!isPathWithin(workspaceRoot, absolutePath) || absolutePath === workspaceRoot) {
      throw new NotFoundException('Artifact path is outside its workspace.');
    }
    return absolutePath;
  }

  /** Projects one row into the sidebar summary, computing the on-disk state. */
  private toSummary(row: ArtifactEntity): ArtifactSummaryDto {
    const absolutePath = this.resolveAbsolutePathQuietly(row);
    return {
      id: row.id,
      fileName: row.fileName,
      contentFormat: row.contentFormat,
      byteSize: row.byteSize,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      userMessageId: row.userMessageId,
      missing: absolutePath ? !isExistingFile(absolutePath) : true,
      external: row.pathKind === PATH_KIND_EXTERNAL,
    };
  }

  /** Returns the resolved path, or undefined when a stored row can no longer be resolved. */
  private resolveAbsolutePathQuietly(row: ArtifactEntity): string | undefined {
    try {
      return this.resolveAbsolutePath(row);
    } catch (error) {
      writeStructuredEvent(this.logger, 'warn', 'artifacts.resolve.failed', {
        artifactId: row.id,
        ...getSafeErrorLogFields(error),
      });
      return undefined;
    }
  }
}

/** Chooses the preview family and MIME type from the file name. */
function resolveContentFormat(fileName: string): { format: string; mimeType: string } {
  const known = CONTENT_FORMATS[extname(fileName).toLowerCase()];
  return known ?? { format: 'text', mimeType: 'text/plain' };
}

/** Reads size and a bounded content hash without throwing on a vanished file. */
function readFileInfo(absolutePath: string): {
  byteSize: number | null;
  fileHash: string | null;
} {
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) return { byteSize: null, fileHash: null };
    return {
      byteSize: stats.size,
      fileHash: stats.size <= MAX_HASH_BYTES ? hashFile(absolutePath) : null,
    };
  } catch {
    return { byteSize: null, fileHash: null };
  }
}

/** Hashes the file head that fits the hashing cap. */
function hashFile(absolutePath: string): string | null {
  const buffer = readBytes(absolutePath, MAX_HASH_BYTES + 1);
  if (!buffer) return null;
  return createHash('sha256').update(buffer).digest('hex');
}

/** Reads up to `limit` bytes from the start of a file, or null when it cannot be opened. */
function readBytes(absolutePath: string, limit: number): Buffer | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(limit);
    const bytesRead = readSync(descriptor, buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close must not hide the read result.
      }
    }
  }
}

/** Reads one bounded preview and decides whether the content is previewable text. */
function readPreview(absolutePath: string): {
  content: string;
  truncated: boolean;
  binary: boolean;
} {
  const buffer = readBytes(absolutePath, MAX_PREVIEW_BYTES + 1);
  if (!buffer) return { content: '', truncated: false, binary: false };
  const truncated = buffer.length > MAX_PREVIEW_BYTES;
  const head = truncated ? buffer.subarray(0, MAX_PREVIEW_BYTES) : buffer;
  const sniffed = head.subarray(0, BINARY_SNIFF_BYTES);
  if (sniffed.includes(0)) {
    return { content: '', truncated, binary: true };
  }
  // Cutting mid-codepoint leaves one replacement character; it is only a preview.
  return { content: head.toString('utf8'), truncated, binary: false };
}

/** Reports whether the path exists as a regular file. */
function isExistingFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** Reports whether the path exists as a directory. */
function isExistingDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

/** Checks that a resolved path stays inside the workspace root. */
function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
