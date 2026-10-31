export type ControlledModelFetchOptions = {
  admission: {mode: 'controlled-real-pilot'; environment: 'local-test'};
  expiresAt: number;
  transport: typeof fetch;
  maxRequests?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  onAttempt?: (metadata: Readonly<{attempt: number; limit: number}>) => void;
};

const endpoint = 'https://api.deepseek.com/anthropic/v1/messages';
const maxBodyBytes = 2 * 1024 * 1024;
const rejected = () => Error('CONTROLLED_MODEL_REQUEST_REJECTED');

/** Bound local request parsing as well as transport; never consume the response. */
async function readBody(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!request.body) throw rejected();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const next = await withAbort(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBodyBytes) throw rejected();
      chunks.push(next.value);
    }
    completed = true;
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {all.set(chunk, offset); offset += chunk.byteLength;}
    const body: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(all));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw rejected();
    return body as Record<string, unknown>;
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw rejected();
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One factory per run. Exhausted/invalid reservations are never refunded or retried. */
export function createControlledModelFetch(options: ControlledModelFetchOptions) {
  // Keep no mutable options aliases, including the callback and admission object.
  const {transport, expiresAt, onAttempt, maxRequests = 8, maxOutputTokens = 1024, timeoutMs = 60_000} = options;
  const mode = options.admission?.mode;
  const environment = options.admission?.environment;
  const bounded = (value: number, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
  const now = Date.now();
  if (mode !== 'controlled-real-pilot' || environment !== 'local-test' || typeof transport !== 'function' ||
      !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 3_600_000 ||
      !bounded(maxRequests, 8) || !bounded(maxOutputTokens, 1024) || !bounded(timeoutMs, 60_000) ||
      (onAttempt !== undefined && typeof onAttempt !== 'function')) throw rejected();
  let reserved = 0;
  let attempts = 0;
  const controlledFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint || request.method !== 'POST' || Date.now() >= expiresAt || reserved >= maxRequests) throw rejected();
    request.signal.throwIfAborted();
    // No await before reservation: simultaneous slow bodies share the same run cap.
    reserved++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs, expiresAt - Date.now()))))]);
    const body = await readBody(request, signal);
    if (body.model !== 'deepseek-flash' || (body.max_tokens !== undefined &&
        (typeof body.max_tokens !== 'number' || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1))) throw rejected();
    body.max_tokens = Math.min(body.max_tokens as number ?? maxOutputTokens, maxOutputTokens);
    signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw rejected();
    // Parsing consumed the original body, so explicitly replace it. All SDK headers
    // and other Request semantics survive, with redirects and deadline pinned here.
    const outbound = new Request(request, {body: JSON.stringify(body), redirect: 'error', signal});
    attempts++;
    let pending: Promise<Response>;
    try {pending = transport(outbound);} finally {
      try {onAttempt?.(Object.freeze({attempt: attempts, limit: maxRequests}));} catch { /* telemetry cannot alter I/O */ }
    }
    return withAbort(pending, signal);
  };
  return Object.freeze({fetch: controlledFetch,
    get state() {return Object.freeze({reserved, attempts, limit: maxRequests});}});
}
