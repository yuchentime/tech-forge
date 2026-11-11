/** Raised when memory is disabled or the engine failed to initialize. */
export class MemoryUnavailableError extends Error {
  constructor(message = '长期记忆暂不可用。') {
    super(message);
    this.name = 'MemoryUnavailableError';
  }
}

/** Raised when policy rules reject a candidate before it reaches storage. */
export class MemoryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryRejectedError';
  }
}
