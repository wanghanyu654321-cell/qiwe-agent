import type {WSClient} from '@wecom/aibot-node-sdk';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createWecomBotPreparation,createControlledRealWecomBotPreparation,type WecomBotPreparationOptions,type WecomPreparationGate} from './wecom-bot-preparation.js';
import {createWecomBotAssembly,createControlledRealWecomBotAssembly,type WecomBotAssemblyOptions} from './wecom-bot-assembly.js';
import {createWecomBotContext,createControlledRealWecomBotContext,type WecomBotContextOptions,type BotContextRequest} from './wecom-bot-context.js';
import {createBotSdkAdapter,createControlledRealBotSdkAdapter} from './wecom-bot-sdk.js';
import {createBotSender,createControlledRealBotSender} from './wecom-bot-sender.js';
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
  if (options.mode !== 'isolated-synthetic'||'real' in options||typeof options.initializeExecution!=='function')throw Error('invalid_bot_pilot');
  const initialize=options.initializeExecution.bind(options);
  return createPilot({...options,initializeExecution:input=>initialize({...input,mode:'isolated-synthetic'})});
}

type PilotMode='isolated-synthetic'|'controlled-real-pilot';
type SharedPilotOptions=Omit<WecomBotPilotOptions,'mode'|'initializeExecution'|'createClient'|'connect'|'disconnect'>&Partial<Pick<WecomBotPilotOptions,'createClient'|'connect'|'disconnect'>>&{mode:PilotMode;initializeExecution(options:{mode:PilotMode;authorize:WecomBotPilotOptions['authorize'];onCompleted:(ids:string[])=>Promise<void>}):WecomBotPilotExecution;real?:{memberId:string;secret:string;admit:()=>boolean}};
function createPilot(options:SharedPilotOptions) {
  if (['initializeExecution', 'authorize', 'createIntake', 'createRoles', 'readSubject', 'readFingerprint'].some(key => typeof Reflect.get(options,key) !== 'function')) throw Error('invalid_bot_pilot');
  const {mode,botId,corpId,timeoutMs,signal,onOutcome,onDelivery} = options;
  const initialize = options.initializeExecution.bind(options), authorize = options.authorize.bind(options);
  const createIntake = options.createIntake.bind(options), createRoles = options.createRoles.bind(options);
  const createClient = options.createClient?.bind(options), connect = options.connect?.bind(options), disconnect = options.disconnect?.bind(options), readFingerprint = options.readFingerprint.bind(options);
  const real=options.real;
  if(!real&&(!createClient||!connect||!disconnect))throw Error('invalid_bot_pilot');
  const createSender=real?createControlledRealBotSender:createBotSender;
  const createContext=(value:Omit<WecomBotContextOptions,'mode'>)=>real?createControlledRealWecomBotContext({...value,mode:'controlled-real-pilot'}):createWecomBotContext({...value,mode:'isolated-synthetic'});
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
    const execution = initialize({mode, authorize:real?receipt=>active()&&authorize(receipt):authorize, onCompleted: async ids => {
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
    const preparationOptions={gate: execution.gate, readFingerprint,
      ...(timeoutMs === undefined ? {} : {timeoutMs}), ...(signal ? {signal} : {}),
      assemble(client:Parameters<WecomBotPreparationOptions['assemble']>[0], boundary:Parameters<WecomBotPreparationOptions['assemble']>[1]) {
        admitted = boundary.admit.bind(boundary);
        try {
          adapter = real?createControlledRealBotSdkAdapter({mode:'controlled-real-pilot',client:client as WSClient,botId,corpId,memberId:real.memberId,admit:()=>real.admit()&&admitted()}):createBotSdkAdapter({mode:'isolated-synthetic', client: client as WSClient});
          const sdk = {...adapter, ready: () => active() && adapter!.ready()};
          sender = createSender({sdk});
          authority = createContext({...identity, botId, corpId,
            readSubject: scope => track(readSubject(scope), recoveryReads.getStore()), readBinding: (subject, scope) => track(identity.readBinding(subject, scope), recoveryReads.getStore()), readNative: (id, scope) => track(identity.readNative(id, scope), recoveryReads.getStore())});
          delivery = createBotConversationDelivery({authority, ledger: business.ledger, sender, intake, gate: deliveryGate, scope: business.scope, employees: business.employees});
          const assemblyOptions={botId, corpId, client, identity,
            businesses: [{scope: business.scope, employees: business.employees, ledger: business.ledger, conversations: {store: business.store, native: roles, intake, deliveryGate: execution.gate}}], sender: {sdk}, executionBoundary: boundary, ...(onOutcome ? {onOutcome} : {})};
          assembly=real?createControlledRealWecomBotAssembly({...assemblyOptions,mode:'controlled-real-pilot',memberId:real.memberId}):createWecomBotAssembly({...assemblyOptions,mode:'isolated-synthetic'});
          return {close: stopOwned, idle};
        } catch (error) {
          try {stopOwned();} catch (cleanupError) {throw new AggregateError([error, cleanupError], 'pilot_assembly_cleanup_failed');}
          throw error;
        }
      },
    };
    preparation=real?createControlledRealWecomBotPreparation({...preparationOptions,mode:'controlled-real-pilot',botId,secret:real.secret}):createWecomBotPreparation({...preparationOptions,mode:'isolated-synthetic',createClient:createClient!,connect:connect!,disconnect:disconnect!});
  } catch (error) {stopped = true; throw error;}
  const owner = preparation;
  return Object.freeze({prepare: owner.prepare, activate: owner.activate, status: owner.status, failure: owner.failure,
    idle, recover, close: () => {stopped = true; return owner.close();}});
}


/** One operator-owned local run. This is additional scope over original live authority. */
export interface ControlledRealPilotAdmission {
  mode:'controlled-real-pilot';environment:'local-test';runId:string;expiresAt:number;
  botId:string;corpId:string;memberId:string;accountId:string;tenantId:string;storeId:string;
  roles:WecomBotContextOptions['roles'];bindingVersion:number;configVersion:string;
  credentialFingerprint:string;workspaceFingerprint:string;
}
export type ControlledRealWecomBotPilotOptions=Omit<WecomBotPilotOptions,'mode'|'botId'|'corpId'|'readSubject'|'createClient'|'connect'|'disconnect'|'initializeExecution'>&{
  mode:'controlled-real-pilot';admission:ControlledRealPilotAdmission;secret:string;
  initializeExecution(options:{mode:'controlled-real-pilot';authorize:WecomBotPilotOptions['authorize'];onCompleted:(ids:string[])=>Promise<void>}):WecomBotPilotExecution;
};
export function createControlledRealWecomBotPilot(options:ControlledRealWecomBotPilotOptions){
  const a=structuredClone(options.admission),valid=(v:unknown):v is string=>typeof v==='string'&&!!v&&v.length<=120&&!/[\s\u0000]/.test(v);
  if(options.mode!=='controlled-real-pilot'||!a||a.mode!=='controlled-real-pilot'||a.environment!=='local-test'||
    ![a.runId,a.botId,a.corpId,a.memberId,a.accountId,a.tenantId,a.storeId,a.configVersion,a.credentialFingerprint,a.workspaceFingerprint].every(valid)||
    !Number.isSafeInteger(a.expiresAt)||a.expiresAt<=Date.now()||a.expiresAt>Date.now()+3_600_000||!Number.isSafeInteger(a.bindingVersion)||a.bindingVersion<1||
    !Array.isArray(a.roles)||!a.roles.length||new Set(a.roles).size!==a.roles.length||a.roles.some(r=>!['marketing','ads','manager'].includes(r))||
    typeof options.secret!=='string'||!options.secret.trim()||['createClient','connect','disconnect','readSubject'].some(k=>k in options)||
    options.identity.tenantId!==a.tenantId||!a.roles.every(r=>options.identity.roles.includes(r))||!options.identity.stores.some(s=>s.id===a.storeId)||
    options.business.scope.tenant!==a.tenantId||options.business.scope.store!==a.storeId||options.business.employees.length!==1||options.business.employees[0]?.accountId!==a.accountId)
    throw Error('invalid_real_pilot_admission');
  const initialize=options.initializeExecution.bind(options),originalAuthorize=options.authorize.bind(options),readBinding=options.identity.readBinding.bind(options.identity),readNative=options.identity.readNative.bind(options.identity),fingerprint=options.readFingerprint.bind(options);
  const store=options.identity.store,roles=[...a.roles],timeoutMs=options.timeoutMs??4000,signal=options.signal;
  const grantVersion=store.get(a.accountId)?.version;
  const admit=()=>{const g=store.get(a.accountId);return Date.now()<a.expiresAt&&g?.active===true&&g.version===grantVersion&&g.storeId===a.storeId&&g.roles.length===roles.length&&g.roles.every(r=>roles.includes(r));};
  const identity={...options.identity,stores:[{id:a.storeId}],roles,
    readBinding:async(subject:Parameters<typeof readBinding>[0],scope:Parameters<typeof readBinding>[1])=>{
      if(!admit()||subject.botId!==a.botId||subject.memberId!==a.memberId)throw Error('access_denied');
      const b=structuredClone(await readBinding(Object.freeze({...subject}),scope));
      if(!admit()||!b?.active||b.botId!==a.botId||b.corpId!==a.corpId||b.memberId!==a.memberId||b.accountId!==a.accountId||b.version!==a.bindingVersion)throw Error('access_denied');return b;
    },
    readNative:async(id:string,scope:Parameters<typeof readNative>[1])=>{if(id!==a.accountId||!admit())throw Error('access_denied');return readNative(id,scope);}};
  const readSubject=async()=>({botId:a.botId,memberId:a.memberId});
  const readFingerprint=()=>{
    if(!admit())throw Error('access_denied');const f=structuredClone(fingerprint());
    if(f.botId!==a.botId||f.corpId!==a.corpId||f.ownerId!==a.accountId||f.configVersion!==a.configVersion||f.credentialFingerprint!==a.credentialFingerprint||f.workspaceFingerprint!==a.workspaceFingerprint)throw Error('invalid_real_pilot_admission');return f;
  };
  // Refuse missing live grants/config before constructing or binding anything.
  readFingerprint();
  const authorize:WecomBotPilotOptions['authorize']=r=>!!r?.actor&&admit()&&r.actor.tenantId===a.tenantId&&r.actor.accountId===a.accountId&&r.actor.storeId===a.storeId&&r.actor.botId===a.botId&&r.actor.corpId===a.corpId&&r.actor.memberId===a.memberId&&r.actor.bindingVersion===a.bindingVersion&&r.actor.grantVersion===store.get(a.accountId)?.version&&roles.includes(r.role)&&originalAuthorize(structuredClone(r));
  const pilot=createPilot({...options,botId:a.botId,corpId:a.corpId,identity,readSubject,readFingerprint,authorize,
    initializeExecution:input=>initialize({...input,mode:'controlled-real-pilot'}),real:{memberId:a.memberId,secret:options.secret,admit}});
  let closed=false;
  const close=()=>{closed=true;clearTimeout(timer);return pilot.close();};
  const timer=setTimeout(()=>{void close();},Math.max(1,a.expiresAt-Date.now()));timer.unref();
  return Object.freeze({...pilot,close,async prepare(){
    if(closed||!admit())throw Error('access_denied');
    const authority=createControlledRealWecomBotContext({...identity,mode:'controlled-real-pilot',botId:a.botId,corpId:a.corpId,readSubject});
    try{await authority.authorize({signal:signal??new AbortController().signal,deadline:performance.now()+timeoutMs,correlationId:'pilot-preconnect-'+a.runId},null);if(closed||!admit())throw Error('access_denied');return await pilot.prepare();}
    catch(error){await close();throw error;}finally{authority.close();}
  }});
}
