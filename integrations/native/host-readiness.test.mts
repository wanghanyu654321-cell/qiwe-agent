import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const fixture=vi.hoisted(()=>({root:process.cwd()+'/synthetic-host',runs:[] as string[],queued:[] as (()=>Promise<void>)[],closing:false,deferred:null as null|(()=>void),hold:false}));
vi.mock('../src/config.js',()=>({DATA_DIR:fixture.root,STORE_DIR:path.join(fixture.root,'db'),GROUPS_DIR:path.join(fixture.root,'groups'),MOUNT_ALLOWLIST_PATH:path.join(fixture.root,'mounts.json'),MAIN_GROUP_FOLDER:'main',ASSISTANT_NAME:'synthetic',SCHEDULER_POLL_INTERVAL:60000,TIMEZONE:'Asia/Shanghai',MAX_FILE_SIZE:1024,TRUST_PROXY:false}));
vi.mock('../src/logger.js',()=>({logger:{debug(){},info(){},warn(){},error(){}}}));
vi.mock('../src/runtime-config.js',()=>({getSystemSettings:()=>({billingEnabled:false,containerTimeout:60000,idleTimeout:60000,maxConcurrentContainers:1}),deleteContainerEnvConfig(){}}));
vi.mock('../src/feishu-cli-runtime.js',()=>({resolveFeishuCliBoundAccountId:()=>null}));
vi.mock('../src/file-manager.js',()=>({removeFlowArtifacts(){}}));
vi.mock('../src/script-runner.js',()=>({runScript(){throw Error('Real/script runner forbidden');}}));
vi.mock('../src/business-execution-policy.js',()=>({BUSINESS_EXECUTION_BOUNDARY:'member-container-only',BUSINESS_EXECUTION_ERROR_PREFIX:'synthetic'}));
if(!process.env.QIWE_SQLITE_DRIVER)vi.doMock('../src/sqlite-compat.js',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 return {default:class {
  connection:InstanceType<typeof DatabaseSync>;open=true;depth=0;
  constructor(file:string){this.connection=new DatabaseSync(file);}
  exec(sql:string){return this.connection.exec(sql);}
  prepare(sql:string){return this.connection.prepare(sql);}
  close(){this.connection.close();this.open=false;}
  transaction(work:(...args:any[])=>any){return (...args:any[])=>{const name='nested_'+this.depth++,nested=this.depth>1;this.exec(nested?'SAVEPOINT '+name:'BEGIN');try{const value=work(...args);this.exec(nested?'RELEASE '+name:'COMMIT');return value;}catch(error){this.exec(nested?'ROLLBACK TO '+name:'ROLLBACK');if(nested)this.exec('RELEASE '+name);throw error;}finally{this.depth--;}};}
 }};
});
vi.mock('../src/container-runner.js',()=>({
 cleanupContainerTaskRuntimeEnvDirs(){},writeTasksSnapshot(){},killProcessTree(){throw Error('Real process kill forbidden');},runHostAgent(){throw Error('Host runner forbidden');},
 async runContainerAgent(_group:any,input:any){fixture.runs.push(input.messageTaskId);if(fixture.hold)await new Promise<void>(resolve=>{fixture.deferred=resolve;});return {status:'success',result:'host synthetic result',inputTurnCompleted:true};},
 async runAgentWithModelFallback(run:any,...args:any[]){return run(...args);}
}));
const db=await import('../src/db.js');
const scheduler=await import('../src/task-scheduler.js');
const reliability=await import('../src/channel-reliability-store.js');
const recovery=await import('../src/channel-reliability-recovery.js');
const {createAppointmentBootGate}=await import('../src/appointment-boot-gate.js');
const gate=createAppointmentBootGate('appointment');
const writes=vi.spyOn(gate,'beginWrite'),finishes=vi.spyOn(gate,'finishWrite');
let sql:DatabaseSync;
const group={name:'Synthetic role',folder:'host-role',added_at:new Date().toISOString(),created_by:'host-member',executionMode:'container' as const,is_home:false};
const sends=vi.fn(()=>{throw Error('Notification must not drain');});
const deps:any={registeredGroups:()=>({'web:host-role':group}),getSessions:()=>({}),queue:{isShuttingDown:()=>fixture.closing,isGroupMutationPaused:()=>false,closeStdin(){},stopGroup:vi.fn(async()=>{fixture.deferred?.();}),enqueueTask(_jid:string,_id:string,work:()=>Promise<void>){fixture.queued.push(work);return true;}},onProcess(){},sendMessage:sends,storeResultAndNotify:vi.fn(),assistantName:'synthetic',appointmentBootGate:gate};
const admission=()=>({signal:new AbortController().signal,deadline:performance.now()+5000,revalidate(){},async withCurrent(work:()=>void){work();}});
function snapshot(){return {tasks:sql.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all(),runs:sql.prepare('SELECT * FROM task_runs ORDER BY id').all()};}
function others(){return {tasks:sql.prepare("SELECT * FROM scheduled_tasks WHERE id <> 'host-A' ORDER BY id").all(),runs:sql.prepare("SELECT * FROM task_runs WHERE task_id <> 'host-A' ORDER BY id").all()};}
function review(g=gate){const stamp=g.beginReview();expect(stamp).not.toBeNull();const ticket=g.publishReview(stamp!,{complete:true,safe:true,records:[{kind:'synthetic-fixture',key:'no-external-resources',version:'1',disposition:'terminal',evidence:['isolated temp fixture only']}],blockers:[]});expect(ticket).not.toBeNull();return ticket!;}
beforeAll(()=>{
 fs.mkdirSync(path.join(fixture.root,'db'),{recursive:true});db.initDatabase();sql=new DatabaseSync(path.join(fixture.root,'db/messages.db'));
 db.createUser({id:'host-member',username:'host-synthetic',password_hash:'synthetic-unused',display_name:'Synthetic',role:'member',status:'active',must_change_password:false,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
 db.setRegisteredGroup('web:host-role',group);db.getOrCreateDefaultAgentProfile('host-member');
 for(const id of ['host-A','host-B'])db.createTask({id,group_folder:'host-role',chat_jid:'web:host-role',prompt:'synthetic',context_mode:'isolated',execution_type:'agent',execution_mode:'container',script_command:null,schedule_type:'cron',schedule_value:'0 * * * *',next_run:new Date(Date.now()+(id==='host-A'?3600000:-1000)).toISOString(),status:'active',created_at:new Date().toISOString(),created_by:'host-member',notify_channels:null});
 const stale=db.createTaskRun({task:db.getTaskById('host-B')!,triggerType:'manual',idempotencyKey:'host-other'}).run;
 sql.prepare("UPDATE task_runs SET status='success',notification_status='failed',notification_payload=?,notification_available_at=? WHERE id=?").run(JSON.stringify({kind:'send_message',chatJid:'web:other',text:'do not send'}),'2000-01-01T00:00:00.000Z',stale.id);
});
afterAll(async()=>{await scheduler.stopSchedulerLoop({drainMs:20});sql?.close();if(db.isDatabaseInitialized())db.closeDatabase();});
it('paused host cannot start the original scheduler, materialize due tasks, recover leases or drain notification rows',async()=>{
 expect(gate.phase()).toBe('paused');const before=snapshot();scheduler.startSchedulerLoop(deps);
 expect(snapshot()).toEqual(before);expect(fixture.queued).toHaveLength(0);expect(fixture.runs).toEqual([]);expect(sends).not.toHaveBeenCalled();
 await scheduler.stopSchedulerLoop({drainMs:20});
});
it('targeted admission stays closed throughout review, restoring and final commit and releases every write ticket',async()=>{
 const before=snapshot();await expect(scheduler.triggerTaskRunTargeted('host-A',deps,'paused',admission())).rejects.toThrow('APPOINTMENT_MAINTENANCE');
 const draining=gate.beginWrite()!;expect(draining).not.toBeNull();expect(gate.beginReview()).toBeNull();gate.finishWrite(draining);
 let attempt=gate.claimRestore(review());expect(typeof attempt).toBe('object');if(typeof attempt==='string')throw Error(attempt);
 expect(gate.phase()).toBe('restoring');await expect(scheduler.triggerTaskRunTargeted('host-A',deps,'restoring',admission())).rejects.toThrow('APPOINTMENT_MAINTENANCE');
 const unsettled=gate.beginWrite()!;expect(gate.enterFinal(attempt)).toBe(false);gate.finishWrite(unsettled);expect(gate.enterFinal(attempt)).toBe(false);
 gate.failRestore(attempt);attempt=gate.claimRestore(review());if(typeof attempt==='string')throw Error(attempt);
 expect(gate.enterFinal(attempt)).toBe(true);expect(gate.beginWrite()).toBeNull();await expect(scheduler.triggerTaskRunTargeted('host-A',deps,'final',admission())).rejects.toThrow('APPOINTMENT_MAINTENANCE');
 gate.failRestore(attempt);expect(gate.phase()).toBe('paused');expect(snapshot()).toEqual(before);
 // No synthetic ready gate: a fresh, complete review and synchronous commit is mandatory.
 const final=gate.claimRestore(review());if(typeof final==='string')throw Error(final);expect(gate.enterFinal(final)).toBe(true);
 expect(gate.commitRestore(final,()=>undefined)).toBe(true);expect(gate.phase()).toBe('ready');
});
it('ready host executes one selected run while the original due task and outbox remain unchanged',async()=>{
 const before=others();const result=await scheduler.triggerTaskRunTargeted('host-A',deps,'ready',admission());expect(result.success).toBe(true);
 expect(fixture.queued).toHaveLength(1);await fixture.queued.shift()!();expect(fixture.runs).toEqual(['host-A']);expect(db.getTaskRunById(result.runId!)!).toMatchObject({status:'success',result:'host synthetic result'});
 expect(others()).toEqual(before);expect(sends).not.toHaveBeenCalled();
 const tickets=writes.mock.results.filter(result=>result.type==='return'&&result.value!==null).map(result=>result.value.id).sort();
 expect(finishes.mock.calls.map(([ticket])=>ticket.id).sort()).toEqual(tickets);
});
it('shutdown blocks fresh writes and queued prestart before any model or send callback',async()=>{
 const before=others(),result=await scheduler.triggerTaskRunTargeted('host-A',deps,'queued-before-close',admission());expect(result.success).toBe(true);
 fixture.closing=true;await fixture.queued.shift()!();expect(db.getTaskRunById(result.runId!)!.status).toBe('cancelled');expect(fixture.runs).toEqual(['host-A']);
 await expect(scheduler.triggerTaskRunTargeted('host-A',deps,'closed',admission())).rejects.toThrow('TARGETED_TASK_REQUEST_CLOSED');expect(others()).toEqual(before);expect(sends).not.toHaveBeenCalled();
});
it('failed synchronous recovery stays paused and cannot be retried within that boot',()=>{
 const failed=createAppointmentBootGate('appointment'),attempt=failed.claimRestore(review(failed));if(typeof attempt==='string')throw Error(attempt);
 expect(failed.enterFinal(attempt)).toBe(true);expect(()=>failed.commitRestore(attempt,()=>{throw Error('synthetic commit rejected');})).toThrow('synthetic commit rejected');
 expect(failed.phase()).toBe('paused');expect(failed.beginReview()).toBeNull();expect(failed.beginWrite()).toBeNull();
});
it('paused original reliability recovery does not touch persistent records or call the synthetic provider',async()=>{
 const route={provider:'feishu' as const,accountId:'synthetic-account',sourceJid:'feishu:synthetic',chatId:'synthetic-chat'},now='2020-01-01T00:00:00.000Z';
 const run=reliability.createChannelTurnRun({...route,idempotencyKey:'synthetic-recovery',now}).run;
 reliability.createStreamingCardRecord({...route,id:'synthetic-card',turnRunId:run.id,cardId:'synthetic-provider-card',status:'streaming',now});
 const read=()=>sql.prepare('SELECT * FROM streaming_cards ORDER BY id').all(),before=read(),provider=vi.fn(async()=>({version:1,method:'cardkit' as const}));
 const loop=recovery.startChannelReliabilityRecoveryLoop({reconcileStreamingCard:provider},{appointmentBootGate:createAppointmentBootGate('appointment')});
 try{await loop.trigger();expect(read()).toEqual(before);expect(provider).not.toHaveBeenCalled();}finally{await loop.stop();}
});
it('original recovery shutdown retains the real gate write ticket until fake provider work physically settles',async()=>{
 const prior=reliability.getStreamingCardRecord('synthetic-card')!;
 if(prior.status==='streaming')reliability.finalizeStreamingCardRecord(prior.id,prior.revision,{status:'aborted',error:'synthetic scenario cleanup'});
 const route={provider:'feishu' as const,accountId:'synthetic-account',sourceJid:'feishu:synthetic',chatId:'synthetic-chat'},now='2020-01-01T00:00:00.000Z';
 const run=reliability.createChannelTurnRun({...route,idempotencyKey:'synthetic-shutdown',now}).run;
 reliability.createStreamingCardRecord({...route,id:'synthetic-shutdown-card',turnRunId:run.id,cardId:'synthetic-shutdown-provider-card',status:'streaming',now});
 const recovering=createAppointmentBootGate('appointment'),attempt=recovering.claimRestore(review(recovering));if(typeof attempt==='string')throw Error(attempt);
 expect(recovering.enterFinal(attempt)).toBe(true);expect(recovering.commitRestore(attempt,()=>undefined)).toBe(true);
 const begin=vi.spyOn(recovering,'beginWrite'),finish=vi.spyOn(recovering,'finishWrite');let release!:()=>void;
 const provider=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {version:2,method:'cardkit' as const};});
 const loop=recovery.startChannelReliabilityRecoveryLoop({reconcileStreamingCard:provider},{appointmentBootGate:recovering});
 const active=loop.trigger();await vi.waitFor(()=>expect(provider).toHaveBeenCalledTimes(1));const stopped=loop.stop();let settled=false;Promise.resolve(stopped).then(()=>{settled=true;});
 try{
  expect(stopped).toBeInstanceOf(Promise);await Promise.resolve();expect(settled).toBe(false);expect(begin).toHaveBeenCalledTimes(1);expect(finish).not.toHaveBeenCalled();
  await loop.trigger();expect(provider).toHaveBeenCalledTimes(1);
 }finally{release();await active;await stopped;}
 expect(settled).toBe(true);expect(finish).toHaveBeenCalledTimes(1);expect(finish.mock.calls[0]![0]).toBe(begin.mock.results[0]!.value);
 expect(reliability.getStreamingCardRecord('synthetic-shutdown-card')!.status).toBe('aborted');
});
