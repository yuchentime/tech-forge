import { Injectable, Logger } from '@nestjs/common';
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { DocumentParserService } from '../platform/document-parser/document-parser.service';
import { isDocumentParserError } from '../platform/document-parser/document-parser.types';
import { SettingsService } from '../settings/settings.service';

/** Extracted text written beside every stored attachment. */
const TEXT_FILE_NAME = 'text.md';

/** One attachment as the renderer names it in a send request. */
export interface ChatAttachmentInput {
  attachmentId: string;
  path: string;
}

/** The extracted text of one attachment, ready for the prompt. */
export interface AttachmentContent extends ChatAttachmentInput {
  name: string;
  text: string;
}

/** One attachment that could not be read, with the reason the model is told about. */
export interface AttachmentFailure extends ChatAttachmentInput {
  name: string;
  reason: 'missing' | 'unsupported' | 'unreadable';
}

/** Attachment reference persisted on the user message for the chat bubble and later turns. */
export interface AttachmentRef {
  attachmentId: string;
  name: string;
  /** Characters of extracted text; 0 when the file could not be read. */
  characters: number;
}

/** Outcome of storing one message's attachments. */
export interface StoredAttachments {
  contents: AttachmentContent[];
  failures: AttachmentFailure[];
  /** Every requested attachment, in request order, for history and UI display. */
  refs: AttachmentRef[];
}

/**
 * Owns chat attachments: a per-conversation copy plus its extracted text.
 *
 * Deliberately not a knowledge-library document: an attachment is used once, by the message that
 * carries it, so it keeps no chunks, no index and no sharing rules. Files land in
 * `<configDir>/sessions/<conversationId>/attachments/<attachmentId>/`, which is why the copy happens
 * when the message is sent — a new conversation has no id before that.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  /** Injects the config paths and the platform parser adapter. */
  constructor(
    private readonly settings: SettingsService,
    private readonly parser: DocumentParserService,
  ) {}

  /**
   * Copies the attachments of one message into its conversation and extracts their text.
   *
   * Failures are per attachment and never throw: a scanned PDF must not cost the user the whole
   * turn, so the model is told which file could not be read instead.
   */
  async storeForConversation(
    conversationId: string,
    attachments: readonly ChatAttachmentInput[],
  ): Promise<StoredAttachments> {
    const root = join(
      this.settings.getSessionsDirectory(),
      conversationId,
      'attachments',
    );
    const contents: AttachmentContent[] = [];
    const failures: AttachmentFailure[] = [];
    const refs: AttachmentRef[] = [];

    for (const attachment of attachments) {
      const name = basename(attachment.path);
      const ref = { attachmentId: attachment.attachmentId, name, characters: 0 };
      refs.push(ref);

      if (!this.parser.supportsFile(name)) {
        failures.push({ ...attachment, name, reason: 'unsupported' });
        continue;
      }
      if (!isAbsolute(attachment.path) || !isReadableFile(attachment.path)) {
        failures.push({ ...attachment, name, reason: 'missing' });
        continue;
      }

      const directory = join(root, attachment.attachmentId);
      const storedPath = join(directory, name);
      try {
        mkdirSync(directory, { recursive: true });
        copyFileSync(attachment.path, storedPath);
      } catch (error) {
        this.logger.warn(
          `attachments.file.copy_failed ${JSON.stringify({
            attachmentId: attachment.attachmentId,
            detail: describeDetail(error),
          })}`,
        );
        failures.push({ ...attachment, name, reason: 'unreadable' });
        continue;
      }

      try {
        const parsed = await this.parser.parse({
          inputPath: storedPath,
          originalName: name,
        });
        // The text is kept on disk so later turns can page through it with `read`/`grep`;
        // only the first part fits into that turn's prompt.
        writeFileSync(join(directory, TEXT_FILE_NAME), parsed.text, 'utf8');
        ref.characters = Array.from(parsed.text).length;
        contents.push({ ...attachment, name, text: parsed.text });
        this.logger.log(
          `attachments.file.stored ${JSON.stringify({
            attachmentId: attachment.attachmentId,
            characters: parsed.text.length,
          })}`,
        );
      } catch (error) {
        this.logger.warn(
          `attachments.file.parse_failed ${JSON.stringify({
            attachmentId: attachment.attachmentId,
            code: isDocumentParserError(error) ? error.code : 'PARSE_FAILED',
            detail: describeDetail(error),
          })}`,
        );
        failures.push({ ...attachment, name, reason: 'unreadable' });
      }
    }

    return { contents, failures, refs };
  }

  /**
   * Absolute path of one attachment's extracted text.
   *
   * Later turns receive this path: the injected prefix is all the model sees by default, and
   * `read`/`grep` need a concrete file to continue from.
   */
  textFilePath(conversationId: string, attachmentId: string): string {
    return join(
      this.settings.getSessionDirectory(conversationId),
      'attachments',
      attachmentId,
      TEXT_FILE_NAME,
    );
  }
}

/** Reports whether a path is an existing regular file. */
function isReadableFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Technical detail for logs; never shown as the primary message. */
function describeDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
