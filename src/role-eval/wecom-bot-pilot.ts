import type {WSClient} from '@wecom/aibot-node-sdk';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createWecomBotPreparation,type WecomBotPreparationOptions,type WecomPreparationGate} from './wecom-bot-preparation.js';
import {createWecomBotAssembly,type WecomBotAssemblyOptions} from './wecom-bot-assembly.js';
import {createWecomBotContext,type WecomBotContextOptions,type BotContextRequest} from './wecom-bot-context.js';
import {createBotSdkAdapter} from './wecom-bot-sdk.js';
import {createBotSender} from './wecom-bot-sender.js';
import {createBotConversationDelivery} from './wecom-bot-delivery.js';
import type {BotConversationIntakePort,BotConversationReceipt,BotRoleWorkspacePort} from './wecom-bot-conversations.js';
import type {BotConversationActor,BotTaskStore} from './wecom-bot-task-store.js';

export interface WecomBotPilotExecution {
  /** Borrowed original queue identity. The pilot never controls its lifecycle. */
  readonly queue: unknown;
  readonly gate: WecomPreparationGate & {isPaused(): boolean};
  enqueue(receiptId: string): void;
  cancel(receiptId: string): void;
}
type Delivery = ReturnType<typeof createBotConversationDelivery>;
type Recovery = Awaited<ReturnType<Delivery['recover']>>;
export type WecomBotPilotDelivery = Recovery | {deliveries: []; deferred: true; detail: 'pilot_not_active' | 'delivery_failed'};
export interface WecomBotPilotOptions {
  mode: 'isolated-synthetic'; botId: string; corpId: string;
  identity: WecomBotAssemblyOptions['identity'];
  /** Trusted outbound subject; incoming subjects still come from SDK events. */
  readSubject: WecomBotContextOptions['readSubject'];
  business: Pick<WecomBotAssemblyOptions['businesses'][number], 'scope' | 'employees' | 'ledger'> & {store: BotTaskStore};
  initializeExecution(options: {
    mode: 'isolated-synthetic';
    authorize(receipt: (BotConversationReceipt & {actor: BotConversationActor}) | undefined): boolean;
    onCompleted(receiptIds: string[]): Promise<void>;
  }): WecomBotPilotExecution;
  authorize(receipt: (BotConversationReceipt & {actor: BotConversationActor}) | undefined): boolean;
  createIntake(execution: WecomBotPilotExecution): BotConversationIntakePort;
  createRoles(gate: WecomBotPilotExecution['gate']): BotRoleWorkspacePort;
  createClient(): WSClient;
  connect: WecomBotPreparationOptions['connect'];
  disconnect: WecomBotPreparationOptions['disconnect'];
  readFingerprint: WecomBotPreparationOptions['readFingerprint'];
  timeoutMs?: number; signal?: AbortSignal;
  onOutcome?: WecomBotAssemblyOptions['onOutcome'];
  onDelivery?(receiptId: string, result: WecomBotPilotDelivery): void;
}

/** Concrete synthetic channel owner over the original host execution, authority and stores.
 * Native adapters and host resources are borrowed; no runner, replay or readiness override exists. */
export function createWecomBotPilot(options: WecomBotPilotOptions) {
  if (options.mode !== 'isolated-synthetic' || ['initializeExecution', 'authorize', 'createIntake', 'createRoles', 'createClient', 'connect', 'disconnect', 'readSubject', 'readFingerprint'].some(key => typeof Reflect.get(options,key) !== 'function')) throw Error('invalid_bot_pilot');
  const {mode,botId,corpId,timeoutMs,signal,onOutcome,onDelivery} = options;
  const initialize = options.initializeExecution.bind(options), authorize = options.authorize.bind(options);
  const createIntake = options.createIntake.bind(options), createRoles = options.createRoles.bind(options);
  const createClient = options.createClient.bind(options), connect = options.connect.bind(options), disconnect = options.disconnect.bind(options), readFingerprint = options.readFingerprint.bind(options);
  const readSubject = options.readSubject.bind(options);
  const identity = {...options.identity, stores: structuredClone(options.identity.stores), roles: [...options.identity.roles],
    readBinding: options.identity.readBinding.bind(options.identity), readNative: options.identity.readNative.bind(options.identity)};
  const business = {...options.business, scope: structuredClone(options.business.scope), employees: structuredClone(options.business.employees)};
  let stopped = false, admitted = () => false;
  let preparation: ReturnType<typeof createWecomBotPreparation> | undefined;
  let assembly: ReturnType<typeof createWecomBotAssembly> | undefined;
  let authority: ReturnType<typeof createWecomBotContext> | undefined;
  let sender: ReturnType<typeof createBotSender> | undefined;
  let adapter: ReturnType<typeof createBotSdkAdapter> | undefined;
  let delivery: Delivery | undefined;
  const pending = new Set<Promise<unknown>>(), physical = new Set<Promise<void>>();
  const recoveryReads = new AsyncLocalStorage<Set<Promise<void>>>();
  const deliveryTickets = new Map<unknown, () => void>();
  function track<T>(promise: Promise<T>, reads?: Set<Promise<void>>): Promise<T> {
    const settled = promise.then(() => {}, () => {}); physical.add(settled); reads?.add(settled);
    void settled.then(() => {physical.delete(settled); reads?.delete(settled);}); return promise;
  }
  function observe(id: string, result: WecomBotPilotDelivery) {
    try {const returned: unknown = onDelivery?.(id, structuredClone(result)); if (returned && typeof Reflect.get(Object(returned),'then') === 'function') void Promise.resolve(returned).catch(() => {});} catch {}
  }
  async function idle() {
    // Never wait for the host runner: it can itself be awaiting onCompleted.
    await assembly?.idle();
    while (pending.size || physical.size) await Promise.all([...pending].map(p => p.then(() => {}, () => {})).concat([...physical]));
  }
  function stopOwned() {
    stopped = true;
    const errors: unknown[] = [];
    for (const close of [() => assembly?.close(), () => sender?.close(), () => adapter?.close(), () => authority?.close()]) {
      try {close();} catch (error) {errors.push(error);}
    }
    if (errors.length) throw new AggregateError(errors, 'pilot_cleanup_failed');
  }
  const active = () => !stopped && !!delivery && admitted();
  function recover(request: BotContextRequest, id: string, retry: Parameters<Delivery['recover']>[2] = {}): Promise<Recovery> {
    if (!active()) return Promise.reject(Error('pilot_not_active'));
    const promise = recoveryReads.run(new Set(), () => delivery!.recover({...request}, id, {...retry})); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  try {
    const execution = initialize({mode, authorize, onCompleted: async ids => {
      // The original callback may fire synchronously while the host is binding.
      // Defer each unavailable receipt without retaining a replay backlog.
      for (const id of [...ids]) {
        if (!active()) {observe(id, {deliveries: [], deferred: true, detail: 'pilot_not_active'}); continue;}
        try {observe(id, await recover({signal: new AbortController().signal, deadline: performance.now() + (timeoutMs ?? 4000), correlationId: 'pilot-completion-' + id}, id));}
        catch (error) {observe(id, {deliveries: [], deferred: true, detail: 'delivery_failed'}); throw error;}
      }
    }});
    const isPaused = execution.gate.isPaused.bind(execution.gate), beginWrite = execution.gate.beginWrite.bind(execution.gate), finishWrite = execution.gate.finishWrite.bind(execution.gate);
    const deliveryGate = {
      isPaused,
      beginWrite() {
        const ticket = beginWrite();
        if (ticket !== null && ticket !== undefined) {
          let release!: () => void;
          const finalized = new Promise<void>(resolve => {release = resolve;}); physical.add(finalized);
          const reads = recoveryReads.getStore();
          deliveryTickets.set(ticket, () => {
            const finish = () => {finishWrite(ticket); physical.delete(finalized); deliveryTickets.delete(ticket); release();};
            if (!reads?.size) {finish(); return;}
            // Authority budgets can reject before their reads physically settle.
            // Wait only this recovery's reads, never the global drain containing
            // this finalizer or another concurrent recovery's held reads.
            void (async () => {while (reads.size) await Promise.all([...reads]); finish();})().catch(() => {});
          });
        }
        return ticket;
      },
      finishWrite(ticket: unknown) {
        // Only the original delivery finalizer releases its original gate ticket.
        // A throwing finish remains pending and yields cleanup_unknown on close.
        deliveryTickets.get(ticket)?.();
      },
    };
    const rawIntake = createIntake(execution), roles = createRoles(execution.gate);
    if (typeof rawIntake.readResults !== 'function') throw Error('pilot_results_unavailable');
    // Capture adapter callbacks before exposing the assembled pilot. Track actual
    // settlements because bounded recovery can return before its reads settle.
    const readReceipt = rawIntake.readReceipt.bind(rawIntake), readResults = rawIntake.readResults.bind(rawIntake), submitMessage = rawIntake.submitMessage.bind(rawIntake), cancelReceipt = rawIntake.cancelReceipt?.bind(rawIntake);
    const intake: BotConversationIntakePort = {readReceipt: input => track(readReceipt(input)), readResults: input => track(readResults(input)), submitMessage: input => track(submitMessage(input)), ...(cancelReceipt ? {cancelReceipt: input => track(cancelReceipt(input))} : {})};
    preparation = createWecomBotPreparation({mode, gate: execution.gate, createClient, connect, disconnect, readFingerprint,
      ...(timeoutMs === undefined ? {} : {timeoutMs}), ...(signal ? {signal} : {}),
      assemble(client, boundary) {
        admitted = boundary.admit.bind(boundary);
        try {
          adapter = createBotSdkAdapter({mode, client: client as WSClient});
          const sdk = {...adapter, ready: () => active() && adapter!.ready()};
          sender = createBotSender({sdk});
          authority = createWecomBotContext({...identity, mode, botId, corpId,
            readSubject: scope => track(readSubject(scope), recoveryReads.getStore()), readBinding: (subject, scope) => track(identity.readBinding(subject, scope), recoveryReads.getStore()), readNative: (id, scope) => track(identity.readNative(id, scope), recoveryReads.getStore())});
          delivery = createBotConversationDelivery({authority, ledger: business.ledger, sender, intake, gate: deliveryGate, scope: business.scope, employees: business.employees});
          assembly = createWecomBotAssembly({mode, botId, corpId, client, identity,
            businesses: [{scope: business.scope, employees: business.employees, ledger: business.ledger, conversations: {store: business.store, native: roles, intake, deliveryGate: execution.gate}}], sender: {sdk}, executionBoundary: boundary, ...(onOutcome ? {onOutcome} : {})});
          return {close: stopOwned, idle};
        } catch (error) {
          try {stopOwned();} catch (cleanupError) {throw new AggregateError([error, cleanupError], 'pilot_assembly_cleanup_failed');}
          throw error;
        }
      },
    });
  } catch (error) {stopped = true; throw error;}
  const owner = preparation;
  return Object.freeze({prepare: owner.prepare, activate: owner.activate, status: owner.status, failure: owner.failure,
    idle, recover, close: () => {stopped = true; return owner.close();}});
}
