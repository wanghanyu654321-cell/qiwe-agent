import type {WSClient, WSClientEventMap} from '@wecom/aibot-node-sdk';
import type {WecomBotExecutionBoundary} from './wecom-bot-assembly.js';

type OwnedClient = Pick<WSClient, 'on' | 'off' | 'isConnected' | 'eventNames' | 'listenerCount'>;
type State = 'armed' | 'connecting' | 'prepared' | 'active' | 'closing' | 'closed' | 'cleanup_unknown';
export interface WecomPreparationFingerprint {
  botId: string; corpId: string; ownerId: string; configVersion: string;
  credentialFingerprint: string; workspaceFingerprint: string;
}
export interface WecomPreparationGate {
  phase(): 'paused' | 'restoring' | 'ready';
  noteArrival(): void;
  beginWrite(): Readonly<{id: string}> | null;
  finishWrite(ticket: Readonly<{id: string}>): void;
}
export interface WecomBotPreparationOptions {
  mode: 'isolated-synthetic';
  /** Must synchronously create a new, unconnected SDK client. No implicit network client exists here. */
  createClient(): OwnedClient;
  /** Explicit synthetic lifecycle ports; the installed SDK's connect() is never called here. */
  connect(client: OwnedClient): void;
  disconnect(client: OwnedClient): void;
  assemble(client: OwnedClient, executionBoundary: WecomBotExecutionBoundary): {close(): void; idle(): Promise<void>};
  gate: WecomPreparationGate;
  readFingerprint(): WecomPreparationFingerprint;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const claimed = new WeakSet<object>();
const fields = ['botId', 'corpId', 'ownerId', 'configVersion', 'credentialFingerprint', 'workspaceFingerprint'] as const;
function isThenable(value: unknown): boolean {return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as {then?: unknown}).then === 'function';}
function absorbThenable(value: unknown) {if (isThenable(value)) void Promise.resolve(value).catch(() => {});}
function snapshot(read: () => WecomPreparationFingerprint): string {
  const value: unknown = read();
  if (isThenable(value)) {absorbThenable(value); throw Error('invalid_preparation_fingerprint');}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error('invalid_preparation_fingerprint');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== fields.length) throw Error('invalid_preparation_fingerprint');
  const captured = fields.map(k => {
    const descriptor = descriptors[k], v: unknown = descriptor?.value;
    if (!descriptor || typeof v !== 'string' || !v || v.length > 256 || /[\u0000-\u001f]/.test(v)) throw Error('invalid_preparation_fingerprint');
    return v;
  });
  return JSON.stringify(captured);
}

/** Isolated synthetic preparation. It does not grant recovery or create a real connection. */
export function createWecomBotPreparation(options: WecomBotPreparationOptions) {
  const {mode, gate, signal} = options;
  const timeout = options.timeoutMs ?? 4000;
  if (mode !== 'isolated-synthetic' || !Number.isInteger(timeout) || timeout < 1 || timeout > 4000 ||
    !gate || typeof gate.phase !== 'function' || typeof gate.noteArrival !== 'function' || typeof gate.beginWrite !== 'function' || typeof gate.finishWrite !== 'function' ||
    typeof options.createClient !== 'function' || typeof options.connect !== 'function' || typeof options.disconnect !== 'function' || typeof options.assemble !== 'function' || typeof options.readFingerprint !== 'function') throw Error('invalid_preparation_port');
  // Capture every executable port before any asynchronous boundary.
  const phase = gate.phase.bind(gate), noteArrival = gate.noteArrival.bind(gate), beginWrite = gate.beginWrite.bind(gate), finishWrite = gate.finishWrite.bind(gate);
  const createClient = options.createClient.bind(options), connect = options.connect.bind(options), disconnect = options.disconnect.bind(options), assemble = options.assemble.bind(options), readFingerprint = options.readFingerprint.bind(options);
  const initialFingerprint = snapshot(readFingerprint);
  const client = createClient();
  if (!client || typeof client !== 'object' || isThenable(client) || typeof client.on !== 'function' || typeof client.off !== 'function' || typeof client.eventNames !== 'function' || typeof client.listenerCount !== 'function' ||
    typeof client.isConnected !== 'boolean' || client.isConnected || client.eventNames().length !== 0 || Reflect.get(client, 'started') === true || claimed.has(client)) throw Error('preparation_client_not_fresh');
  claimed.add(client);
  let state: State = 'armed', epoch = 0, authenticatedEpoch = -1, approvedEpoch = -1, connectReturned = false, uncertain = false, lastFailure: string | undefined, rejectWait: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, closed: Promise<void> | undefined;
  const listeners: Array<() => void> = [];
  const connected = () => {try {return client.isConnected === true;} catch {return false;}};
  const currentFingerprint = () => {try {return snapshot(readFingerprint) === initialFingerprint;} catch {return false;}};
  const tickets = new Set<Readonly<{id: string}>>();
  const readyPhase = () => {const value: unknown = phase(); if (isThenable(value)) {absorbThenable(value); return false;} return value === 'ready';};
  function releaseTicket(ticket: Readonly<{id: string}>) {
    if (!tickets.delete(ticket)) return;
    try {const result: unknown = finishWrite(ticket); if (isThenable(result)) {absorbThenable(result); throw Error('async_finish_write');}}
    catch {uncertain = true; fail('write_ticket_cleanup_unknown');}
  }
  const bound: WecomBotExecutionBoundary = {
    admit: () => {try {return state === 'active' && approvedEpoch === epoch && authenticatedEpoch === epoch && connected() && currentFingerprint() && readyPhase();} catch {return false;}},
    enter: () => {
      if (!bound.admit()) return null;
      let ticket: ReturnType<typeof beginWrite>;
      try {ticket = beginWrite();} catch {fail('write_not_admitted'); return null;}
      if (ticket === null) {fail('write_not_admitted'); return null;}
      if (isThenable(ticket) || typeof ticket.id !== 'string' || !ticket.id) {
        absorbThenable(ticket);
        uncertain = true; fail('invalid_write_ticket');
        return null;
      }
      tickets.add(ticket);
      if (!bound.admit()) {releaseTicket(ticket); fail('connection_changed'); return null;}
      return ticket;
    },
    check: ticket => !!ticket && tickets.has(ticket as Readonly<{id: string}>) && bound.admit(),
    close: ticket => {if (ticket && !isThenable(ticket)) releaseTicket(ticket as Readonly<{id: string}>);},
    onInputRejected: () => inbound(),
  };
  let assembly: ReturnType<WecomBotPreparationOptions['assemble']> | undefined;
  const lateErrorSink = () => {};
  function listen(name: keyof WSClientEventMap, handler: (...args: unknown[]) => void) {
    client.on(name, handler); listeners.push(() => client.off(name, handler));
  }
  async function cleanup(): Promise<void> {
    if (closed) return closed;
    lastFailure ??= 'preparation_aborted';
    rejectWait?.(Error('preparation_aborted')); rejectWait = undefined;
    state = 'closing'; approvedEpoch = -1; authenticatedEpoch = -1;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    closed = (async () => {
      let failed = false;
      // SDK disconnect terminates the socket but late WebSocket errors may still reach WSClient.
      // The permanently claimed client retains one inert owned listener to prevent an
      // unhandled EventEmitter 'error' from crashing the process after close.
      try {client.on('error', lateErrorSink);} catch {failed = true;}
      for (const remove of listeners.splice(0).reverse()) {try {remove();} catch {failed = true;}}
      try {assembly?.close();} catch {failed = true;}
      try {const result: unknown = disconnect(client); if (isThenable(result)) {absorbThenable(result); failed = true;}} catch {failed = true;}
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {if (assembly) await Promise.race([assembly.idle(), new Promise<never>((_, reject) => {cleanupTimer = setTimeout(() => reject(Error('cleanup_timeout')), timeout);})]);} catch {failed = true;}
      finally {if (cleanupTimer) clearTimeout(cleanupTimer);}
      state = connected() || failed || uncertain || tickets.size > 0 ? 'cleanup_unknown' : 'closed';
    })();
    return closed;
  }
  function fail(code: string) {
    if (state === 'closing' || state === 'closed' || state === 'cleanup_unknown') return;
    lastFailure = code;
    approvedEpoch = -1; authenticatedEpoch = -1;
    rejectWait?.(Error(code)); rejectWait = undefined;
    void cleanup();
  }
  function inbound() {
    if (state === 'active' && bound.admit()) return;
    if (state !== 'armed' && state !== 'connecting' && state !== 'prepared' && state !== 'active') return;
    try {const result: unknown = noteArrival(); if (isThenable(result)) {absorbThenable(result); throw Error('async_gate_port');}} catch {uncertain = true; fail('arrival_record_unknown'); return;}
    fail('input_not_accepted');
  }
  function invalidate(reason: string, mayContinue = false) {
    epoch++; authenticatedEpoch = -1; approvedEpoch = -1;
    if (state === 'connecting' && mayContinue) return;
    if (state === 'armed') return;
    fail(reason);
  }
  function onAbort() {fail('preparation_aborted');}
  function maybePrepared() {
    if (state !== 'connecting' || !connectReturned || authenticatedEpoch !== epoch || !connected()) return;
    if (!currentFingerprint()) {fail('preparation_identity_changed'); return;}
    state = 'prepared';
    if (timer) clearTimeout(timer);
    rejectWait = undefined;
    resolveWait?.('prepared'); resolveWait = undefined;
  }
  let resolveWait: ((value: 'prepared') => void) | undefined;
  try {
    // SDK's generic events precede specific text/card callbacks, including unsupported types.
    listen('message', inbound); listen('event', inbound);
    listen('connected', () => invalidate('connection_changed', true));
    listen('disconnected', () => invalidate('connection_changed'));
    listen('reconnecting', () => invalidate('connection_changed'));
    listen('error', () => invalidate('connection_error'));
    listen('event.disconnected_event', () => invalidate('connection_changed'));
    listen('authenticated', () => {
      if (state !== 'connecting' || !connected()) return;
      authenticatedEpoch = epoch;
      maybePrepared();
    });
    assembly = assemble(client, bound);
    if (!assembly || typeof assembly.close !== 'function' || typeof assembly.idle !== 'function') throw Error('invalid_preparation_assembly');
  } catch (error) {void cleanup(); throw error;}
  return {
    status: () => state,
    failure: () => lastFailure,
    prepare(): Promise<'prepared'> {
      if (state !== 'armed') return Promise.reject(Error('preparation_already_started'));
      if (signal?.aborted) {fail('preparation_aborted'); return Promise.reject(Error('preparation_aborted'));}
      if (!currentFingerprint()) {fail('preparation_identity_changed'); return Promise.reject(Error('preparation_identity_changed'));}
      state = 'connecting';
      const waiting = new Promise<'prepared'>((resolve, reject) => {resolveWait = resolve; rejectWait = reject;});
      timer = setTimeout(() => fail('preparation_timeout'), timeout);
      signal?.addEventListener('abort', onAbort, {once: true});
      try {const result: unknown = connect(client); if (isThenable(result)) {absorbThenable(result); uncertain = true; fail('async_connect_unsupported');} else {connectReturned = true; maybePrepared();}}
      catch {fail('preparation_connect_failed');}
      return waiting;
    },
    activate(): boolean {
      if (state !== 'prepared' || authenticatedEpoch !== epoch || !connected()) return false;
      if (!currentFingerprint()) {fail('preparation_identity_changed'); return false;}
      try {if (!readyPhase()) return false;} catch {return false;}
      approvedEpoch = epoch; state = 'active';
      if (!bound.admit()) {fail('preparation_identity_changed'); return false;}
      return true;
    },
    close: cleanup,
  };
}
