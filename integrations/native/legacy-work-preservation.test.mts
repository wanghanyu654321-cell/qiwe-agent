import {expect,it,afterAll} from 'vitest';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
// A separate real synthetic database prevents these destructive failure probes
// from changing the full-host fixture or its restart evidence.
const originalCwd=process.cwd();
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-legacy-work-test-')));
const db=await import('../src/db.js');
const {STORE_DIR}=await import('../src/config.js');
const {readLegacyWorkPreservationEvidence}=await import('../src/legacy-work-preservation.js');
afterAll(()=>process.chdir(originalCwd));

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const prefix='qiwe_legacy_work_preservation:v1:';
const now='2020-01-01T00:00:00.000Z';
function task(id:string){
 db.createTask({id,group_folder:'preservation-synthetic',chat_jid:'web:preservation-synthetic',prompt:'synthetic retained work',context_mode:'isolated',execution_type:'agent',execution_mode:'container',script_command:null,schedule_type:'cron',schedule_value:'0 * * * *',next_run:now,status:'active',created_at:now,created_by:'synthetic-owner',notify_channels:null});
 return db.getTaskById(id)!;
}

it('does not reclaim, notify, expire or purge preserved old task records while new work remains claimable',()=>{
 db.initDatabase();
 const sql=new Database(path.join(STORE_DIR,'messages.db'));
 try {
  const old=task('preserved-old-task');
  const run=db.createTaskRun({task:old,triggerType:'manual',idempotencyKey:'old'}).run;
  const oldQueued=task('preserved-old-queued');
  const queued=db.createTaskRun({task:oldQueued,triggerType:'manual',idempotencyKey:'queued'}).run;
  sql.prepare("UPDATE task_runs SET status='running',started_at=?,lease_owner='old-owner',lease_expires_at=?,notification_payload=?,notification_status='failed',notification_available_at=?,notification_attempt=5,notification_lease_owner='old-notifier',notification_lease_expires_at=? WHERE id=?")
   .run(now,now,JSON.stringify({kind:'send_message',chatJid:old.chat_jid,text:'old uncertain reply'}),now,now,run.id);
  db.logTaskRun({task_id:old.id,run_at:now,duration_ms:0,status:'running',result:null,error:null});
  const rows=(table:string)=>sql.prepare('SELECT * FROM '+table+' WHERE '+(table==='scheduled_tasks'?'id':'task_id')+' IN (?,?) ORDER BY id').all(old.id,oldQueued.id) as any[];
  const before=Object.fromEntries(['scheduled_tasks','task_runs','task_run_logs'].map(table=>[table,rows(table)]));
  // Persist the specified marker contract directly for the missing-consumer RED.
  // No safe/ready proof is supplied, and all actual original DB consumers run.
  for(const [table,records] of Object.entries(before))for(const row of records){
   const keys=[row.id];
   sql.prepare('INSERT INTO router_state(key,value) VALUES (?,?)').run(prefix+table+':'+JSON.stringify(keys),JSON.stringify({version:1,state:'manual_review_required',table,keys,rowVersion:digest(row),taskId:table==='scheduled_tasks'?row.id:row.task_id,recordedAt:now}));
  }
  expect(db.getDueTaskDefinitionsV2().map(value=>value.id)).not.toContain(old.id);
  expect(db.getDueTasks().map(value=>value.id)).not.toContain(old.id);
  expect(db.materializeTaskOccurrence({taskId:old.id,scheduledFor:now,nextRun:null,triggerType:'scheduled'})).toBeUndefined();
  expect(db.claimTaskForRun(old.id,'new-owner',60000)).toBe(false);
  expect(db.claimTaskRunById(run.id,'new-owner',60000)).toBeUndefined();
  expect(db.claimTaskRunById(queued.id,'new-owner',60000)).toBeUndefined();
  expect(db.claimTaskRunNotificationById(run.id,'new-notifier',60000)).toBeUndefined();
  expect(db.failExpiredStartedTaskRuns()).toBe(0);
  expect(db.finalizeExpiredTaskRunNotificationAttempts()).toBe(0);
  expect(db.cleanupStaleRunningLogs()).toBe(0);
  expect(db.cleanupOldTaskRunLogs(1)).toBe(0);
  expect(db.getNextScheduledTaskWakeAt()).toBeNull();
  expect(db.getNextTaskRunWakeAt()).toBeNull();
  for(const [table,expected] of Object.entries(before))expect(rows(table)).toEqual(expected);
  const fresh=task('preservation-new-task');
  expect(db.getDueTaskDefinitionsV2(1).map(value=>value.id)).toEqual([fresh.id]);
  const freshRun=db.createTaskRun({task:fresh,triggerType:'manual',idempotencyKey:'fresh'}).run;
  expect(db.claimNextTaskRun('new-owner',60000)?.id).toBe(freshRun.id);
  expect(db.getTaskById(old.id)?.prompt).toBe('synthetic retained work');
  expect(db.getTaskRunsForTask(old.id).map(value=>value.id)).toContain(run.id);
  expect(db.getTaskRunLogs(old.id)[0]?.status).toBe('running');
 } finally {sql.close();db.closeDatabase();}
});

it('atomically preserves an exact selected snapshot, rejects stale selection and keeps malformed evidence closed',()=>{
 db.initDatabase();const sql=new Database(path.join(STORE_DIR,'messages.db'));
 try{
  const old=task('producer-old-task');
  const selected=db.inspectLegacyTaskPreservation(old.id);
  sql.prepare('UPDATE scheduled_tasks SET prompt=? WHERE id=?').run('changed after review',old.id);
  expect(()=>db.preserveLegacyTask(old.id,selected.version)).toThrow('STALE_SELECTION');
  expect(db.isLegacyTaskPreserved(old.id)).toBe(false);
  const current=db.inspectLegacyTaskPreservation(old.id);
  const before=sql.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(old.id) as any;
  expect(db.preserveLegacyTask(old.id,current.version)).toMatchObject({state:'manual_review_required',records:1});
  expect(sql.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(old.id)).toEqual(before);
  const marker=sql.prepare('SELECT * FROM router_state WHERE key=?').get(prefix+'scheduled_tasks:'+JSON.stringify([old.id])) as any;
  expect(db.preserveLegacyTask(old.id,current.version)).toMatchObject({state:'manual_review_required'});
  expect(sql.prepare('SELECT * FROM router_state WHERE key=?').get(marker.key)).toEqual(marker);
  expect(db.readLegacyPreservationEvidence('scheduled_tasks',before)?.state).toBe('manual_review_required');
  expect(db.readLegacyPreservationEvidence('router_state',marker)?.state).toBe('manual_review_required');
  const observed=new Map([['scheduled_tasks',[before]],['router_state',[marker]]]);
  // Scanner already budgeted these real DB rows. No second unbudgeted SQL read.
  const forbiddenReads={prepare(){throw Error('unbudgeted read');}} as unknown as Database.Database;
  expect(readLegacyWorkPreservationEvidence(forbiddenReads,'router_state',marker,observed)?.state).toBe('manual_review_required');
  expect(readLegacyWorkPreservationEvidence(forbiddenReads,'unknown_table',{},observed)).toBeUndefined();
  sql.prepare('UPDATE router_state SET value=? WHERE key=?').run('{}',marker.key);
  expect(db.isLegacyTaskPreserved(old.id)).toBe(true);
  expect(db.claimTaskForRun(old.id,'owner',60000)).toBe(false);
  expect(db.readLegacyPreservationEvidence('scheduled_tasks',before)?.state).toBe('unverified');
  expect(()=>db.preserveLegacyTask(old.id,current.version)).toThrow('EXISTING_CONFLICT');
  sql.prepare('UPDATE router_state SET value=? WHERE key=?').run(marker.value,marker.key);
  sql.prepare('UPDATE scheduled_tasks SET prompt=? WHERE id=?').run('late old writer changed row',old.id);
  expect(db.readLegacyPreservationEvidence('scheduled_tasks',before)).toEqual({state:'unverified',reason:'record_changed'});
 }finally{sql.close();db.closeDatabase();}
});

it('keeps a valid old notification payload unchanged, refuses its new claims and late callbacks, but admits a new task notification',async()=>{
 db.initDatabase();const sql=new Database(path.join(STORE_DIR,'messages.db'));
 try{
  const old=task('old-notification-task');const run=db.createTaskRun({task:old,triggerType:'manual'}).run;
  const payload=JSON.stringify({kind:'send_message',chatJid:old.chat_jid,text:'unknown old send'});
  sql.prepare("UPDATE task_runs SET status='success',notification_status='pending',notification_payload=?,notification_available_at=?,completed_at=? WHERE id=?").run(payload,now,now,run.id);
  const claim=db.claimTaskRunNotificationById(run.id,'physical-old-worker',60000)!;
  expect(claim).toBeDefined();
  const before=sql.prepare('SELECT * FROM task_runs WHERE id=?').get(run.id) as any;
  db.preserveLegacyTask(old.id,db.inspectLegacyTaskPreservation(old.id).version);
  const {processClaimedTaskRunNotification}=await import('../src/task-scheduler.js');
  const {createAppointmentBootGate}=await import('../src/appointment-boot-gate.js');
  let sent=0;
  // This ready gate is a local transport-invocation probe, never fullhost restore evidence.
  expect(await processClaimedTaskRunNotification(claim,{appointmentBootGate:createAppointmentBootGate('original'),sendMessage:async()=>{sent++;}} as any,60000)).toBe(false);
  expect(sent).toBe(0);
  expect(db.claimTaskRunNotificationById(run.id,'new-worker',60000)).toBeUndefined();
  expect(db.renewTaskRunNotificationLease(claim,60000)).toBe(false);
  expect(db.completeTaskRunNotificationAttempt(claim,{status:'success',summary:{attempted:1,succeeded:1,failed:0,failed_channels:[]},error:null})).toBe(false);
  expect(db.completeTaskRun(run.id,before.lease_owner,before.lease_token,{status:'success',notificationStatus:'skipped'})).toBe(false);
  expect(db.cancelTaskRun(run.id)).toBe(false);
  expect(sql.prepare('SELECT * FROM task_runs WHERE id=?').get(run.id)).toEqual(before);
  const fresh=task('new-notification-task');const freshRun=db.createTaskRun({task:fresh,triggerType:'manual'}).run;
  sql.prepare("UPDATE task_runs SET status='success',notification_status='pending',notification_payload=?,notification_available_at=? WHERE id=?").run(payload,now,freshRun.id);
  expect(db.claimTaskRunNotificationById(freshRun.id,'new-worker',60000)?.runId).toBe(freshRun.id);
 }finally{sql.close();db.closeDatabase();}
});

it('preserves task-associated input messages and atomically rolls back a conflicting descendant marker',()=>{
 db.initDatabase();const sql=new Database(path.join(STORE_DIR,'messages.db'));
 try{
  const old=task('associated-message-task');db.ensureChatExists(old.chat_jid);
  db.storeMessageDirect('associated-old-input',old.chat_jid,'synthetic','Synthetic','old task input',now,false);
  sql.prepare('UPDATE messages SET task_id=? WHERE chat_jid=? AND id=?').run(old.id,old.chat_jid,'associated-old-input');
  const before=sql.prepare('SELECT * FROM messages WHERE chat_jid=? AND id=?').get(old.chat_jid,'associated-old-input');
  const markerKey=prefix+'messages:'+JSON.stringify([old.chat_jid,'associated-old-input']);
  sql.prepare('INSERT INTO router_state VALUES (?,?)').run(markerKey,'{}');
  const selected=db.inspectLegacyTaskPreservation(old.id);
  expect(()=>db.preserveLegacyTask(old.id,selected.version)).toThrow('EXISTING_CONFLICT');
  expect(db.isLegacyTaskPreserved(old.id)).toBe(false);
  sql.prepare('DELETE FROM router_state WHERE key=?').run(markerKey);
  expect(db.preserveLegacyTask(old.id,selected.version)).toMatchObject({records:2});
  expect(db.conversationMessageAllowed('associated-old-input',old.chat_jid)).toBe(false);
  expect(sql.prepare('SELECT * FROM messages WHERE chat_jid=? AND id=?').get(old.chat_jid,'associated-old-input')).toEqual(before);
 }finally{sql.close();db.closeDatabase();}
});

it('preserves old ordinary and queued inputs without hiding history or blocking new input in the same space',()=>{
 db.initDatabase();let sql=new Database(path.join(STORE_DIR,'messages.db'));
 try{
  const jid='web:preservation-message-space';db.ensureChatExists(jid);
  for(const id of ['old-normal','old-promoting','new-normal','new-queued'])db.storeMessageDirect(id,jid,'synthetic-sender','Synthetic','content-'+id,now,false);
  sql.prepare("UPDATE messages SET delivery_mode='queue',delivery_status='promoting' WHERE chat_jid=? AND id='old-promoting'").run(jid);
  sql.prepare("UPDATE messages SET delivery_mode='queue',delivery_status='queued' WHERE chat_jid=? AND id='new-queued'").run(jid);
  for(const id of ['old-normal','old-promoting'])db.preserveLegacyMessage(jid,id,db.inspectLegacyMessagePreservation(jid,id).version);
  const before=sql.prepare("SELECT * FROM messages WHERE chat_jid=? AND id LIKE 'old-%' ORDER BY id").all(jid);
  const cursor={timestamp:'',id:''};
  expect(db.getMessagesSince(jid,cursor).map(row=>row.id)).toEqual(['new-normal']);
  expect(db.getNewMessages([jid],cursor).messages.map(row=>row.id)).toEqual(['new-normal']);
  expect(db.restorePromotingFollowUp(jid,'old-promoting')).toBeNull();
  expect(db.claimNextQueuedFollowUp(jid,'new-claim')?.id).toBe('new-queued');
  expect(db.getMessagesPage(jid,undefined,50).map(row=>row.id)).toEqual(expect.arrayContaining(['old-normal','old-promoting']));
  sql.close();db.closeDatabase();db.initDatabase();sql=new Database(path.join(STORE_DIR,'messages.db'));
  expect(db.isLegacyMessagePreserved(jid,'old-normal')).toBe(true);
  expect(db.getMessagesSince(jid,cursor).map(row=>row.id)).toEqual(['new-normal']);
  expect(sql.prepare("SELECT * FROM messages WHERE chat_jid=? AND id LIKE 'old-%' ORDER BY id").all(jid)).toEqual(before);
 }finally{sql.close();db.closeDatabase();}
});

it('retains D3 running/cancelling associations without resuming, settling or losing old persisted results',()=>{
 db.initDatabase();const sql=new Database(path.join(STORE_DIR,'messages.db'));
 try{
  const jid='web:preservation-d3-space';db.ensureChatExists(jid);
  db.storeMessageDirect('d3-old-input',jid,'synthetic','Synthetic','unknown old work',now,false);
  sql.prepare('INSERT INTO wecom_conversation_receipts VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-old-receipt','d3-old-input',now,'synthetic-origin','synthetic-fingerprint','synthetic-text-hash','{}','synthetic-role',jid,'synthetic-profile','synthetic-selection');
  sql.prepare('INSERT INTO wecom_conversation_execution VALUES (?,?,?,?,?,?,?,?,?)').run('synthetic-old-receipt',jid,'d3-old-input','running','old-query','d3-old-input','old-session',JSON.stringify(['d3-old-input']),1);
  sql.prepare('INSERT INTO wecom_conversation_results VALUES (?,?,?,?,?,?,?,?)').run('synthetic-old-receipt',1,'old-query','d3-old-input','old-session',JSON.stringify(['saved-output']),digest('saved answer'),'saved answer');
  const saved=db.readLatestConversationResult('synthetic-old-receipt');
  const selection=db.inspectLegacyMessagePreservation(jid,'d3-old-input');
  expect(db.preserveLegacyMessage(jid,'d3-old-input',selection.version)).toMatchObject({records:3});
  const before=sql.prepare('SELECT * FROM wecom_conversation_execution WHERE receipt_id=?').get('synthetic-old-receipt');
  expect(db.conversationMessageAllowed('d3-old-input',jid)).toBe(false);
  expect(db.listQueuedConversationReceipts()).not.toContain('synthetic-old-receipt');
  expect(db.conversationBatchActive(jid,'old-query')).toBe(false);
  expect(db.readConversationExecution('synthetic-old-receipt')).toMatchObject({state:'running',manualReviewRequired:true,queryId:'old-query'});
  expect(db.finishConversationBatch(jid,'old-query','cancelled')).toEqual([]);
  db.noteConversationSession(jid,'old-query','replacement-session');
  let interrupted=false;db.cancelConversationReceipt('synthetic-old-receipt',()=>{interrupted=true;return true;});
  expect(interrupted).toBe(false);
  expect(sql.prepare('SELECT * FROM wecom_conversation_execution WHERE receipt_id=?').get('synthetic-old-receipt')).toEqual(before);
  expect(db.readLatestConversationResult('synthetic-old-receipt')).toEqual(saved);
  expect(db.readLegacyPreservationEvidence('wecom_conversation_execution',before as any)?.state).toBe('manual_review_required');
 }finally{sql.close();db.closeDatabase();}
});
