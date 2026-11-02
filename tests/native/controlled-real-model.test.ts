import {afterEach, describe, expect, it, vi} from 'vitest';
import {createControlledModelFetch, type ControlledModelFetchOptions} from '../../integrations/native/controlled-real-model.js';

const endpoint = 'https://api.deepseek.com/anthropic/v1/messages';
const init = (extra = {}) => ({method: 'POST', body: JSON.stringify({model: 'deepseek-flash', max_tokens: 4000, messages: [], ...extra})});
const options = (extra: Partial<ControlledModelFetchOptions> = {}): ControlledModelFetchOptions => ({
  admission: {mode: 'controlled-real-pilot', environment: 'local-test'}, expiresAt: Date.now() + 10_000,
  transport: async () => new Response('ok'), ...extra,
});
afterEach(() => vi.useRealTimers());

describe('controlled real original model transport budget', () => {
  it.each([
    {admission: undefined}, {admission: {mode: 'controlled-real-pilot', environment: 'production'}},
    {expiresAt: NaN}, {expiresAt: Infinity}, {expiresAt: 0}, {expiresAt: Date.now() + 3_700_000},
    {maxRequests: 9}, {maxRequests: 0}, {maxRequests: 1.5}, {maxOutputTokens: 1025}, {maxOutputTokens: 0},
    {timeoutMs: 60_001}, {timeoutMs: 0},
  ])('requires local admission and finite bounded configuration %j', extra => {
    expect(() => createControlledModelFetch(options(extra as Partial<ControlledModelFetchOptions>))).toThrow();
  });

  it('clamps output and forces redirect error on the actual Request without changing response identity', async () => {
    const response = new Response('upstream', {status: 429});
    let seen!: Request;
    const limited = createControlledModelFetch(options({transport: async input => {seen = input as Request; return response;}}));
    const result = await limited.fetch(new Request(endpoint, {...init(), redirect: 'follow'}));
    expect(result).toBe(response);
    expect(seen.redirect).toBe('error');
    expect(await seen.json()).toMatchObject({model: 'deepseek-flash', max_tokens: 1024, messages: []});
    expect(limited.state).toEqual({reserved: 1, attempts: 1, limit: 8});
  });

  it('preserves a smaller valid requested token budget and defaults a missing one', async () => {
    const bodies: unknown[] = [];
    const limited = createControlledModelFetch(options({maxOutputTokens: 512, transport: async input => {
      bodies.push(await (input as Request).json()); return new Response();
    }}));
    await limited.fetch(endpoint, init({max_tokens: 7}));
    await limited.fetch(endpoint, init({max_tokens: undefined}));
    expect(bodies).toMatchObject([{max_tokens: 7}, {max_tokens: 512}]);
  });

  it.each([
    ['https://api.deepseek.com.evil/anthropic/v1/messages', init()],
    [`${endpoint}?x=1`, init()], [endpoint, {method: 'GET'}], [endpoint, init({model: 'other'})],
    [endpoint, {method: 'POST', body: '{'}], [endpoint, {method: 'POST', body: 'null'}],
    [endpoint, init({max_tokens: -1})], [endpoint, init({max_tokens: '100'})],
    [endpoint, init({messages: 'x'.repeat(2 * 1024 * 1024)})],
  ])('rejects invalid routing or payload before transport %s', async (url, requestInit) => {
    const limited = createControlledModelFetch(options({transport: async () => {throw Error('transport-must-not-run');}}));
    await expect(limited.fetch(url, requestInit)).rejects.toThrow('CONTROLLED_MODEL_REQUEST_REJECTED');
    expect(limited.state.attempts).toBe(0);
  });

  it('reserves all eight slots synchronously before slow body reads and never replenishes them', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const limited = createControlledModelFetch(options({transport: async () => {await gate; return new Response();}}));
    const pending = Array.from({length: 8}, () => limited.fetch(endpoint, init()));
    expect(limited.state.reserved).toBe(8);
    await expect(limited.fetch(endpoint, init())).rejects.toThrow('CONTROLLED_MODEL_REQUEST_REJECTED');
    release(); await Promise.all(pending);
    await expect(limited.fetch(endpoint, init())).rejects.toThrow('CONTROLLED_MODEL_REQUEST_REJECTED');
    expect(limited.state.attempts).toBe(8);
  });

  it('snapshots admission, limits, callback and transport and exposes no mutable budget', async () => {
    const events: unknown[] = [];
    const config = options({maxRequests: 1, maxOutputTokens: 23, onAttempt: value => {events.push(value); throw Error('private');},
      transport: async input => new Response(String((await (input as Request).json()).max_tokens))});
    const limited = createControlledModelFetch(config);
    config.admission.environment = 'production' as 'local-test'; config.expiresAt = Infinity;
    config.maxRequests = 100; config.maxOutputTokens = 99999;
    config.transport = async () => {throw Error('replaced');}; config.onAttempt = () => {throw Error('replaced');};
    try {Object.assign(limited.state, {reserved: -100, limit: 999});} catch {}
    expect(await (await limited.fetch(endpoint, init())).text()).toBe('23');
    await expect(limited.fetch(endpoint, init())).rejects.toThrow();
    expect(events).toEqual([{attempt: 1, limit: 1}]);
  });

  it('rejects an already cancelled request without transport', async () => {
    const caller = new AbortController(); caller.abort();
    const limited = createControlledModelFetch(options());
    await expect(limited.fetch(endpoint, {...init(), signal: caller.signal})).rejects.toThrow();
    expect(limited.state.attempts).toBe(0);
  });

  it('bounds stalled request bodies by cancellation before transport', async () => {
    const caller = new AbortController();
    const limited = createControlledModelFetch(options());
    const request = new Request(endpoint, {method: 'POST', body: new ReadableStream(), signal: caller.signal,
      duplex: 'half'} as RequestInit);
    const pending = limited.fetch(request); caller.abort();
    await expect(pending).rejects.toThrow();
    expect(limited.state.attempts).toBe(0);
  });

  it('expires a stalled body and prevents concurrent admission while it is being read', async () => {
    const limited = createControlledModelFetch(options({maxRequests: 1, expiresAt: Date.now() + 35}));
    const request = new Request(endpoint, {method: 'POST', body: new ReadableStream(), duplex: 'half'} as RequestInit);
    const pending = limited.fetch(request);
    await expect(limited.fetch(endpoint, init())).rejects.toThrow('CONTROLLED_MODEL_REQUEST_REJECTED');
    await expect(pending).rejects.toThrow();
    expect(limited.state).toEqual({reserved: 1, attempts: 0, limit: 1});
  });

  it.each(['timeout', 'expiry', 'caller'] as const)('keeps %s cancellation active during streaming consumption', async kind => {
    const caller = new AbortController();
    let sent!: Request;
    const limited = createControlledModelFetch(options({expiresAt: Date.now() + (kind === 'expiry' ? 35 : 10_000),
      timeoutMs: kind === 'timeout' ? 35 : 60_000, transport: async input => {
        sent = input as Request;
        return new Response(new ReadableStream({start(controller) {
          sent.signal.addEventListener('abort', () => controller.error(sent.signal.reason), {once: true});
          controller.enqueue(new TextEncoder().encode('first'));
        }}));
      }}));
    const response = await limited.fetch(endpoint, {...init(), signal: caller.signal});
    expect(response.bodyUsed).toBe(false);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    const stalled = reader.read();
    if (kind === 'caller') caller.abort();
    await expect(stalled).rejects.toThrow();
    expect(sent.signal.aborted).toBe(true);
  });

  it('rejects after expiry before starting another request', async () => {
    const limited = createControlledModelFetch(options({expiresAt: Date.now() + 20}));
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(limited.fetch(endpoint, init())).rejects.toThrow();
    expect(limited.state.attempts).toBe(0);
  });

  it('never retries or replaces a transport failure', async () => {
    const failure = Error('upstream');
    const limited = createControlledModelFetch(options({transport: async () => {throw failure;}}));
    await expect(limited.fetch(endpoint, init())).rejects.toBe(failure);
    expect(limited.state.attempts).toBe(1);
  });
});
