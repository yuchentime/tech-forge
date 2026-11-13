import type { BackendRequest, BackendResponse } from '../../src/types/desktop-bridge';

/**
 * Socket-level codes that mean the request never received a response, so repeating it is safe.
 *
 * The local backend can sit behind a long CPU-bound ingest (chunking and embedding run on its main
 * thread), and it also accepts connections from the desktop bridge only. In both cases a reset means
 * "no answer", not "business rule rejected".
 */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** One request target: the loopback port and the local token the backend requires. */
export interface BackendRequestContext {
  port: number;
  token: string;
}

/** Overridable seams so the retry contract can be tested without a real backend. */
export interface RequestBackendOptions {
  fetchImpl?: typeof fetch;
  delayImpl?: (milliseconds: number) => Promise<void>;
}

/** Reads the socket error code from a failed fetch, which nests it under `cause`. */
export function getNetworkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') return causeCode;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Turns a connection failure into copy a non-technical user can act on.
 *
 * The socket code stays in parentheses so support can still tell a reset from a timeout.
 */
export function describeBackendFailure(error: unknown): string {
  const detail = getNetworkErrorCode(error) ?? (error instanceof Error ? error.message : String(error));
  return `本地服务连接中断，请重试；如果一直失败，请重启 TeachForge。（${detail}）`;
}

/** Pauses between the first attempt and its retry. */
function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

/** Sends one JSON request to the local backend and decodes its body. */
async function sendBackendRequest(
  context: BackendRequestContext,
  input: BackendRequest,
  fetchImpl: typeof fetch,
): Promise<BackendResponse> {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const response = await fetchImpl(`http://127.0.0.1:${context.port}${input.path}`, {
    method: input.method,
    headers: {
      'x-teachforge-token': context.token,
      // Closing each connection keeps an idle pooled socket from being reused after the backend
      // dropped it; the cost on loopback is one handshake per request.
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

/**
 * Forwards one Renderer request to the local backend, retrying once after a connection reset.
 *
 * Only `GET` is retried. The bridge also carries non-idempotent writes (classroom turns, summary
 * generation, imports); replaying those after a lost response can duplicate messages or model calls,
 * and the caller cannot tell it happened. Mutations surface the connection error instead.
 */
export async function requestBackend(
  context: BackendRequestContext,
  input: BackendRequest,
  options: RequestBackendOptions = {},
): Promise<BackendResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayImpl = options.delayImpl ?? delay;
  const canRetry = input.method === 'GET';

  try {
    return await sendBackendRequest(context, input, fetchImpl);
  } catch (error) {
    const code = getNetworkErrorCode(error);
    if (!canRetry || code === undefined || !RETRYABLE_NETWORK_CODES.has(code)) {
      throw new Error(describeBackendFailure(error));
    }
    // One short pause covers the socket the backend closed while the request was being written.
    await delayImpl(150);
    try {
      return await sendBackendRequest(context, input, fetchImpl);
    } catch (retryError) {
      throw new Error(describeBackendFailure(retryError));
    }
  }
}
