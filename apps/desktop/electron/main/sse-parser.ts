/** Represents one decoded server-sent event before Agent payload validation. */
export type SseMessage = { event: string; data: string };

const MAX_SSE_FRAME_SIZE = 1_048_576;

/** Incrementally parses SSE text while preserving frames split across chunks. */
export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private eventSize = 0;

  /** Adds a decoded UTF-8 chunk and returns every complete event it contains. */
  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];

    while (true) {
      const delimiterIndex = this.buffer.search(/[\r\n]/);
      if (delimiterIndex < 0) break;

      const delimiter = this.buffer[delimiterIndex];
      if (delimiter === '\r' && delimiterIndex === this.buffer.length - 1) break;

      const delimiterLength =
        delimiter === '\r' && this.buffer[delimiterIndex + 1] === '\n' ? 2 : 1;
      const line = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + delimiterLength);
      this.consumeLine(line, messages);
    }

    if (this.buffer.length > 1_048_576) {
      throw new Error('SSE line exceeded the allowed size.');
    }
    return messages;
  }

  /** Discards an incomplete trailing frame when the HTTP response ends. */
  finish(): void {
    this.buffer = '';
    this.eventName = '';
    this.dataLines = [];
    this.eventSize = 0;
  }

  /** Applies one SSE field line and dispatches completed blank-line frames. */
  private consumeLine(line: string, messages: SseMessage[]): void {
    if (line.length === 0) {
      if (this.dataLines.length > 0) {
        messages.push({
          event: this.eventName || 'message',
          data: this.dataLines.join('\n'),
        });
      }
      this.eventName = '';
      this.dataLines = [];
      this.eventSize = 0;
      return;
    }
    this.eventSize += line.length + 1;
    if (this.eventSize > MAX_SSE_FRAME_SIZE) {
      throw new Error('SSE frame exceeded the allowed size.');
    }
    if (line.startsWith(':')) return;

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex < 0 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex < 0 ? '' : line.slice(separatorIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
  }
}
