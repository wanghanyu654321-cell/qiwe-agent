import {expect,it} from 'vitest';
import {GroupQueue} from '../src/group-queue.js';
import {createAppointmentBootGate} from '../src/appointment-boot-gate.js';
import {initDatabase,closeDatabase} from '../src/db.js';

// A queue-only original-mode test of query allocation before runner attachment.
// This does not restore or execute the paused full O main, invoke a runner, or
// supply inventory/ready evidence to the appointment gate.
it('exposes the original cold queue query before attachProcess gives it a folder',async()=>{
 const gate=createAppointmentBootGate('original'),queue=new GroupQueue(gate);
 // O consults durable runtime-safety markers before any queue launch. Missing
 // SQLite must fail closed; initialize the actual isolated synthetic DB.
 initDatabase();
 queue.setHostModeChecker(()=>true);
 let observed:{conversation:string|null;attached:string|null}|undefined;
 let callbackError:unknown;
 let resolveSeen!:()=>void;
 const seen=new Promise<void>(resolve=>{resolveSeen=resolve;});
 queue.setProcessMessagesFn(async jid=>{try{observed={conversation:(queue as any).getConversationQueryId(jid),attached:queue.getActiveQueryId(jid)};}catch(error){callbackError=error;}finally{resolveSeen();}return true;});
 try{
  queue.enqueueMessageCheck('web:fullhost-query-identity');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([seen,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('QUEUE_CALLBACK_NOT_REACHED')),1000);})]);}finally{clearTimeout(timer);}
  expect(callbackError).toBeUndefined();
  expect(observed?.attached).toBeNull();
  expect(observed?.conversation).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  expect(gate.phase()).toBe('ready');
 }finally{await queue.shutdown(0);closeDatabase();}
});
