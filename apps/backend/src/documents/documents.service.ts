import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { DocumentParserService } from '../platform/document-parser/document-parser.service';
import { resolveTeachForgeDataDirectory } from '../platform/local-paths';
import { EmbeddingService } from '../embedding/embedding.service';
import { SettingsService } from '../settings/settings.service';
import {
  isDocumentParserError,
  type ParseDocumentResult,
} from '../platform/document-parser/document-parser.types';
import {
  chunkDocument,
  DocumentChunkLimitError,
  joinParsedPages,
  type DocumentChunk,
} from './chunking/document-chunker';
import { getChunkTokenCounter } from './chunking/token-counter';
import { toSearchTerms } from '../retrieval/text-normalizer';
import { ConversationDocumentEntity } from './conversation-document.entity';
import { DocumentChunkEntity } from './document-chunk.entity';
import { DocumentVersionEntity } from './document-version.entity';
import { DocumentEntity } from './document.entity';
import { DocumentCatalogIndexService, DocumentCatalogService } from './document-catalog.service';

/** Storage root for copied source files; defaults to the backend data directory. */
export const DOCUMENTS_STORAGE_ROOT = 'DOCUMENTS_STORAGE_ROOT';

/**
 * Lifecycle values written to `document_versions.processingStatus`.
 *
 * `indexed` means chunks and their lexical index rows are committed, so the content is findable by
 * full-text search. `ready` means dense vectors are committed too. A version that fails only during
 * embedding stays at `indexed`: the content remains usable and can be re-embedded later.
 */
export type DocumentProcessingStatus = 'parsing' | 'cataloging' | 'chunking' | 'indexed' | 'ready' | 'failed';

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

/** Outcome of importing one file from disk into the knowledge library. */
export interface ImportDocumentResult extends IngestDocumentResult {
  /**
   * Absolute path of the retained copy under the app-owned knowledge root (never the Agent
   * workspace); null when nothing was copied.
   */
  storedPath: string | null;
}

/** Outcome of one deletion, including whether both file copies could be removed. */
export interface DeleteDocumentResult {
  /** `partial` means the rows are gone but at least one file copy could not be removed. */
  fileCleanup: 'complete' | 'partial';
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
    byteSize: number | null;
    createdAt: Date;
    processingError: string | null;
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
 * the platform parser, chunking, and persisting chunks inside one transaction. Also owns the
 * knowledge-library use cases that wrap ingest: importing a picked file through the Agent workspace
 * and deleting a document together with every derived row and file copy. Index building and
 * retrieval are separate business lines and are not implemented here.
 */
@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly storageRoot: string;
  /** Serialises imports and deletions so heavy CPU work and SQLite writes never interleave. */
  private libraryQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(DocumentVersionEntity)
    private readonly versions: Repository<DocumentVersionEntity>,
    @InjectRepository(DocumentChunkEntity)
    private readonly chunks: Repository<DocumentChunkEntity>,
    private readonly dataSource: DataSource,
    private readonly parser: DocumentParserService,
    private readonly embeddings: EmbeddingService,
    private readonly settings: SettingsService,
    private readonly catalog: DocumentCatalogService,
    private readonly catalogIndex: DocumentCatalogIndexService,
    @Optional() @Inject(DOCUMENTS_STORAGE_ROOT) storageRoot?: string,
  ) {
    this.storageRoot = storageRoot ?? this.settings.getKnowledgeDirectory();
  }

  /**
   * Relocates a legacy `<workspace>/knowledge` directory out of the Agent workspace.
   *
   * Earlier builds stored the retained copies inside the workspace, where a default `grep` could read
   * the uploaded originals. The move is best-effort and never destructive: an existing target wins,
   * and a failure is logged because imports already write to the new location.
   *
   * The catalog is then created when the install has never written one. Sessions are told to read
   * `knowledge/index.md`, but the index used to appear only after an import, so a fresh install
   * answered that read with ENOENT.
   */
  async onModuleInit(): Promise<void> {
    await this.migrateLegacyKnowledgeDirectory();
    await this.ensureKnowledgeCatalog();
  }

  /** Moves a pre-2026-11-09 upload directory out of the Agent workspace, once. */
  private async migrateLegacyKnowledgeDirectory(): Promise<void> {
    try {
      const legacyDirectory = join(await this.settings.getWorkspacePath(), 'knowledge');
      const targetDirectory = this.settings.getKnowledgeDirectory();
      if (!existsSync(legacyDirectory) || existsSync(targetDirectory)) return;
      mkdirSync(dirname(targetDirectory), { recursive: true });
      renameSync(legacyDirectory, targetDirectory);
      this.logger.log(
        `documents.knowledge_dir.migrated ${JSON.stringify({
          from: legacyDirectory,
          to: targetDirectory,
        })}`,
      );
    } catch (error) {
      this.logger.warn(
        `documents.knowledge_dir.migrate_failed ${JSON.stringify({ detail: describeDetail(error) })}`,
      );
    }
  }

  /**
   * Writes the catalog index when this install has none.
   *
   * The file is rebuilt from the database, never parsed from the previous file, so an install that
   * already imported documents recovers its catalog instead of getting an empty placeholder. A
   * failure only warns: the backend must start even when the knowledge directory is read-only.
   */
  private async ensureKnowledgeCatalog(): Promise<void> {
    if (existsSync(this.settings.getKnowledgeCatalogPath())) return;
    try {
      await this.rebuildCatalogIndex();
      this.logger.log('documents.knowledge_catalog.created');
    } catch (error) {
      this.logger.warn(
        `documents.knowledge_catalog.create_failed ${JSON.stringify({ detail: describeDetail(error) })}`,
      );
    }
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

    // The converted text is kept next to the source copy so the user (and a user-directed `read`)
    // can open what the model actually sees. Failure is a warning: the rows are still searchable.
    let convertedMarkdownWarning: { code: string; message: string } | undefined;
    try {
      this.writeConvertedMarkdown(document.id, versionNo, originalName, parsed.pages);
    } catch (error) {
      convertedMarkdownWarning = {
        code: 'CONVERTED_MARKDOWN_FAILED',
        message: '转换后的 Markdown 没能保存，资料本身仍然可以检索。',
      };
      this.logger.warn(
        `documents.ingest.converted_markdown_failed ${JSON.stringify({
          documentId: document.id,
          versionNo,
          detail: describeDetail(error),
        })}`,
      );
    }

    await this.updateStatus(version.id, 'cataloging');
    let summary;
    try {
      summary = await this.catalog.summarize(document.title, joinParsedPages(parsed.pages));
    } catch (error) {
      await this.versions.update(version.id, {
        processingStatus: 'failed',
        processingError: null,
        catalogStatus: 'failed',
        catalogError: describeError(error).slice(0, 1000),
      });
      return {
        documentId: document.id,
        documentVersionId: version.id,
        versionNo,
        chunkCount: 0,
        status: 'failed',
        duplicate: false,
        warnings: [
          ...parsed.warnings.map((warning) => ({ code: String(warning.code), message: warning.message })),
          { code: 'CATALOG_FAILED', message: '资料已保存，但目录摘要生成失败，可在资料库中重试。' },
        ],
      };
    }
    await this.versions.update(version.id, {
      processingStatus: 'ready', processingError: null, catalogStatus: 'ready',
      catalogSummary: summary.summary, catalogKeywordsJson: JSON.stringify(summary.keywords),
      catalogDocumentType: summary.documentType, catalogError: null, catalogedAt: new Date(),
    });
    await this.rebuildCatalogIndex();

    const warnings = parsed.warnings.map((warning) => ({ code: String(warning.code), message: warning.message }));
    if (convertedMarkdownWarning) warnings.push(convertedMarkdownWarning);

    return {
      documentId: document.id,
      documentVersionId: version.id,
      versionNo,
      chunkCount: 0,
      status: 'ready',
      duplicate: false,
      warnings,
    };
  }

  /**
   * Imports one picked local file into the knowledge library.
   *
   * The bytes are first written to `<workspace>/knowledge/.importing/<uuid>/` so the upload lives in
   * the configured Agent workspace, then ingest runs on that copy. A duplicate or failed ingest
   * removes the staging directory, and a successful ingest renames it to the document id so deletion
   * can locate the copy without extra bookkeeping.
   *
   * Failures split in two: anything that stops the import (unreadable source, unsupported format,
   * unwritable workspace, parse/chunk error) is thrown with user-facing Chinese copy and logged;
   * a failure to keep the upload copy after a successful ingest degrades to a warning because the
   * indexed content is already usable.
   */
  async importFromPath(input: { filePath: string; title?: string }): Promise<ImportDocumentResult> {
    return this.runExclusive(async () => {
      const sourcePath = this.validateInput({ filePath: input.filePath });
      const originalName = basename(sourcePath);
      if (!this.parser.supportsFile(originalName)) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'UNSUPPORTED_FILE_TYPE',
          message: `这种文件暂时不能导入（${extname(originalName) || '无扩展名'}）。支持 PDF、Word（.docx）、Markdown（.md）和 TXT。`,
        });
      }

      try {
        this.assertReadable(sourcePath);
      } catch (error) {
        this.logger.warn(
          `documents.import.source_unreadable ${JSON.stringify({ detail: describeDetail(error) })}`,
        );
        throw new BadRequestException({
          statusCode: 400,
          code: 'SOURCE_UNREADABLE',
          message: '无法读取所选文件，它可能已被移动、重命名或删除，请重新选择。',
          detail: describeDetail(error),
        });
      }

      let result: IngestDocumentResult;
      try {
        result = await this.ingestFile({
          // The canonical versioned copy is written by ingestFile. Keeping a second promoted
          // upload copy at `<knowledge>/<documentId>` made delete and directory routing ambiguous.
          filePath: sourcePath,
          title: input.title,
          isShared: true,
        });
      } catch (error) {
        // Parse and chunk failures are about the file's content, so surface the reason instead of
        // the generic 500 the default exception filter would return.
        if (error instanceof HttpException) throw error;
        const failure = describeIngestFailure(error);
        this.logger.warn(
          `documents.import.failed ${JSON.stringify({ code: failure.code, detail: failure.detail })}`,
        );
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: failure.code,
          message: failure.message,
          detail: failure.detail,
        });
      }

      if (result.duplicate) {
        return { ...result, storedPath: null };
      }
      return {
        ...result,
        storedPath: join(
          this.settings.getKnowledgeDirectory(),
          'documents',
          result.documentId,
          `v${result.versionNo}`,
          originalName,
        ),
      };
    });
  }

  /**
   * Deletes one document and everything derived from it.
   *
   * Rows are removed in one transaction in foreign-key and FTS-trigger order, then both file copies
   * are removed after commit. A document that is still parsing or chunking is refused, because its
   * ingest would keep writing rows for a document that no longer exists. A file that cannot be
   * removed is reported as `partial` cleanup instead of being ignored.
   */
  async deleteDocument(documentId: string): Promise<DeleteDocumentResult> {
    return this.runExclusive(async () => {
      const document = await this.requireDocument(documentId);
      const versions = await this.versions.find({ where: { documentId } });
      const isProcessing = versions.some(
        (version) =>
          version.processingStatus === 'parsing' || version.processingStatus === 'chunking',
      );
      if (isProcessing) {
        throw new ConflictException({
          statusCode: 409,
          code: 'DOCUMENT_PROCESSING',
          message: '这份资料还在处理中，等处理完再删除。',
        });
      }

      await this.dataSource.transaction(async (manager) => {
        // `chunk_embeddings` has no foreign key, so an untouched row would stay retrievable.
        await manager.query('DELETE FROM "chunk_embeddings" WHERE "documentId" = ?', [documentId]);
        // Deleting the term stream first lets the AFTER DELETE triggers keep `chunk_fts` in sync.
        await manager.query(
          `DELETE FROM "chunk_search_terms" WHERE "chunkId" IN (
             SELECT "id" FROM "document_chunks"
              WHERE "documentVersionId" IN (
                SELECT "id" FROM "document_versions" WHERE "documentId" = ?))`,
          [documentId],
        );
        await manager.query(
          `DELETE FROM "document_chunks" WHERE "documentVersionId" IN (
             SELECT "id" FROM "document_versions" WHERE "documentId" = ?)`,
          [documentId],
        );
        await manager.delete(DocumentVersionEntity, { documentId });
        await manager.delete(ConversationDocumentEntity, { documentId });
        await manager.delete(DocumentEntity, { id: document.id });
      });
      // The directory is a projection, so rebuilding after the short DB transaction prevents a
      // deleted document from remaining Agent-readable even when file cleanup is partial.
      await this.rebuildCatalogIndex();

      const storageCopyRemoved = this.removeDirectory(
        join(this.storageRoot, 'documents', documentId),
        'delete_storage_copy',
      );
      const knowledgeCopyRemoved = this.removeDirectory(
        join(this.settings.getKnowledgeDirectory(), documentId),
        'delete_knowledge_copy',
      );

      return {
        fileCleanup:
          storageCopyRemoved && knowledgeCopyRemoved ? 'complete' : ('partial' as const),
      };
    });
  }

  /**
   * Removes one managed directory tree.
   *
   * Cleanup runs after the database commit, so a failure must not turn a successful operation into
   * an error; it is logged and reported to the caller instead of disappearing.
   */
  private removeDirectory(directoryPath: string, reason: string): boolean {
    try {
      rmSync(directoryPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      this.logger.warn(
        `documents.file.cleanup_failed ${JSON.stringify({
          reason,
          path: directoryPath,
          detail: describeDetail(error),
        })}`,
      );
      return false;
    }
  }

  /** Rebuilds the catalog only from latest ready versions; index.md is never the source of truth. */
  private async rebuildCatalogIndex(): Promise<void> {
    const documents = await this.documents.find();
    const versions = await this.versions.find({ order: { versionNo: 'DESC' } });
    const latest = new Map<string, DocumentVersionEntity>();
    for (const version of versions) {
      if (!latest.has(version.documentId)) latest.set(version.documentId, version);
    }
    await this.catalogIndex.rebuild(
      documents.flatMap((document) => {
        const version = latest.get(document.id);
        return version?.catalogStatus === 'ready' ? [{ document, version }] : [];
      }),
    );
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
              byteSize: latest.byteSize,
              createdAt: latest.createdAt,
              processingError: latest.processingError,
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
            byteSize: latest.byteSize,
            createdAt: latest.createdAt,
            processingError: latest.processingError,
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

  /**
   * Resolves which documents this conversation may search.
   *
   * An explicit per-conversation selection wins: once the user pins documents to a conversation, the
   * knowledge command searches only those, otherwise pinning would be a no-op on a single-library
   * install where every imported document is shared. With no explicit selection, scope is the
   * documents linked to the conversation plus every shared document, falling back to the whole
   * library when nothing is linked.
   */
  async resolveKnowledgeScope(
    conversationId: string,
    explicitDocumentIds?: readonly string[],
  ): Promise<string[]> {
    if (explicitDocumentIds && explicitDocumentIds.length > 0) {
      const selected = await this.documents.find({
        where: { id: In([...new Set(explicitDocumentIds)]) },
      });
      return selected.map((document) => document.id);
    }

    const linked = await this.dataSource
      .getRepository(ConversationDocumentEntity)
      .find({ where: { conversationId } });
    const shared = await this.documents.find({ where: { isShared: true } });
    const ids = new Set(shared.map((document) => document.id));
    for (const row of linked) ids.add(row.documentId);
    if (ids.size === 0) {
      for (const document of await this.documents.find()) ids.add(document.id);
    }
    return [...ids];
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
    if (!existing) throw new NotFoundException('没有找到这份资料，它可能已经被删除。');
    return existing;
  }

  /** Rejects relative or empty input paths before touching storage. */
  private validateInput(input: IngestDocumentInput): string {
    if (!input || typeof input.filePath !== 'string' || input.filePath.trim() === '') {
      throw new BadRequestException('没有选择要导入的文件。');
    }
    if (!isAbsolute(input.filePath)) {
      throw new BadRequestException('文件地址不完整，请重新选择文件。');
    }
    return input.filePath;
  }

  /** Ensures the path is a regular, readable file. */
  private assertReadable(filePath: string): number {
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new BadRequestException('选择的不是一个文件，请重新选择。');
    return stats.size;
  }

  /** Runs one library mutation after the previous one settled, serialising CPU and write load. */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.libraryQueue.then(task, task);
    this.libraryQueue = run.catch(() => undefined);
    return run;
  }

  /** Uses the file bytes as the idempotency key for repeated ingest runs. */
  private hashFile(filePath: string): string {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  }

  /**
   * Writes the parsed text of a converted format as Markdown beside the stored source copy.
   *
   * Formats that are already their own readable form (`.md`, `.txt`) are skipped: the stored source
   * file *is* the text, and duplicating it would create a second copy that can drift. The file uses
   * `joinParsedPages`, the same assembly as the chunker, so chunk offsets remain valid against it.
   */
  private writeConvertedMarkdown(
    documentId: string,
    versionNo: number,
    originalName: string,
    pages: ParseDocumentResult['pages'],
  ): void {
    const extension = extname(originalName).toLowerCase();
    if (extension === '.md' || extension === '.markdown' || extension === '.txt') return;
    const targetDirectory = join(this.storageRoot, 'documents', documentId, `v${versionNo}`);
    mkdirSync(targetDirectory, { recursive: true });
    const baseName = basename(originalName, extname(originalName)) || 'parsed';
    writeFileSync(join(targetDirectory, `${baseName}.md`), joinParsedPages(pages), 'utf8');
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

  /**
   * Writes chunks plus their lexical index rows and flips the version to `indexed` atomically.
   *
   * Returns the created chunk identities so the caller can embed exactly the committed content.
   */
  private async persistChunks(
    documentVersionId: string,
    chunks: DocumentChunk[],
    documentTitle: string,
  ): Promise<Array<{ chunkId: string; content: string }>> {
    const persisted: Array<{ chunkId: string; content: string }> = [];
    await this.dataSource.transaction(async (manager) => {
      const terms: Array<{ chunkId: string; heading: string; body: string }> = [];
      for (let offset = 0; offset < chunks.length; offset += CHUNK_INSERT_BATCH) {
        const batch = chunks.slice(offset, offset + CHUNK_INSERT_BATCH).map((chunk) => {
          const id = randomUUID();
          persisted.push({ chunkId: id, content: chunk.content });
          terms.push({
            chunkId: id,
            // The document title indexes as the top-level heading of every chunk. Without it a
            // question naming the document ("EDMA", "LLM4LB") cannot find its own chunks: the
            // body of an English paper does not contain the Chinese question words, and the
            // handbook that does contain them wins on term count.
            heading: toSearchTerms([documentTitle, ...chunk.locator.headingPath].join(' ')),
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
    return persisted;
  }

  /** Stores dense vectors for the active model in one transaction. */
  private async persistVectors(
    documentId: string,
    documentVersionId: string,
    rows: Array<{ chunkId: string; vector: Float32Array }>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      for (let offset = 0; offset < rows.length; offset += CHUNK_INSERT_BATCH) {
        const batch = rows.slice(offset, offset + CHUNK_INSERT_BATCH);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const parameters = batch.flatMap((row) => [
          row.chunkId,
          documentId,
          documentVersionId,
          this.embeddings.modelId,
          this.embeddings.dimension,
          Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength),
        ]);
        await manager.query(
          `INSERT INTO "chunk_embeddings"
             ("chunkId", "documentId", "documentVersionId", "embeddingModel", "embeddingDim", "vector")
           VALUES ${placeholders}`,
          parameters,
        );
      }
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

  /** Records an embedding failure without downgrading the committed lexical index. */
  private async versionRepositoryErrorNote(
    documentVersionId: string,
    message: string,
  ): Promise<void> {
    await this.versions.update(documentVersionId, {
      processingStatus: 'indexed',
      processingError: `EMBEDDING_FAILED: ${message}`.slice(0, 1000),
    });
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

/** Technical detail for logs and API payloads; never shown as the primary message. */
function describeDetail(error: unknown): string {
  if (isDocumentParserError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof DocumentChunkLimitError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** User-facing copy plus the technical detail for one ingest failure. */
function describeIngestFailure(error: unknown): {
  message: string;
  code: string;
  detail: string;
} {
  if (isDocumentParserError(error)) {
    const detail = `${error.code}: ${error.message}`;
    switch (error.code) {
      case 'NO_TEXT_LAYER':
        return {
          message:
            '这份 PDF 里没有可以读取的文字，可能是扫描件或图片。可以换成带文字的 PDF，或者改用 Word / Markdown / TXT 文件。',
          code: error.code,
          detail,
        };
      case 'UNSUPPORTED_FORMAT':
        return {
          message: '文件内容和扩展名对不上，可能已经损坏。请用原软件重新另存后再试。',
          code: error.code,
          detail,
        };
      case 'INVALID_INPUT_FILE':
        return {
          message: '无法读取这份文件，请确认它仍然存在并且可以打开。',
          code: error.code,
          detail,
        };
      case 'FILE_TOO_LARGE':
        return {
          message: '这份文件太大，暂时无法导入，请拆分后再试。',
          code: error.code,
          detail,
        };
      case 'PARSER_TIMEOUT':
      case 'PARSER_CANCELLED':
        return {
          message: '处理这份资料时超时或被中断，请稍后重试。',
          code: error.code,
          detail,
        };
      case 'EMPTY_PARSE_RESULT':
        return {
          message: '这份资料里没有找到可以读取的文字，请换一份文件。',
          code: error.code,
          detail,
        };
      default:
        return {
          message: '这份资料没能读取成功，请确认文件没有损坏，或换一种格式。',
          code: error.code,
          detail,
        };
    }
  }

  if (error instanceof DocumentChunkLimitError) {
    return {
      message: '这份资料内容太多，一次处理不了，请拆分后再导入。',
      code: error.code,
      detail: `${error.code}: ${error.message}`,
    };
  }

  return {
    message: '处理这份资料时出错了，请稍后重试。',
    code: 'IMPORT_FAILED',
    detail: describeDetail(error),
  };
}
