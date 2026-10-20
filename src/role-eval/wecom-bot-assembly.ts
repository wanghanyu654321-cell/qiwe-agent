import type {WSClient, WSClientEventMap} from '@wecom/aibot-node-sdk';
import {createWecomBotContext, type WecomBotContextOptions} from './wecom-bot-context.js';
import {createBotDelivery, type BotDeliveryResult} from './wecom-bot-delivery.js';
import {createBotSender} from './wecom-bot-sender.js';
import {createBotTasks, type BotTasksOptions} from './wecom-bot-tasks.js';
import type {BotReportOptions} from './wecom-bot-handler.js';
import {normalizeBotFrame, type BotEvent} from './wecom-bot-transport.js';
import {parseBotTaskCommand} from './wecom-bot-task-commands.js';

type Client = Pick<WSClient, 'on' | 'off' | 'isConnected'>;
export interface WecomBotAssemblyBusiness {
  scope: BotReportOptions['scope']; employees: BotReportOptions['employees'];
  ledger: BotReportOptions['ledger']; artifacts?: BotReportOptions['artifacts'];
  tasks?: Omit<BotTasksOptions, 'mode' | 'authority'>;
}
export interface WecomBotAssemblyOutcome {
  state: 'handled' | 'rejected'; detail: string;
  event?: Readonly<Pick<BotEvent, 'reqId' | 'messageId' | 'memberId'>>;
  result?: BotDeliveryResult;
}
export interface WecomBotAssemblyOptions {
  mode: 'isolated-synthetic'; botId: string; corpId: string; client: Client;
  identity: Omit<WecomBotContextOptions, 'mode' | 'botId' | 'corpId' | 'readSubject'>;
  businesses: readonly WecomBotAssemblyBusiness[];
  /** Deliberate synthetic port injection. A WSClient is never implicitly a synthetic sender. */
  sender: Parameters<typeof createBotSender>[0];
  requestTimeoutMs?: number; maxInFlight?: number;
  onOutcome?(outcome: WecomBotAssemblyOutcome): void;
}
const attached = new WeakSet<object>();
function freezeFrame<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) freezeFrame(child);
  }
  return value;
}

/** Authenticated SDK event boundary; no connection ownership, network adapter or raw-frame handler. */
export function createWecomBotAssembly(options: WecomBotAssemblyOptions) {
  const {client, botId, corpId, onOutcome} = options;
  const requestTimeout = options.requestTimeoutMs ?? 4000, capacity = options.maxInFlight ?? 8;
  const valid = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && s.length <= 120 && !/[\u0000-\u001f]/.test(s);
  if (options.mode !== 'isolated-synthetic' || !valid(botId) || !valid(corpId) || !client || typeof client.on !== 'function' || typeof client.off !== 'function' || !Number.isInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 4000 || !Number.isInteger(capacity) || capacity < 1 || capacity > 1024 || !options.businesses.length) throw Error('invalid_bot_assembly');
  if (attached.has(client)) throw Error('assembly_already_attached');
  // Validate sender now, without taking ownership of either injected SDK port.
  createBotSender(options.sender).close();
  const port = options.sender.sdk, filePort = options.sender.fileSdk;
  const senderOptions = {...options.sender, sdk: {mode: port.mode, ready: port.ready.bind(port), reply: port.reply.bind(port), sendMessage: port.sendMessage.bind(port)},
    ...(filePort ? {fileSdk: {mode: filePort.mode, uploadMedia: filePort.uploadMedia.bind(filePort), sendMessage: filePort.sendMessage.bind(filePort)}} : {})};
  const identity = {...options.identity, stores: structuredClone(options.identity.stores), roles: [...options.identity.roles]};
  const businesses = options.businesses.map(b => {
    const tasks = b.tasks, training = tasks?.training, native = tasks?.native;
    return {...b, scope: structuredClone(b.scope), employees: structuredClone(b.employees), ...(tasks ? {tasks: {...tasks,
      catalog: structuredClone(tasks.catalog),
      // Capture admitted capabilities once; shared service state and live authority readers stay shared.
      ...(training ? {training: {enabled: training.enabled, resolve: training.resolve.bind(training)}} : {}),
      ...(native ? {native: {start: native.start.bind(native), query: native.query.bind(native), cancel: native.cancel.bind(native), close: native.close.bind(native)}} : {}),
    }} : {})};
  });
  if (businesses.some(b => !b.scope || !Object.values(b.scope).every(valid) || !b.employees.length || b.employees.some(e => ![e.accountId, e.employeeId, e.employeeName].every(valid))) || new Set(businesses.map(b => JSON.stringify([b.scope.tenant, b.scope.store]))).size !== businesses.length) throw Error('invalid_bot_assembly');
  let closed = false, authenticated = false, epoch = 0;
  const pending = new Set<Promise<void>>(), active = new Set<{controller: AbortController; dispose(): void}>();
  const connected = () => {try {return client.isConnected === true;} catch {return false;}};
  function observe(outcome: WecomBotAssemblyOutcome) {
    try {
      // The observer receives an independent safe value; its failures cannot change committed facts.
      const returned: unknown = onOutcome?.(structuredClone(outcome));
      if (returned instanceof Promise) void returned.catch(() => {});
    } catch {}
  }
  function invalidate() {
    authenticated = false; epoch++;
    for (const request of active) {request.controller.abort(); request.dispose();}
  }
  function receive(raw: unknown) {
    let frame: unknown, event: BotEvent;
    try {frame = freezeFrame(structuredClone(raw)); event = normalizeBotFrame(frame);} catch {observe({state: 'rejected', detail: 'unsupported_event'}); return;}
    const metadata = {reqId: event.reqId, messageId: event.messageId, memberId: event.memberId};
    const reject = (detail: string) => observe({state: 'rejected', detail, event: metadata});
    if (closed) return;
    if (!authenticated || !connected()) {reject('not_authenticated'); return;}
    if (event.botId !== botId || event.corpId !== undefined && event.corpId !== corpId) {reject('access_denied'); return;}
    if (active.size >= capacity) {reject('capacity_exceeded'); return;}
    const capturedEpoch = epoch, controller = new AbortController(), deadline = performance.now() + requestTimeout;
    const resources: (() => void)[] = [];
    const request = {controller, dispose: () => {for (const close of resources.splice(0).reverse()) close();}};
    const check = () => {
      if (closed || controller.signal.aborted || capturedEpoch !== epoch || !authenticated || !connected()) throw Error('session_invalidated');
      if (performance.now() >= deadline) throw Error('request_timeout');
    };
    active.add(request);
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    const scope = {signal: controller.signal, deadline, correlationId: event.reqId};
    const work = async () => {
      try {
        check();
        const authority = createWecomBotContext({...identity, mode: 'isolated-synthetic', botId, corpId,
          readSubject: async () => {check(); return {botId, memberId: event.memberId};}});
        resources.push(() => authority.close());
        const command = event.action.kind === 'text' ? parseBotTaskCommand(event.action.text) : undefined;
        const context = await authority.authorize(scope, command?.role ?? 'manager'); check();
        const business = businesses.find(b => b.scope.tenant === context.identity.tenantId && b.scope.store === context.identity.storeId && b.employees.some(e => e.accountId === context.identity.accountId));
        if (!business) throw Error('access_denied');
        const sender = createBotSender({...senderOptions, sdk: {...senderOptions.sdk, ready: () => {
          try {check(); return senderOptions.sdk.ready();} catch {return false;}
        }}});
        resources.push(() => sender.close());
        const tasks = business.tasks ? createBotTasks({...business.tasks, mode: 'isolated-synthetic', authority}) : undefined;
        if (tasks) resources.push(() => tasks.close());
        // Original services fence business writes with this request's authority/budget. Their
        // finalizers must still persist unknown outcomes for actions already attempted at abort.
        const delivery = createBotDelivery({mode: 'isolated-synthetic', authority, ledger: business.ledger, scope: business.scope, employees: business.employees,
          ...(business.artifacts ? {artifacts: business.artifacts} : {}), ...(tasks ? {tasks} : {}), readEvent: () => {check(); return frame;}, sender});
        resources.push(() => delivery.close());
        const result = await delivery.handle(scope); check();
        observe({state: 'handled', detail: 'event_handled', event: metadata, result});
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const allowed = ['access_denied', 'access_changed', 'authority_unavailable', 'unsupported_event', 'bot_reply_conflict', 'request_timeout'];
        reject(controller.signal.aborted ? (capturedEpoch !== epoch || closed ? 'session_invalidated' : 'request_timeout') : allowed.includes(code) ? code : 'event_unavailable');
      } finally {clearTimeout(timer); controller.abort(); request.dispose(); active.delete(request);}
    };
    const promise = work(); pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  }
  const listeners: (() => void)[] = [];
  const listen = (name: keyof WSClientEventMap, listener: (...args: unknown[]) => void) => {
    client.on(name, listener); listeners.push(() => {client.off(name, listener);});
  };
  attached.add(client);
  try {
    listen('message.text', receive); listen('event.template_card_event', receive);
    listen('connected', invalidate); listen('disconnected', invalidate); listen('reconnecting', invalidate); listen('error', invalidate); listen('event.disconnected_event', invalidate);
    listen('authenticated', () => {invalidate(); if (!closed) authenticated = true;});
  } catch (error) {for (const remove of listeners.reverse()) remove(); attached.delete(client); throw error;}
  return {
    async idle() {while (pending.size) await Promise.all([...pending]);},
    close() {if (closed) return; closed = true; invalidate(); for (const remove of listeners.reverse()) remove(); attached.delete(client);},
  };
}
