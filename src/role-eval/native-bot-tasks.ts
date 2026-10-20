import type {BotReadScope} from './wecom-bot-context.js';
import type {BotTaskOwner,BotTaskBackend} from './wecom-bot-task-store.js';
import {WORKBENCH_ROLES} from './workbench-access.js';
import {types} from 'node:util';

export type NativeBackend=Extract<BotTaskBackend,{kind:'native'}>;
type StartResult={state:'linked';referenceId:string;detail:string}|{state:'blocked'|'unknown';detail:string};
type CancelResult={state:'requested'|'blocked'|'unknown';detail:string};
type QueryResult={status:string;output:string|null;detail:string};

/** Trusted server projections only. This seam is not a Native runtime hook. */
export type NativeBotGrant=(work:()=>void)=>Promise<void>;
export interface NativeBotAdmission {owner:Readonly<BotTaskOwner>;backend:Readonly<NativeBackend>;key:string;withCurrent:NativeBotGrant;}
export interface NativeBotTaskPort {
 mode:'isolated-synthetic';enabled:boolean;
 inspect(owner:Readonly<BotTaskOwner>,backend:Readonly<NativeBackend>,scope:BotReadScope):Promise<unknown>;
 trigger(taskId:string,idempotencyKey:string,scope:BotReadScope,admission?:NativeBotAdmission):Promise<unknown>;
 getRun(runId:string,scope:BotReadScope):Promise<unknown>;
 cancelRun(runId:string,scope:BotReadScope,admission?:NativeBotAdmission):Promise<unknown>;
}

const unverifiable=()=>Error('native_unverifiable');
function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw unverifiable();
 return value as Record<string,unknown>;
}
function field(value:Record<string,unknown>,key:string):unknown{
 const descriptor=Object.getOwnPropertyDescriptor(value,key);
 if(!descriptor||!('value' in descriptor))throw unverifiable();
 return descriptor.value;
}
function text(value:unknown,max=200):value is string{return typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);}
export function capture(owner:BotTaskOwner,backend:NativeBackend,key:string){
 const input=object(owner),target=object(backend),values:Record<string,unknown>={};
 const names=['tenantId','storeId','accountId','workspaceJid','role','corpId','botId','memberId','bindingVersion'];
 for(const name of names)values[name]=field(input,name);
 if(Object.keys(input).some(name=>!names.includes(name)))throw unverifiable();
 for(const name of names.filter(name=>name!=='bindingVersion'))if(!text(values[name],name==='workspaceJid'?200:120))throw unverifiable();
 if(!WORKBENCH_ROLES.includes(values.role as BotTaskOwner['role'])||!Number.isSafeInteger(values.bindingVersion)||(values.bindingVersion as number)<1)throw unverifiable();
 const savedOwner=Object.freeze(values) as Readonly<BotTaskOwner>;
 const savedBackend=Object.freeze({kind:field(target,'kind'),taskId:field(target,'taskId'),profileId:field(target,'profileId'),workspaceJid:field(target,'workspaceJid')});
 if(Object.keys(target).some(name=>!['kind','taskId','profileId','workspaceJid'].includes(name))||savedBackend.kind!=='native'||!text(savedBackend.taskId)||!text(savedBackend.profileId)||!text(savedBackend.workspaceJid)||!text(key))throw unverifiable();
 return {owner:savedOwner,backend:savedBackend as Readonly<NativeBackend>,key};
}
export function inspectProjection(raw:unknown,owner:Readonly<BotTaskOwner>,backend:Readonly<NativeBackend>,starting:boolean){
 const root=object(raw),task=object(field(root,'task')),group=object(field(root,'group')),profile=object(field(root,'profile'));
 // Home repairs itself to the default profile. A role alias must use an
 // already-existing non-Home workspace, never a temporary Home binding.
 if(backend.workspaceJid===owner.workspaceJid||![0,false].includes(field(group,'is_home') as number|boolean))throw unverifiable();
 const folder=field(group,'folder'),status=field(task,'status');
 if(field(task,'id')!==backend.taskId||field(task,'chat_jid')!==backend.workspaceJid||field(group,'jid')!==backend.workspaceJid||!text(folder)||field(task,'group_folder')!==folder||field(group,'created_by')!==owner.accountId||field(task,'context_mode')!=='isolated'||field(task,'execution_type')!=='agent'||field(task,'execution_mode')!=='container'||field(group,'execution_mode')!=='container'||field(task,'deleted_at')!==null||typeof status!=='string'||!['active',...(starting?[]:['paused','completed'])].includes(status)||field(profile,'id')!==backend.profileId||field(profile,'owner_user_id')!==owner.accountId||field(profile,'status')!=='active'||field(root,'bindingProfileId')!==backend.profileId)throw unverifiable();
 // Only immutable primitives cross awaits; original rows may have extra secrets.
 return {folder};
}
const statuses=['queued','running','retry_wait','success','failed','cancelled','missed','delivered'] as const;
export function runProjection(raw:unknown,backend:Readonly<NativeBackend>,key:string,runId:string,folder:string){
 const row=object(raw),snapshot=object(field(row,'definition_snapshot')),status=field(row,'status'),result=field(row,'result');
 if(field(row,'id')!==runId||field(row,'task_id')!==backend.taskId||field(row,'idempotency_key')!==key||field(row,'trigger_type')!=='manual'||!statuses.includes(status as typeof statuses[number])||(result!==null&&(typeof result!=='string'||result.length>256000))||field(snapshot,'chat_jid')!==backend.workspaceJid||field(snapshot,'group_folder')!==folder||field(snapshot,'context_mode')!=='isolated'||field(snapshot,'execution_type')!=='agent'||field(snapshot,'execution_mode')!=='container')throw unverifiable();
 return {status:status as typeof statuses[number],result:result as string|null};
}

/** Isolated synthetic adapter: never starts a loop, resolves credentials or imports Native. */
export function createNativeBotTasks(options:{port?:NativeBotTaskPort}={}){
 const supplied=options.port;
 // Capture callbacks and the opt-in once; later option mutation cannot enable it.
 const mode=supplied?.mode,enabled=supplied?.enabled===true;
 const inspect=supplied?.inspect,trigger=supplied?.trigger,getRun=supplied?.getRun,cancelRun=supplied?.cancelRun;
 const port=Object.freeze({mode,enabled,inspect,trigger,getRun,cancelRun});
 const closing=new AbortController();
 function check(scope:BotReadScope){
  if(closing.signal.aborted)throw Error('native_closed');
  if(scope.signal.aborted)throw Error('native_cancelled');
  if(!Number.isFinite(scope.deadline)||performance.now()>=scope.deadline)throw Error('native_timeout');
 }
 async function bounded<T>(input:BotReadScope,work:(scope:BotReadScope)=>Promise<T>):Promise<T>{
  const parent={signal:input.signal,deadline:input.deadline};check(parent);
  const controller=new AbortController(),scope=Object.freeze({signal:controller.signal,deadline:parent.deadline});
  return new Promise<T>((resolve,reject)=>{
   let done=false;
   const finish=(error:unknown,value?:T)=>{if(done)return;done=true;clearTimeout(timer);parent.signal.removeEventListener('abort',cancel);closing.signal.removeEventListener('abort',close);controller.abort();if(error)reject(error);else resolve(value!);};
   const cancel=()=>finish(Error('native_cancelled')),close=()=>finish(Error('native_closed'));
   const timer=setTimeout(()=>finish(Error('native_timeout')),Math.min(2147483647,Math.max(0,parent.deadline-performance.now())));
   parent.signal.addEventListener('abort',cancel,{once:true});closing.signal.addEventListener('abort',close,{once:true});
   Promise.resolve().then(()=>{check(parent);return work(scope);}).then(value=>{try{check(scope);finish(null,value);}catch(error){finish(error);}},error=>finish(error));
  });
 }
 async function authorize(scope:BotReadScope,assertCurrent:()=>Promise<void>){
  check(scope);await assertCurrent();check(scope);
 }
 async function inspectCurrent(input:ReturnType<typeof capture>,scope:BotReadScope,assertCurrent:()=>Promise<void>,starting:boolean){
  if(mode!=='isolated-synthetic'||typeof inspect!=='function'||typeof getRun!=='function')throw Error('native_unavailable');
  await authorize(scope,assertCurrent);
  const raw=await inspect.call(port,Object.freeze({...input.owner}),Object.freeze({...input.backend}),scope);
  check(scope);const result=inspectProjection(raw,input.owner,input.backend,starting);
  await authorize(scope,assertCurrent);return result;
 }
 async function readRun(input:ReturnType<typeof capture>,runId:string,folder:string,scope:BotReadScope,assertCurrent:()=>Promise<void>){
  if(!text(runId)||typeof getRun!=='function')throw unverifiable();
  check(scope);const raw=await getRun.call(port,runId,scope);check(scope);
  const result=runProjection(raw,input.backend,input.key,runId,folder);
  await authorize(scope,assertCurrent);return result;
 }
 function detail(error:unknown):string{
  const code=error instanceof Error?error.message:'';
  return ['native_unavailable','native_timeout','native_cancelled','native_closed'].includes(code)?code:'native_unverifiable';
 }
 return {
  async start(owner:BotTaskOwner,backend:NativeBackend,key:string,scope:BotReadScope,assertCurrent:()=>Promise<void>,withCurrent?:NativeBotGrant):Promise<StartResult>{
   let invoked=false;
   try{
    const input=capture(owner,backend,key);
    if(!enabled)return {state:'blocked',detail:'native_disabled'};
    return await bounded(scope,async child=>{
     const {folder}=await inspectCurrent(input,child,assertCurrent,true);
     if(typeof trigger!=='function')throw Error('native_unavailable');
     await authorize(child,assertCurrent);check(child);invoked=true;
     const raw=await trigger.call(port,input.backend.taskId,input.key,child,withCurrent?Object.freeze({...input,withCurrent}):undefined);check(child);
     const receipt=object(raw),success=field(receipt,'success');
     const runId=success===true?field(receipt,'runId'):undefined;
     await authorize(child,assertCurrent);
     if(success===false)return {state:'blocked',detail:'native_trigger_rejected'};
     if(success!==true||!text(runId))throw unverifiable();
     await readRun(input,runId,folder,child,assertCurrent);
     return {state:'linked',referenceId:runId,detail:'native_occurrence_linked'};
    });
   }catch(error){return {state:invoked?'unknown':'blocked',detail:detail(error)};}
  },
  async query(owner:BotTaskOwner,backend:NativeBackend,key:string,runId:string,scope:BotReadScope,assertCurrent:()=>Promise<void>):Promise<QueryResult>{
   try{
    const input=capture(owner,backend,key);
    return await bounded(scope,async child=>{
     const {folder}=await inspectCurrent(input,child,assertCurrent,false);
     const run=await readRun(input,runId,folder,child,assertCurrent);
     return {status:run.status,output:run.status==='success'?run.result:null,detail:run.status==='delivered'?'native_prompt_delivered_only':run.status==='success'?'native_persisted_result':'native_occurrence_status'};
    });
   }catch(error){return {status:'unknown',output:null,detail:detail(error)};}
  },
  async cancel(owner:BotTaskOwner,backend:NativeBackend,key:string,runId:string,scope:BotReadScope,assertCurrent:()=>Promise<void>,withCurrent?:NativeBotGrant):Promise<CancelResult>{
   let invoked=false;
   try{
    const input=capture(owner,backend,key);
    if(!enabled)return {state:'blocked',detail:'native_disabled'};
    return await bounded(scope,async child=>{
     const {folder}=await inspectCurrent(input,child,assertCurrent,false);
     const run=await readRun(input,runId,folder,child,assertCurrent);
     if(!['queued','running','retry_wait','delivered'].includes(run.status))return {state:'blocked',detail:'native_occurrence_terminal'};
     if(typeof cancelRun!=='function')throw Error('native_unavailable');
     await authorize(child,assertCurrent);check(child);invoked=true;
     const raw=await cancelRun.call(port,runId,child,withCurrent?Object.freeze({...input,withCurrent}):undefined);check(child);
     const success=field(object(raw),'success');await authorize(child,assertCurrent);
     if(success===false)return {state:'blocked',detail:'native_cancel_rejected'};
     if(success!==true)throw unverifiable();
     return {state:'requested',detail:'native_cancel_requested'};
    });
   }catch(error){return {state:invoked?'unknown':'blocked',detail:detail(error)};}
  },
  close(){closing.abort();}
 };
}
