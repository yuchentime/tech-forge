import type { AgentSessionEvent as PiAgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** Pi thinking budget supported by app-owned model sessions. */
export type PiThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** Describes one completed chat message used to restore an external transcript. */
export interface LlmConversationHistoryMessage {
  id: string;
  role: string;
  contentJson: string;
  status: string;
  createdAt: Date | string;
}

/** Supplies SQLite-owned conversation identity and history to a Pi session. */
export interface LlmConversationContext {
  id: string;
  history: readonly LlmConversationHistoryMessage[];
}

/** One inline image for the current user message, already base64-encoded. */
export interface LlmInputImage {
  /** Raw base64 bytes without a data-URL prefix. */
  data: string;
  mimeType: string;
}

export interface LlmRequestOptions {
  requestId?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: PiThinkingLevel;
  conversation?: LlmConversationContext;
  persistConversationEvent?: (event: PiAgentSessionEvent) => Promise<void>;
  /**
   * Per-turn reference material (attachment text, knowledge chunks) composed by ChatService.
   *
   * It is prepended to the user message sent to the model, never to the system prompt: the system
   * prompt stays byte-identical across turns so provider prefix caching keeps working, and per-turn
   * data stays where it belongs. The stored transcript keeps only the user's own text — see
   * `replaceInjectedUserText`.
   */
  promptContext?: string;
  /**
   * Images attached to this turn's user message.
   *
   * Pi's OpenAI-compatible path serializes each as an `image_url` data URL, so the model receives
   * them as vision input with the text prompt. They belong to this turn only: the snapshot cleanup
   * drops them, and later turns can re-open the stored file with `read`.
   */
  images?: readonly LlmInputImage[];
  /**
   * Durable context appended to the Pi session as its own custom message entry.
   *
   * Unlike `promptContext`, this survives the snapshot cleanup: Pi keeps the entry, later turns
   * restore it, and the model reads it as a regular user message instead of the system prompt.
   * `display: false` keeps it out of the visible transcript, so callers must send it exactly once.
   */
  contextMessage?: { type: string; text: string };
  /** Ordered durable entries, kept outside the system prompt and visible user text. */
  contextMessages?: Array<{ type: string; text: string; details?: unknown }>;
  /**
   * Called after the Agent created or modified a file, with the resolved absolute path.
   *
   * The chat layer uses it to index artifacts; the LLM layer stays unaware of that store. It fires
   * only for the app-owned file tools registered by `PiAgentRuntime.createSession()`: Pi's built-in `write`/`edit` do
   * not report a path, so a session that registers the built-ins keeps this callback silent.
   */
  onFileWritten?: (input: {
    absolutePath: string;
    tool: "write" | "edit";
  }) => Promise<void> | void;
  /**
   * Pi skill expanded at the start of this turn's model prompt.
   *
   * The skill body becomes part of the user message, not the system prompt, so per-turn context
   * (attachments, knowledge chunks) can still follow it. The stored transcript and snapshot keep
   * the user's own text: the caller passes that text as `prompt`, while this option only changes
   * what the model reads. `PiAgentRuntime.createSession()` fails loudly when the named skill is not discoverable.
   */
  skillName?: string;
}

/** Adds request-scoped cancellation to streamed LLM calls. */
export interface LlmStreamOptions extends LlmRequestOptions {
  signal?: AbortSignal;
}
