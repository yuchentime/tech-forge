import type { LessonMessage } from './lesson.types';

/** Bounds one prompt-ready transcript: newest lines first, then a character budget. */
export interface TranscriptFormatOptions {
  /** Maximum number of recent messages to include. */
  limit: number;
  /** Maximum escaped characters across the rendered lines. */
  charLimit: number;
}

/**
 * Renders a transcript as one speaker-tagged line per message.
 *
 * Message bodies are escaped so a user cannot forge a `</speaker_name>` boundary and make the model
 * read injected "speakers"; the tag is a prompt-only encoding, never the stored format. The newest
 * messages always survive the budget, then order is restored to chronological.
 */
export function formatTranscript(
  messages: readonly LessonMessage[],
  options: TranscriptFormatOptions,
): string {
  const recent = messages.slice(-options.limit);
  const lines: string[] = [];
  let budget = options.charLimit;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const prefix = `<speaker_name>${message.speaker}</speaker_name>`;
    const body = escapeSpeakerText(message.text);
    const room = budget - prefix.length;
    if (room <= 0) break;
    const bodyChars = Array.from(body);
    const line =
      bodyChars.length > room
        ? `${prefix}${bodyChars.slice(0, room).join('')}…`
        : `${prefix}${body}`;
    lines.unshift(line);
    budget -= line.length + 1;
  }
  return lines.join('\n');
}

/** Compact student-only speaking order, newest last; used where a char budget is too small. */
export function formatSpeakerSequence(
  messages: readonly LessonMessage[],
  limit = 8,
): string {
  return messages
    .filter((message) => message.speaker !== 'teacher')
    .slice(-limit)
    .map((message) => message.speaker)
    .join(' > ');
}

/** Truncates by Unicode code points so a surrogate pair is never split. */
export function truncateChars(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit
    ? `${chars.slice(0, limit).join('')}…`
    : text;
}

/** Neutralizes angle brackets so message text cannot impersonate a speaker tag. */
export function escapeSpeakerText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
