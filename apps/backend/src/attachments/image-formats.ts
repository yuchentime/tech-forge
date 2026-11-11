import { extname } from 'node:path';

/**
 * Image formats DeepSeek accepts as vision input, keyed by lowercase extension.
 *
 * The provider detects the real format from the file bytes; the extension only selects the branch
 * and declares the MIME type sent with the inline data URL.
 */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Provider limit for one inline image; Files API allows more, inline requests do not. */
export const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Raw bytes allowed for all images of one turn.
 *
 * Base64 inflates by 4/3, so 32 MiB raw becomes ~42.7 MiB of request body and still leaves room
 * under the provider's 48 MiB body limit for the prompt and tool schema.
 */
export const MAX_TURN_IMAGE_BYTES = 32 * 1024 * 1024;

/** Returns the declared MIME type for an image extension, or undefined for other files. */
export function getImageMimeTypeByName(name: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION[extname(name).toLowerCase()];
}

/** Sniffs the real image format from leading bytes; the provider formats are unambiguous. */
export function sniffImageMimeType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString('latin1');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}
