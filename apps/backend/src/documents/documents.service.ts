import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { DocumentParserService } from '../platform/document-parser/document-parser.service';
import {
  isDocumentParserError,
  type ParseDocumentResult,
} from '../platform/document-parser/document-parser.types';
import { chunkDocument, DocumentChunkLimitError, type DocumentChunk } from './chunking/document-chunker';
import { getChunkTokenCounter } from './chunking/token-counter';
import { toSearchTerms } from '../retrieval/text-normalizer';
import { DocumentChunkEntity } from './document-chunk.entity';
import { DocumentVersionEntity } from './document-version.entity';
import { DocumentEntity } from './document.entity';

/** Storage root for copied source files; defaults to the backend data directory. */
export const DOCUMENTS_STORAGE_ROOT = 'DOCUMENTS_STORAGE_ROOT';

/**
 * Lifecycle values written to `document_versions.processingStatus`.
 *
 * `indexed` means the source text is split into persisted chunks and their lexical index rows are
 * written in the same transaction, so the content is findable by full-text search. Vector indexing
 * will add a further state once the embedding business line lands.
 */
export type DocumentProcessingStatus = 'parsing' | 'chunking' | 'indexed' | 'failed';

/** Caller input for one ingest run: a complete local file path, plus an optional target document. */
export interface IngestDocumentInput {
  filePath: string;
  /** Appends a new version to an existing document instead of creating a new one. */
  documentId?: string;
  title?: string;
  isShared?: boolean;
  signal?: AbortSignal;
}

/** Outcome of one ingest run. */
export interface IngestDocumentResult {
  documentId: string;
  documentVersionId: string;
  versionNo: number;
  chunkCount: number;
  status: DocumentProcessingStatus;
  duplicate: boolean;
  warnings: Array<{ code: string; message: string }>;
}

/** Read model for the document list. */
export interface DocumentSummary {
  id: string;
  title: string;
  isShared: boolean;
  versionCount: number;
  latest: {
    versionNo: number;
    status: DocumentProcessingStatus;
    originalName: string;
    chunkCount: number;
  } | null;
}

/** Read model for one document with all of its versions. */
export interface DocumentDetail extends DocumentSummary {
  versions: Array<{
    id: string;
    versionNo: number;
    status: DocumentProcessingStatus;
    originalName: string;
    byteSize: number | null;
    chunkCount: number;
    processingError: string | null;
    createdAt: Date;
  }>;
}

/** Rows inserted per statement; keeps SQLite well below its variable limit. */
const CHUNK_INSERT_BATCH = 200;

/**
 * Owns the document ingest business line: local file path in, persisted document/version/chunks out.
 *
 * Responsibilities: identity and versioning, copying the source file into managed storage, invoking
 * the platform parser, chunking, and persisting chunks inside one transaction. Index building and
 * retrieval are separate business lines and are not implemented here.
 */
@Injectable()
export class DocumentsService {
  private readonly storageRoot: string;

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(DocumentVersionEntity)
    private readonly versions: Repository<DocumentVersionEntity>,
    @InjectRepository(DocumentChunkEntity)
    private readonly chunks: Repository<DocumentChunkEntity>,
    private readonly dataSource: DataSource,
    private readonly parser: DocumentParserService,
    @Optional() @Inject(DOCUMENTS_STORAGE_ROOT) storageRoot?: string,
  ) {
    this.storageRoot = storageRoot ?? resolveDefaultStorageRoot();
  }

  /** Parses one local file and persists document, version and chunks. Idempotent per content hash. */
  async ingestFile(input: IngestDocumentInput): Promise<IngestDocumentResult> {
    const filePath = this.validateInput(input);
    const byteSize = this.assertReadable(filePath);
    const contentHash = this.hashFile(filePath);
    const originalName = basename(filePath);

    if (!this.parser.supportsFile(originalName)) {
      throw new Error(`不支持的文件类型：${extname(originalName) || '(无扩展名)'}`);
    }

    // A caller that names a document expects that document to exist; report it before the
    // content-hash shortcut, otherwise an unknown id would silently return another document's row.
    const targetDocument = input.documentId ? await this.requireDocument(input.documentId) : null;

    const duplicate = await this.versions.findOne({ where: { contentHash } });
    if (duplicate) {
      return {
        documentId: duplicate.documentId,
        documentVersionId: duplicate.id,
        versionNo: duplicate.versionNo,
        chunkCount: await this.chunks.count({ where: { documentVersionId: duplicate.id } }),
        status: duplicate.processingStatus as DocumentProcessingStatus,
        duplicate: true,
        warnings: [],
      };
    }

    const document = targetDocument ?? (await this.resolveDocument(input, originalName));
    const versionNo = ((await this.versions.maximum('versionNo', { documentId: document.id })) ?? 0) + 1;
    const version = await this.versions.save(
      this.versions.create({
        id: randomUUID(),
        documentId: document.id,
        versionNo,
        originalName,
        mimeType: guessMimeType(originalName),
        workspaceRelativePath: this.copyIntoStorage(filePath, document.id, versionNo, originalName),
        byteSize,
        contentHash,
        processingStatus: 'parsing',
        processingError: null,
      }),
    );

    let parsed: ParseDocumentResult;
    try {
      parsed = await this.parser.parse({
        inputPath: filePath,
        originalName,
        mimeType: version.mimeType,
        signal: input.signal,
      });
    } catch (error) {
      await this.markFailed(version.id, describeError(error));
      throw error;
    }

    await this.updateStatus(version.id, 'chunking');

    let chunkCount: number;
    try {
      const chunks = chunkDocument({
        pages: parsed.pages,
        warnings: parsed.warnings,
        format: parsed.format,
        countTokens: getChunkTokenCounter().count,
      });
      chunkCount = chunks.length;
      await this.persistChunks(version.id, chunks);
    } catch (error) {
      await this.markFailed(version.id, describeError(error));
      throw error;
    }

    return {
      documentId: document.id,
      documentVersionId: version.id,
      versionNo,
      chunkCount,
      status: 'indexed',
      duplicate: false,
      warnings: parsed.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    };
  }

  /** Lists documents with their latest version and chunk counts. */
  async listDocuments(): Promise<DocumentSummary[]> {
    // Personal-scale data: loading versions in one query keeps the read model free of N+1 queries
    // without introducing a view or a denormalised counter column.
    const documents = await this.documents.find({ order: { createdAt: 'DESC' } });
    const versions = await this.versions.find({ order: { versionNo: 'DESC' } });
    const chunkCounts = await this.countChunksByVersion(versions.map((version) => version.id));

    return documents.map((document) => {
      const own = versions.filter((version) => version.documentId === document.id);
      const latest = own[0];
      return {
        id: document.id,
        title: document.title,
        isShared: document.isShared,
        versionCount: own.length,
        latest: latest
          ? {
              versionNo: latest.versionNo,
              status: latest.processingStatus as DocumentProcessingStatus,
              originalName: latest.originalName,
              chunkCount: chunkCounts.get(latest.id) ?? 0,
            }
          : null,
      };
    });
  }

  /** Returns one document with every version, or null when the id is unknown. */
  async getDocumentDetail(documentId: string): Promise<DocumentDetail | null> {
    const document = await this.documents.findOne({ where: { id: documentId } });
    if (!document) return null;

    const versions = await this.versions.find({
      where: { documentId },
      order: { versionNo: 'DESC' },
    });
    const chunkCounts = await this.countChunksByVersion(versions.map((version) => version.id));
    const summaries = versions.map((version) => ({
      id: version.id,
      versionNo: version.versionNo,
      status: version.processingStatus as DocumentProcessingStatus,
      originalName: version.originalName,
      byteSize: version.byteSize,
      chunkCount: chunkCounts.get(version.id) ?? 0,
      processingError: version.processingError,
      createdAt: version.createdAt,
    }));
    const latest = summaries[0];

    return {
      id: document.id,
      title: document.title,
      isShared: document.isShared,
      versionCount: summaries.length,
      latest: latest
        ? {
            versionNo: latest.versionNo,
            status: latest.status,
            originalName: latest.originalName,
            chunkCount: latest.chunkCount,
          }
        : null,
      versions: summaries,
    };
  }

  /** Returns the persisted chunks of one version in reading order, for verification and previews. */
  async listVersionChunks(documentVersionId: string): Promise<
    Array<{ sequenceNo: number; content: string; locatorJson: string }>
  > {
    const found = await this.chunks.find({
      where: { documentVersionId },
      order: { sequenceNo: 'ASC' },
      select: { sequenceNo: true, content: true, locatorJson: true },
    });
    return found.map((chunk) => ({
      sequenceNo: chunk.sequenceNo,
      content: chunk.content,
      locatorJson: chunk.locatorJson ?? '{}',
    }));
  }

  /** Resolves the target document: an existing one when `documentId` is given, otherwise a new one. */
  private async resolveDocument(
    input: IngestDocumentInput,
    originalName: string,
  ): Promise<DocumentEntity> {
    if (input.documentId) return this.requireDocument(input.documentId);
    const title = input.title?.trim() || basename(originalName, extname(originalName));
    return this.documents.save(
      this.documents.create({ id: randomUUID(), title, isShared: input.isShared ?? false }),
    );
  }

  /** Loads one document by id or throws a caller-actionable error. */
  private async requireDocument(documentId: string): Promise<DocumentEntity> {
    const existing = await this.documents.findOne({ where: { id: documentId } });
    if (!existing) throw new Error('指定的资料不存在');
    return existing;
  }

  /** Rejects relative or empty input paths before touching storage. */
  private validateInput(input: IngestDocumentInput): string {
    if (!input || typeof input.filePath !== 'string' || input.filePath.trim() === '') {
      throw new Error('缺少本地文件路径');
    }
    if (!isAbsolute(input.filePath)) {
      throw new Error('文件路径必须是绝对路径');
    }
    return input.filePath;
  }

  /** Ensures the path is a regular, readable file. */
  private assertReadable(filePath: string): number {
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new Error('路径不是普通文件');
    return stats.size;
  }

  /** Uses the file bytes as the idempotency key for repeated ingest runs. */
  private hashFile(filePath: string): string {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  }

  /** Copies the source file under the managed storage root and returns its relative path. */
  private copyIntoStorage(
    filePath: string,
    documentId: string,
    versionNo: number,
    originalName: string,
  ): string {
    const targetDirectory = join(this.storageRoot, 'documents', documentId, `v${versionNo}`);
    mkdirSync(targetDirectory, { recursive: true });
    const targetPath = join(targetDirectory, originalName);
    copyFileSync(filePath, targetPath);
    return relative(this.storageRoot, targetPath).split(sep).join('/');
  }

  /** Writes chunks plus their lexical index rows and flips the version to `indexed` atomically. */
  private async persistChunks(documentVersionId: string, chunks: DocumentChunk[]): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const terms: Array<{ chunkId: string; heading: string; body: string }> = [];
      for (let offset = 0; offset < chunks.length; offset += CHUNK_INSERT_BATCH) {
        const batch = chunks.slice(offset, offset + CHUNK_INSERT_BATCH).map((chunk) => {
          const id = randomUUID();
          terms.push({
            chunkId: id,
            heading: toSearchTerms(chunk.locator.headingPath.join(' ')),
            body: toSearchTerms(chunk.content),
          });
          return manager.create(DocumentChunkEntity, {
            id,
            documentVersionId,
            sequenceNo: chunk.sequenceNo,
            content: chunk.content,
            locatorJson: JSON.stringify(chunk.locator),
          });
        });
        await manager.insert(DocumentChunkEntity, batch);
      }
      await this.insertSearchTerms(manager, terms);
      await manager.update(DocumentVersionEntity, documentVersionId, {
        processingStatus: 'indexed',
        processingError: null,
      });
    });
  }

  /**
   * Inserts the normalised term stream.
   *
   * `chunk_search_terms` is derived index data with no entity, so it is written with parameterised
   * SQL inside the caller's transaction; the FTS mirror is maintained by database triggers.
   */
  private async insertSearchTerms(
    manager: EntityManager,
    terms: Array<{ chunkId: string; heading: string; body: string }>,
  ): Promise<void> {
    for (let offset = 0; offset < terms.length; offset += CHUNK_INSERT_BATCH) {
      const batch = terms.slice(offset, offset + CHUNK_INSERT_BATCH);
      const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
      const parameters = batch.flatMap((term) => [term.chunkId, term.heading, term.body]);
      await manager.query(
        `INSERT INTO "chunk_search_terms" ("chunkId", "heading", "body") VALUES ${placeholders}`,
        parameters,
      );
    }
  }

  /** Counts chunks per version in one grouped query. */
  private async countChunksByVersion(
    documentVersionIds: string[],
  ): Promise<Map<string, number>> {
    if (documentVersionIds.length === 0) return new Map();
    const rows = await this.chunks
      .createQueryBuilder('chunk')
      .select('chunk.documentVersionId', 'documentVersionId')
      .addSelect('COUNT(*)', 'total')
      .where({ documentVersionId: In(documentVersionIds) })
      .groupBy('chunk.documentVersionId')
      .getRawMany<{ documentVersionId: string; total: number | string }>();
    return new Map(rows.map((row) => [row.documentVersionId, Number(row.total)]));
  }

  /** Records a terminal failure without discarding already written rows. */
  private async markFailed(documentVersionId: string, message: string): Promise<void> {
    await this.versions.update(documentVersionId, {
      processingStatus: 'failed',
      processingError: message.slice(0, 1000),
    });
  }

  /** Updates only the processing status of one version. */
  private async updateStatus(
    documentVersionId: string,
    status: DocumentProcessingStatus,
  ): Promise<void> {
    await this.versions.update(documentVersionId, { processingStatus: status });
  }
}

/** Resolves the managed storage root used when no explicit root is injected. */
function resolveDefaultStorageRoot(): string {
  return process.env.TEACHFORGE_DATA_DIR ?? join(process.cwd(), '.data');
}

/** Maps a media type from the file extension for the persisted version row. */
function guessMimeType(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    default:
      return 'text/plain';
  }
}

/** Produces a short, user-actionable failure description from a parser or chunker error. */
function describeError(error: unknown): string {
  if (isDocumentParserError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof DocumentChunkLimitError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
