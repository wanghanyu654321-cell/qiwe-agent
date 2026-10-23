import {expect,it,vi} from 'vitest';
import {bindGeneratedWrapper} from '../test-support/full-host-generated-wrapper.mjs';

const initial={status:'success',result:'initial result',turnId:'initial',inputTurnId:'initial',inputTurnCompleted:true,newSessionId:'initial-session'};
const warm={status:'success',result:'warm result',turnId:'warm',inputTurnId:'warm',inputTurnCompleted:true,newSessionId:'warm-session'};
function fixture(callbacks:any[],returned:any){
 const forwarded:any[]=[],sessions:any[]=[],finished:any[]=[],completed:any[]=[];
 const invalidated=vi.fn();
 const runner=vi.fn(async(_g:any,_i:any,_p:any,onOutput:any)=>{for(const callback of callbacks)await onOutput(callback);return returned;});
 const run=bindGeneratedWrapper({runContainerAgent:runner,conversationBatchActive:()=>true,assertConversationBatchCurrent:()=>{},invalidateConversationProjection:invalidated,
  noteConversationSession:(...args:any[])=>sessions.push(args),finishConversationBatch:(...args:any[])=>{finished.push(args);return args[2]==='completed'?['initial-receipt']:[];},onCompleted:(ids:any)=>completed.push(ids),logger:{warn:vi.fn()}});
 return {run:()=>run({}, {chatJid:'web:workspace',queryRunId:'initial-query',turnId:'initial'},()=>{},async(event:any)=>{forwarded.push(event);}),forwarded,sessions,finished,completed,runner,invalidated};
}

it('passes legitimate later warm outputs through the generated real-runner wrapper without attributing them to the initial conversation',async()=>{
 for(const later of [warm,{...warm,status:'error',providerFailure:{kind:'synthetic'}},{status:'stream',result:null,turnId:'warm',streamEvent:{eventType:'status',statusText:'interrupted',turnId:'warm'}}]){
  const f=fixture([initial,later],later);
  await expect(f.run()).resolves.toEqual(later);
  expect(f.forwarded).toEqual([initial,later]);
  expect(f.sessions).toEqual([['web:workspace','initial-query','initial-session']]);
  expect(f.finished).toEqual([['web:workspace','initial-query','completed','initial-session']]);
  expect(f.completed).toEqual([['initial-receipt']]);expect(f.invalidated).not.toHaveBeenCalled();
 }
});

it('never turns a later warm terminal return or mixed identity into an initial D5 result',async()=>{
 for(const callbacks of [[warm],[{...initial,inputTurnId:'foreign'}],[]]){
  const f=fixture(callbacks,warm);await expect(f.run()).resolves.toEqual(warm);
  expect(f.forwarded).toEqual(callbacks);expect(f.sessions).toEqual([]);
  expect(f.finished).toEqual([['web:workspace','initial-query','unknown',undefined]]);expect(f.completed).toEqual([]);
  expect(f.invalidated).not.toHaveBeenCalled();
 }
});
