import { Injectable, Logger } from '@nestjs/common';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { DocumentParserService } from '../platform/document-parser/document-parser.service';
import { isDocumentParserError } from '../platform/document-parser/document-parser.types';
import { SettingsService } from '../settings/settings.service';
import {
  getImageMimeTypeByName,
  MAX_INLINE_IMAGE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  sniffImageMimeType,
} from './image-formats';

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

/** One image attachment, base64-encoded for the provider's inline vision input. */
export interface AttachmentImage extends ChatAttachmentInput {
  name: string;
  mimeType: string;
  /** Raw base64 bytes without a data-URL prefix. */
  data: string;
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
  /** Whether the attachment provides text or vision input. */
  kind: 'text' | 'image';
  /** Characters of extracted text; 0 for images and unreadable files. */
  characters: number;
}

/** Outcome of storing one message's attachments. */
export interface StoredAttachments {
  contents: AttachmentContent[];
  images: AttachmentImage[];
  failures: AttachmentFailure[];
  /** Every requested attachment, in request order, for history and UI display. */
  refs: AttachmentRef[];
}

/**
 * Owns chat attachments: a per-conversation copy, plus the text or image the model reads.
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
   * Copies the attachments of one message into its conversation and reads their content.
   *
   * Markdown and plain text are used as stored; PDF and DOCX are converted to Markdown named after
   * the source; accepted images are base64-encoded for inline vision input. Failures are per
   * attachment and never throw: a scanned PDF must not cost the user the whole turn, so the model
   * is told which file could not be read instead.
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
    const images: AttachmentImage[] = [];
    const failures: AttachmentFailure[] = [];
    const refs: AttachmentRef[] = [];
    let imageBytes = 0;

    for (const attachment of attachments) {
      const name = basename(attachment.path);
      const imageMimeType = getImageMimeTypeByName(name);
      const ref: AttachmentRef = {
        attachmentId: attachment.attachmentId,
        name,
        kind: imageMimeType ? 'image' : 'text',
        characters: 0,
      };
      refs.push(ref);

      if (!imageMimeType && !this.parser.supportsFile(name)) {
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

      if (imageMimeType) {
        const image = this.readInlineImage(
          storedPath,
          name,
          imageMimeType,
          imageBytes,
        );
        if (!image) {
          failures.push({ ...attachment, name, reason: 'unreadable' });
          continue;
        }
        imageBytes += image.bytes;
        images.push({
          ...attachment,
          name,
          mimeType: image.mimeType,
          data: image.data,
        });
        this.logger.log(
          `attachments.file.image_stored ${JSON.stringify({
            attachmentId: attachment.attachmentId,
            mimeType: image.mimeType,
            bytes: image.bytes,
          })}`,
        );
        continue;
      }

      try {
        const parsed = await this.parser.parse({
          inputPath: storedPath,
          originalName: name,
        });
        // The text is kept on disk so later turns can page through it with `read`/`grep`;
        // only the first part fits into that turn's prompt. Markdown and plain text already are
        // readable as stored, so they keep their own file instead of a duplicate converted copy.
        // A converted document is written beside the source under the same base name.
        if (this.parser.requiresExtraction(name)) {
          const convertedName = `${basename(name, extname(name))}.md`;
          writeFileSync(join(directory, convertedName), parsed.text, 'utf8');
        }
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

    return { contents, images, failures, refs };
  }

  /**
   * Absolute path of one attachment's readable content.
   *
   * Later turns receive this path: the injected text is all the model sees by default, and
   * `read`/`grep` need a concrete file to continue from. Converted formats point at their extracted
   * Markdown; text and image files point at their own stored copy.
   */
  readableFilePath(
    conversationId: string,
    attachmentId: string,
    name: string,
  ): string {
    const fileName =
      getImageMimeTypeByName(name) || !this.parser.requiresExtraction(name)
        ? basename(name)
        : `${basename(name, extname(name))}.md`;
    return join(
      this.settings.getSessionDirectory(conversationId),
      'attachments',
      attachmentId,
      fileName,
    );
  }

  /**
   * Reads one stored image for inline vision input.
   *
   * Returns undefined (and logs why) when the content is not one of the accepted formats or when
   * this turn's base64 payload would exceed the provider's request body limit.
   */
  private readInlineImage(
    storedPath: string,
    name: string,
    declaredMimeType: string,
    bytesAlreadyRead: number,
  ): { data: string; mimeType: string; bytes: number } | undefined {
    const fail = (code: string, detail?: string): undefined => {
      this.logger.warn(
        `attachments.file.image_failed ${JSON.stringify({ code, detail })}`,
      );
      return undefined;
    };
    let bytes: Buffer;
    try {
      bytes = readFileSync(storedPath);
    } catch (error) {
      return fail('READ_FAILED', describeDetail(error));
    }
    if (bytes.length === 0) return fail('EMPTY_IMAGE');
    const mimeType = sniffImageMimeType(bytes);
    if (!mimeType) return fail('UNSUPPORTED_IMAGE_CONTENT', name);
    if (mimeType !== declaredMimeType) {
      return fail('IMAGE_FORMAT_MISMATCH', `${declaredMimeType} vs ${mimeType}`);
    }
    if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
      return fail('IMAGE_TOO_LARGE', String(bytes.length));
    }
    if (bytesAlreadyRead + bytes.length > MAX_TURN_IMAGE_BYTES) {
      return fail('TURN_IMAGES_TOO_LARGE', String(bytesAlreadyRead + bytes.length));
    }
    return { data: bytes.toString('base64'), mimeType, bytes: bytes.length };
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
