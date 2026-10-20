import {types} from 'node:util';
import type {BotReadScope} from './wecom-bot-context.js';
import type {NativeBotTaskPort} from './native-bot-tasks.js';

/** Exact synchronous reads from an already initialized original server.
 * Do not import/init Native or use getters that repair default Profiles here. */
export interface NativeBotReaders {
 getTaskById(id:string):unknown;
 getRegisteredGroup(jid:string):unknown;
 getAgentProfile(id:string):unknown;
 getWorkspaceAgentProfileBinding(folder:string):unknown;
 getTaskRunById(id:string):unknown;
}
const unavailable=()=>Error('native_read_unverifiable');
function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw unavailable();
 return value as Record<string,unknown>;
}
function field(row:Record<string,unknown>,key:string):unknown{
 const entry=Object.getOwnPropertyDescriptor(row,key);if(!entry||!('value' in entry))throw unavailable();return entry.value;
}
function pick(value:unknown,keys:readonly string[]):Record<string,unknown>{
 const row=object(value),copy:Record<string,unknown>={};
 for(const key of keys){const item=field(row,key);if(item!==null&&!['string','number','boolean'].includes(typeof item))throw unavailable();copy[key]=item;}
 return copy;
}
function id(value:unknown):string{if(typeof value!=='string'||!value||value.length>200||/[\s\u0000-\u001f]/.test(value))throw unavailable();return value;}

/** Read-only projection bridge. This never exposes trigger/pump/cancel functions.
 * enabled=false is deliberate: the original trigger also advances global work. */
export function createNativeBotReadPort(options:{mode:'isolated-synthetic';readers:NativeBotReaders}):NativeBotTaskPort&{close():void}{
 const names=['getTaskById','getRegisteredGroup','getAgentProfile','getWorkspaceAgentProfileBinding','getTaskRunById'] as const;
 let source:Record<string,unknown>,callbacks:Record<(typeof names)[number],(key:string)=>unknown>;
 try{
  const input=object(options);if(field(input,'mode')!=='isolated-synthetic'||Object.keys(input).some(k=>!['mode','readers'].includes(k)))throw unavailable();
  source=object(field(input,'readers'));if(Object.keys(source).some(k=>!names.includes(k as typeof names[number])))throw unavailable();
  callbacks=Object.fromEntries(names.map(name=>{const callback=field(source,name);if(typeof callback!=='function')throw unavailable();return [name,callback.bind(source)];})) as typeof callbacks;
 }catch{throw Error('invalid_native_read_port');}
 let closed=false;
 const check=(scope:BotReadScope)=>{
  if(closed)throw Error('native_read_closed');if(scope.signal.aborted)throw Error('native_read_cancelled');
  if(!Number.isFinite(scope.deadline)||performance.now()>=scope.deadline)throw Error('native_read_timeout');
 };
 const read=(name:typeof names[number],key:string,scope:BotReadScope)=>{
  check(scope);const result=callbacks[name](id(key));
  if(types.isPromise(result)){
   // Reject async providers without leaving their rejection unhandled, even if
   // the provider also aborted this scope. Do not await or accept its result.
   void Promise.prototype.then.call(result,()=>undefined,()=>undefined);
   check(scope);throw unavailable();
  }
  check(scope);return result;
 };
 const port:NativeBotTaskPort&{close():void}={
  mode:'isolated-synthetic',enabled:false,
  async inspect(_owner,backend,scope){
   const task=pick(read('getTaskById',backend.taskId,scope),['id','chat_jid','group_folder','execution_type','execution_mode','status','deleted_at']);
   const original=object(read('getRegisteredGroup',id(task.chat_jid),scope));
   const group=pick(original,['jid','folder','created_by','is_home']);
   group.execution_mode=field(original,'executionMode');
   if(typeof group.execution_mode!=='string')throw unavailable();
   const binding=object(read('getWorkspaceAgentProfileBinding',id(group.folder),scope)),bindingProfileId=id(field(binding,'agent_profile_id'));
   const profile=pick(read('getAgentProfile',bindingProfileId,scope),['id','owner_user_id','status']);
   check(scope);return {task,group,profile,bindingProfileId};
  },
  async getRun(runId,scope){
   const original=object(read('getTaskRunById',runId,scope));
   const run=pick(original,['id','task_id','idempotency_key','trigger_type','status','result']);
   // getTaskRunById already decodes the stored JSON. Never guess or double-parse.
   run.definition_snapshot=pick(field(original,'definition_snapshot'),['chat_jid','group_folder','execution_type','execution_mode']);
   check(scope);return run;
  },
  async trigger(_taskId,_key,scope){check(scope);throw Error('native_disabled');},
  async cancelRun(_runId,scope){check(scope);throw Error('native_disabled');},
  close(){closed=true;}
 };
 return Object.freeze(port);
}
