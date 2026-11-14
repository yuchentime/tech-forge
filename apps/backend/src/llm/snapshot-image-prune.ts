import { extname } from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/**
 * Extensions whose `write` body is a file the disk already owns.
 *
 * Every one of them is a payload the model can re-open (`read` for text/SVG, a vision call for a
 * raster image), so keeping the body in the snapshot only re-sends it on every later turn.
 */
const IMAGE_EXTENSIONS: Readonly<Record<string, true>> = {
  '.svg': true,
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.webp': true,
  '.bmp': true,
  '.avif': true,
};

/** Marks an already-pruned payload, so repeated passes stay idempotent. */
const OMITTED_MARKER = '[content omitted:';

/** Describes what one prune pass changed, for the caller's structured log. */
export interface ImageWritePrune {
  entries: SessionEntry[];
  prunedWrites: number;
  bytesRemoved: number;
}

/** Reports whether one written path currently exists as a readable file. */
export type PrunableFileCheck = (writtenPath: string) => boolean;

/**
 * Replaces the body of image `write` calls in a saved Pi snapshot with a short placeholder.
 *
 * The snapshot *is* the next turn's model context, so a 13 KB SVG the model just wrote is re-sent
 * with every later request even though the file sits on disk. Only `write` arguments change, and
 * only when `isPrunableFile` confirms the file still exists where the session can read it again:
 * dropping the body of a file that is gone would delete the only copy left in the conversation.
 *
 * Entry ids, parent links, timestamps, assistant text and tool results are untouched — only the
 * `content` string inside one tool call is swapped, and the `path` argument stays as written.
 */
export function pruneImageWritePayloads(
  entries: readonly SessionEntry[],
  isPrunableFile: PrunableFileCheck,
): ImageWritePrune {
  let prunedWrites = 0;
  let bytesRemoved = 0;

  const pruned = entries.map((entry) => {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') return entry;
    let changed = false;
    const content = entry.message.content.map((block) => {
      if (block.type !== 'toolCall' || block.name !== 'write') return block;
      const writtenPath = block.arguments.path;
      const body = block.arguments.content;
      if (typeof writtenPath !== 'string' || typeof body !== 'string') return block;
      if (body.startsWith(OMITTED_MARKER)) return block;
      if (!IMAGE_EXTENSIONS[extname(writtenPath).toLowerCase()]) return block;
      if (!isPrunableFile(writtenPath)) return block;
      const bytes = Buffer.byteLength(body, 'utf8');
      changed = true;
      prunedWrites += 1;
      bytesRemoved += bytes;
      return {
        ...block,
        arguments: {
          ...block.arguments,
          content: `${OMITTED_MARKER} ${bytes} B; read ${writtenPath} to view it]`,
        },
      };
    });
    if (!changed) return entry;
    return { ...entry, message: { ...entry.message, content } };
  });

  return { entries: pruned, prunedWrites, bytesRemoved };
}
