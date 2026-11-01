import {WSClient, type WSClientEventMap} from '@wecom/aibot-node-sdk';
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
/** Opt-in (WECOM_DEBUG=1) masked lifecycle diagnostics. Never prints secrets, ids or message text. */
const wecomDebugEnabled = (): boolean => {try {return typeof process !== 'undefined' && process.env?.WECOM_DEBUG === '1';} catch {return false;}};
export function maskWecomValue(value: unknown): string {
  const s = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  if (!s) return '<none>';
  return '***' + (s.length >= 12 ? s.slice(-4) : '') + '(len=' + s.length + ')';
}
export function wecomDebug(event: string, fields: Record<string, unknown> = {}): void {
  if (!wecomDebugEnabled()) return;
  try {console.log('WECOM_DEBUG ' + JSON.stringify({t: new Date().toISOString(), event, ...fields}));} catch {}
}
function sanitizeSdkLog(message: unknown, args: unknown[]): string {
  let s = typeof message === 'string' ? message : '';
  s = s.replace(/body=[\s\S]*$/, 'body=<omitted>');
  s = s.replace(/(reqId|req_id|upload_id|media_id)([=:]\s*)([^\s,]+)/gi, (_m, k: string, sep: string, v: string) => k + sep + maskWecomValue(v));
  s = s.replace(/[{[][\s\S]*$/, '<json-omitted>');
  s = s.replace(/[A-Za-z0-9_\-+/=]{20,}/g, t => maskWecomValue(t));
  const extra = args.map(a => a instanceof Error ? a.message : a).filter(a => typeof a === 'number' || (typeof a === 'string' && !/^\s*[{[]/.test(a)))
    .map(a => String(a).replace(/[A-Za-z0-9_\-+/=]{20,}/g, t => maskWecomValue(t)).slice(0, 160));
  return (s + (extra.length ? ' ' + extra.join(' ') : '')).slice(0, 400);
}
const silentLogger = {debug() {}, info() {}, warn() {}, error() {}};
function wecomSdkLogger() {
  if (!wecomDebugEnabled()) return silentLogger;
  const at = (level: string) => (message: unknown, ...args: unknown[]) => wecomDebug('sdk', {level, msg: sanitizeSdkLog(message, args)});
  return {debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error')};
}
function describeFrame(frame: unknown): Record<string, unknown> {
  const f = (frame && typeof frame === 'object' ? frame : {}) as {cmd?: unknown; headers?: {req_id?: unknown}; body?: Record<string, unknown>};
  const b = (f.body && typeof f.body === 'object' ? f.body : {}) as Record<string, unknown>;
  const from = (b.from && typeof b.from === 'object' ? b.from : {}) as Record<string, unknown>;
  const text = (b.text && typeof b.text === 'object' ? b.text : {}) as Record<string, unknown>;
  const ev = (b.event && typeof b.event === 'object' ? b.event : {}) as Record<string, unknown>;
  return {cmd: typeof f.cmd === 'string' ? f.cmd.slice(0, 40) : '<none>', reqId: maskWecomValue(f.headers?.req_id), msgtype: typeof b.msgtype === 'string' ? b.msgtype.slice(0, 30) : undefined,
    chattype: typeof b.chattype === 'string' ? b.chattype.slice(0, 20) : undefined, eventtype: typeof ev.eventtype === 'string' ? ev.eventtype.slice(0, 40) : undefined,
    aibotid: maskWecomValue(b.aibotid), msgid: maskWecomValue(b.msgid), userid: maskWecomValue(from.userid), corpid: maskWecomValue(from.corpid),
    textLength: typeof text.content === 'string' ? text.content.length : undefined};
}
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
  if(options.mode!=='isolated-synthetic')throw Error('invalid_preparation_port');
  return createPreparation(options);
}
export function createControlledRealWecomBotPreparation(options:Omit<WecomBotPreparationOptions,'mode'|'createClient'|'connect'|'disconnect'>&{mode:'controlled-real-pilot';botId:string;secret:string}) {
  if(options.mode!=='controlled-real-pilot'||!options.botId||typeof options.secret!=='string'||!options.secret.trim()||['createClient','connect','disconnect'].some(k=>k in options))throw Error('invalid_preparation_port');
  const botId=options.botId,secret=options.secret,requestTimeout=options.timeoutMs??4000;
  return createPreparation({...options,createClient:()=>{const client=new WSClient({botId,secret,maxReconnectAttempts:0,maxAuthFailureAttempts:0,requestTimeout,logger:wecomSdkLogger()});wecomDebug('client_created',{botId:maskWecomValue(botId),requestTimeout,maxReconnectAttempts:0});return client;},
    connect:client=>{wecomDebug('connecting',{url:'wss://openws.work.weixin.qq.com'});(client as WSClient).connect();},disconnect:client=>{wecomDebug('disconnect_called',{});(client as WSClient).disconnect();}});
}
function createPreparation(options:Omit<WecomBotPreparationOptions,'mode'>&{mode:'isolated-synthetic' | 'controlled-real-pilot'}) {
  const {mode, gate, signal} = options;
  const timeout = options.timeoutMs ?? 4000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 4000 ||
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
      wecomDebug('preparation_closed', {state, lastFailure, failed, uncertain, tickets: tickets.size});
      if (debugTick) clearInterval(debugTick);
    })();
    return closed;
  }
  function fail(code: string) {
    wecomDebug('preparation_fail', {code, state, connected: connected()});
    if (state === 'closing' || state === 'closed' || state === 'cleanup_unknown') return;
    lastFailure = code;
    approvedEpoch = -1; authenticatedEpoch = -1;
    rejectWait?.(Error(code)); rejectWait = undefined;
    void cleanup();
  }
  function inbound() {
    if (state === 'active' && bound.admit()) return;
    wecomDebug('inbound_not_admitted', {state, approved: approvedEpoch === epoch, authenticated: authenticatedEpoch === epoch, connected: connected(), fingerprint: currentFingerprint(), ready: readyPhase()});
    if (state !== 'armed' && state !== 'connecting' && state !== 'prepared' && state !== 'active') return;
    try {const result: unknown = noteArrival(); if (isThenable(result)) {absorbThenable(result); throw Error('async_gate_port');}} catch {uncertain = true; fail('arrival_record_unknown'); return;}
    fail('input_not_accepted');
  }
  function invalidate(reason: string, mayContinue = false) {
    wecomDebug('invalidate', {reason, state, mayContinue});
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
    wecomDebug('prepared', {});
    if (timer) clearTimeout(timer);
    rejectWait = undefined;
    resolveWait?.('prepared'); resolveWait = undefined;
  }
  let resolveWait: ((value: 'prepared') => void) | undefined;
  let debugTick: ReturnType<typeof setInterval> | undefined;
  try {
    if (wecomDebugEnabled()) {
      listen('connected', () => wecomDebug('connected', {}));
      listen('authenticated', () => wecomDebug('auth_ok', {}));
      listen('disconnected', (reason: unknown) => wecomDebug('disconnected', {reason: typeof reason === 'string' ? reason.replace(/[A-Za-z0-9_\-]{20,}/g, t => maskWecomValue(t)).slice(0, 120) : '<none>'}));
      listen('reconnecting', (attempt: unknown) => wecomDebug('reconnecting', {attempt: typeof attempt === 'number' ? attempt : undefined}));
      listen('error', (error: unknown) => wecomDebug('error', {message: error instanceof Error ? error.message.replace(/[A-Za-z0-9_\-]{20,}/g, t => maskWecomValue(t)).slice(0, 160) : '<non-error>'}));
      listen('message', (frame: unknown) => wecomDebug('inbound', describeFrame(frame)));
      listen('event', (frame: unknown) => wecomDebug('inbound_event', describeFrame(frame)));
      listen('event.disconnected_event', () => wecomDebug('server_disconnected_event', {hint: 'another connection with the same botId took over'}));
      debugTick = setInterval(() => wecomDebug('alive', {state, connected: connected(), authenticated: authenticatedEpoch === epoch, approved: approvedEpoch === epoch}), 60000);
      (debugTick as {unref?: () => void}).unref?.();
    }
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
      wecomDebug('activate', {state, authenticated: authenticatedEpoch === epoch, connected: connected()});
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
