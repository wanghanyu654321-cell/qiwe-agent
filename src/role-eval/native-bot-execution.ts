import {types} from 'node:util';
import type {BotReadScope} from './wecom-bot-context.js';
import {createNativeBotReadPort,type NativeBotReaders} from './native-bot-service.js';
import {capture,inspectProjection,runProjection,type NativeBotTaskPort,type NativeBotAdmission} from './native-bot-tasks.js';

/** Supplied by the source-anchored patch in the original process. */
export interface NativeTargetedAdmission extends BotReadScope {
 withCurrent(work:()=>void):Promise<void>;
 revalidate():void;
}
export interface NativeTargetedFunctions {
 triggerTaskRunTargeted(taskId:string,key:string,admission:NativeTargetedAdmission):Promise<unknown>;
 cancelTaskRunTargeted(runId:string,admission:NativeTargetedAdmission):Promise<unknown>;
}
export interface NativeBotExecutionOptions {
 mode:'isolated-synthetic';enabled?:boolean|undefined;readers:NativeBotReaders;target:NativeTargetedFunctions;
}

/** Explicit local synthetic execution. Owns no Native DB, deps, queue or gate. */
export function createNativeBotExecutionPort(options:NativeBotExecutionOptions):NativeBotTaskPort&{close():void}{
 if(options.mode!=='isolated-synthetic')throw Error('invalid_native_execution_port');
 const enabled=options.enabled===true,read=createNativeBotReadPort({mode:options.mode,readers:options.readers});
 const trigger=options.target.triggerTaskRunTargeted.bind(options.target),cancel=options.target.cancelTaskRunTargeted.bind(options.target);
 let closed=false;
 const check=(scope:BotReadScope)=>{if(closed||scope.signal.aborted||!Number.isFinite(scope.deadline)||performance.now()>=scope.deadline)throw Error('native_execution_unavailable');};
 function admission(raw:NativeBotAdmission,scope:BotReadScope,starting:boolean,runId?:string):NativeTargetedAdmission{
  const input=capture(raw.owner,raw.backend,raw.key),transaction=raw.withCurrent;
  if(typeof transaction!=='function')throw Error('native_execution_grant_required');
  const savedScope=Object.freeze({signal:scope.signal,deadline:scope.deadline});
  const revalidate=()=>{
   check(savedScope);
   const {folder}=inspectProjection(read.inspectSync(input.backend,savedScope),input.owner,input.backend,starting);
   if(runId)runProjection(read.getRunSync(runId,savedScope),input.backend,input.key,runId,folder);
   check(savedScope);
  };
  return Object.freeze({...savedScope,revalidate,async withCurrent(work:()=>void){
   check(savedScope);let called=false,open=true;
   try{
    await transaction(()=>{if(!open)throw Error('native_execution_transaction_closed');if(called)throw Error('native_execution_duplicate_transaction');called=true;revalidate();const out:unknown=work();if(types.isPromise(out)){void out.catch(()=>{});throw Error('native_execution_async_transaction');}});
    if(!called)throw Error('native_execution_missing_transaction');
   }finally{open=false;}
  }});
 }
 return Object.freeze({mode:'isolated-synthetic',enabled,inspect:read.inspect,getRun:read.getRun,
  async trigger(taskId:string,key:string,scope:BotReadScope,raw?:NativeBotAdmission){
   check(scope);if(!enabled||!raw)return {success:false,error:'native_disabled'};
   if(raw.backend.taskId!==taskId||raw.key!==key)throw Error('native_execution_target_changed');
   return trigger(taskId,key,admission(raw,scope,true));
  },
  async cancelRun(runId:string,scope:BotReadScope,raw?:NativeBotAdmission){
   check(scope);if(!enabled||!raw)return {success:false,error:'native_disabled'};
   return cancel(runId,admission(raw,scope,false,runId));
  },
  close(){closed=true;read.close();}
 });
}
