import {expect,it,vi} from 'vitest';
import path from 'node:path';
import {initDatabase,closeDatabase} from '../src/db.js';
import * as db from '../src/db.js';
import {STORE_DIR} from '../src/config.js';
import {createAppointmentBootGate} from '../src/appointment-boot-gate.js';
import {processClaimedTaskRunNotification} from '../src/task-scheduler.js';
import Database from 'better-sqlite3';

// Exact original scheduler and SQLite claims. Original-mode gate here only
// tests a notification invocation; this does not restore the paused O main.
it('fences stale original notification claims before transport and between awaited batch items',async()=>{
 initDatabase();const sql=new Database(path.join(STORE_DIR,'messages.db'));
 const taskId='execution-fix-notification',now=new Date().toISOString();
 db.createTask({id:taskId,group_folder:'full-role',chat_jid:'web:full-role',prompt:'synthetic never run',context_mode:'group',execution_type:'agent',execution_mode:'container',script_command:null,schedule_type:'once',schedule_value:now,next_run:null,status:'paused',created_at:now,created_by:null,notify_channels:null});
 const payload={kind:'send_message',chatJid:'web:full-role',text:'synthetic no external send'};
 let serial=0;const runs:string[]=[];
 const create=(body:any=payload)=>{
  const run=db.createTaskRun({task:db.getTaskById(taskId)!,triggerType:'manual',idempotencyKey:'execution-fix-'+serial++}).run;runs.push(run.id);
  sql.prepare("UPDATE task_runs SET status='delivered',notification_status='failed',notification_payload=?,notification_available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(JSON.stringify(body),run.id);
  const claim=db.claimTaskRunNotificationById(run.id,'synthetic-old',60000)!;expect(claim).toBeDefined();return claim;
 };
 const sends=vi.fn(async()=>{}),gate=createAppointmentBootGate('original');
 const deps:any={appointmentBootGate:gate,sendMessage:sends};
 const row=(id:string)=>sql.prepare('SELECT * FROM task_runs WHERE id=?').get(id);
 const cancel=(runId:string)=>db.cancelDeliveredGroupTaskRunWithWorkspaceIntent({runId,taskId,reason:'synthetic cancel',payload:{kind:'workspace_result',chatJid:payload.chatJid,text:'synthetic cancellation',groupRunId:runId,groupTaskId:taskId,groupStatus:'cancelled',groupResult:null,groupError:'synthetic cancel',options:{sourceKind:'scheduled_task_result',messageId:'scheduled-group-terminal:'+runId,workspaceFolder:'full-role'}}});
 try{
  for(const reason of ['expired','reclaimed','cancelled']){
   sends.mockClear();const claim=create();
   if(reason!=='cancelled')sql.prepare("UPDATE task_runs SET notification_lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(claim.runId);
   if(reason==='reclaimed'){const next=db.claimTaskRunNotificationById(claim.runId,'synthetic-new',60000)!;expect(next.token).toBeGreaterThan(claim.token);}
   if(reason==='cancelled')expect(cancel(claim.runId)).toBe(true);
   const before=row(claim.runId);
   expect(await processClaimedTaskRunNotification(claim,deps,60000),reason).toBe(false);
   expect(sends,reason+' no physical send').not.toHaveBeenCalled();expect(row(claim.runId),reason+' preserves current owner').toEqual(before);
  }
  for(const reason of ['cancelled','expired','reclaimed']){
   const claim=create({kind:'batch',items:[payload,{...payload,text:'second must not send'}]});
   let release!:()=>void;const entered=Promise.withResolvers<void>();
   sends.mockImplementationOnce(async()=>{entered.resolve();await new Promise<void>(resolve=>{release=resolve;});});
   sends.mockClear();const work=processClaimedTaskRunNotification(claim,deps,60000);await entered.promise;
   if(reason==='cancelled')expect(cancel(claim.runId)).toBe(true);
   else{
    sql.prepare("UPDATE task_runs SET notification_lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(claim.runId);
    if(reason==='reclaimed')expect(db.claimTaskRunNotificationById(claim.runId,'synthetic-new',60000)!.token).toBeGreaterThan(claim.token);
   }
   const before=row(claim.runId);release();expect(await work,reason+' while first in flight').toBe(false);
   expect(sends,reason+' no second item').toHaveBeenCalledTimes(1);expect(row(claim.runId)).toEqual(before);
  }
  sends.mockClear();const valid=create();expect(await processClaimedTaskRunNotification(valid,deps,60000)).toBe(true);expect(sends).toHaveBeenCalledTimes(1);
  expect(db.getTaskRunById(valid.runId)?.notification_status).toBe('success');
  // A live owner still records partial transport success and retries only the
  // failed item through the original completion contract.
  sends.mockClear();sends.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('synthetic transport failure'));
  const partial=create({kind:'batch',items:[payload,{...payload,text:'failed item'}]});
  expect(await processClaimedTaskRunNotification(partial,deps,60000)).toBe(true);expect(sends).toHaveBeenCalledTimes(2);
  const persisted:any=row(partial.runId);
  expect(persisted.notification_status).toBe('partial_failed');
  expect(JSON.parse(persisted.notification_payload)).toEqual({...payload,text:'failed item'});
  expect(JSON.parse(persisted.notification_summary)).toMatchObject({attempted:2,succeeded:1,failed:1});
  const paused=create(),beforePaused=row(paused.runId);sends.mockClear();
  expect(await processClaimedTaskRunNotification(paused,{...deps,appointmentBootGate:createAppointmentBootGate('appointment')},60000)).toBe(false);
  expect(sends).not.toHaveBeenCalled();expect(row(paused.runId)).toEqual(beforePaused);
 }finally{for(const id of runs)sql.prepare('DELETE FROM task_runs WHERE id=?').run(id);sql.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(taskId);sql.close();closeDatabase();}
});
