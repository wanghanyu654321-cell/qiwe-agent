import {isDeepStrictEqual} from 'node:util';
import type {WorkbenchRole} from './workbench-access.js';
import {resolveWorkbenchAuthority,type WorkbenchAuthorityCatalog} from './workbench-authority.js';
import {snapshotBinding,type WecomBotSubject,type WecomBotBinding} from './wecom-bot-bindings.js';
export interface BotReadScope {readonly signal:AbortSignal;readonly deadline:number;}
export interface BotContextRequest extends BotReadScope {readonly correlationId:string;}
export interface WecomBotContext {readonly identity:Readonly<ReturnType<typeof resolveWorkbenchAuthority>['identity']>;readonly roles:readonly WorkbenchRole[];readonly correlationId:string;}
export interface WecomBotContextOptions extends WorkbenchAuthorityCatalog {
 mode:'isolated-synthetic';botId:string;corpId:string;
 readSubject(scope:BotReadScope):Promise<WecomBotSubject>;
 readBinding(subject:Readonly<WecomBotSubject>,scope:BotReadScope):Promise<WecomBotBinding>;
 readNative(accountId:string,scope:BotReadScope):Promise<{user:unknown;workspaceJid:string}>;
}
/** In-process authority only. No SDK, HTTP registration, credentials or business execution. */
export function createWecomBotContext(options:WecomBotContextOptions){
 if(options.mode!=='isolated-synthetic'||!options.botId||!options.corpId)throw Error('invalid_bot_catalog');
 const catalog={tenantId:options.tenantId,stores:structuredClone(options.stores),roles:[...options.roles],store:options.store};catalog.store.bindTenant(catalog.tenantId);
 const {botId,corpId,readSubject,readBinding,readNative}=options,closing=new AbortController();
 type Snapshot={subject:WecomBotSubject;binding:WecomBotBinding;native:{user:unknown;workspaceJid:string};authority:ReturnType<typeof resolveWorkbenchAuthority>};
 const issued=new WeakMap<object,{request:BotContextRequest;required:WorkbenchRole;snapshot:Snapshot}>();
 function check(scope:BotReadScope){if(closing.signal.aborted)throw Error('context_closed');if(scope.signal.aborted)throw Error('authority_cancelled');if(!Number.isFinite(scope.deadline)||performance.now()>=scope.deadline)throw Error('authority_timeout');}
 async function bounded<T>(scope:BotReadScope,work:(scope:BotReadScope)=>Promise<T>):Promise<T>{
 check(scope);const controller=new AbortController(),child={signal:controller.signal,deadline:scope.deadline};
 return new Promise<T>((resolve,reject)=>{let done=false;
 const finish=(error:Error|null,value?:T)=>{if(done)return;done=true;clearTimeout(timer);scope.signal.removeEventListener('abort',cancel);closing.signal.removeEventListener('abort',close);controller.abort();if(error)reject(error);else resolve(value!);};
 const cancel=()=>finish(Error('authority_cancelled')),close=()=>finish(Error('context_closed'));
 const timer=setTimeout(()=>finish(Error('authority_timeout')),Math.min(2147483647,Math.max(0,scope.deadline-performance.now())));
 scope.signal.addEventListener('abort',cancel,{once:true});closing.signal.addEventListener('abort',close,{once:true});
 Promise.resolve().then(()=>{check(scope);return work(child);}).then(value=>{try{check(scope);finish(null,value);}catch(error){finish(error as Error);}},error=>{try{check(scope);}catch(budgetError){finish(budgetError as Error);return;}const code=error instanceof Error?error.message:'';finish(Error(['access_denied','access_not_open','access_home_unavailable'].includes(code)?'access_denied':'authority_unavailable'));});
 });
 }
 async function read(scope:BotReadScope,required:WorkbenchRole):Promise<Snapshot>{return bounded(scope,async child=>{
 const subject=structuredClone(await readSubject(child));check(child);
 if(!subject||subject.botId!==botId||typeof subject.memberId!=='string'||!subject.memberId||Object.keys(subject).some(k=>!['botId','memberId'].includes(k)))throw Error('access_denied');
 const binding=snapshotBinding(await readBinding(Object.freeze({...subject}),child));check(child);
 if(!binding.active||binding.botId!==botId||binding.corpId!==corpId||binding.memberId!==subject.memberId)throw Error('access_denied');
 const native=structuredClone(await readNative(binding.accountId,child));check(child);
 const authority=resolveWorkbenchAuthority(catalog,native.user,native.workspaceJid);
 if(authority.identity.accountId!==binding.accountId||!authority.grant.roles.includes(required))throw Error('access_denied');return {subject,binding,native,authority};
 });}
 return {
 async authorize(request:BotContextRequest,required:WorkbenchRole):Promise<WecomBotContext>{
 const input={correlationId:request.correlationId,signal:request.signal,deadline:request.deadline};
 if(typeof input.correlationId!=='string'||!input.correlationId||input.correlationId.length>200)throw Error('access_denied');
 const first=await read(input,required),current=await read(input,required);if(!isDeepStrictEqual(first,current))throw Error('access_changed');check(input);
 const context=Object.freeze({identity:Object.freeze({...current.authority.identity}),roles:Object.freeze([...current.authority.grant.roles]),correlationId:input.correlationId});issued.set(context,{request:input,required,snapshot:current});return context;
 },
 async assertCurrent(context:WecomBotContext):Promise<void>{
 if(closing.signal.aborted)throw Error('context_closed');const own=context&&issued.get(context);if(!own)throw Error('access_denied');
 let current:Snapshot;try{current=await read(own.request,own.required);}catch(error){if(error instanceof Error&&error.message==='access_denied')throw Error('access_changed');throw error;}
 if(!isDeepStrictEqual(current,own.snapshot))throw Error('access_changed');check(own.request);
 },
 close(){closing.abort();}
 };
}
