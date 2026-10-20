import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import fs from 'node:fs';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
const fixture=vi.hoisted(()=>({root:process.cwd()+'/synthetic',runs:[] as string[],blocked:false,paused:false,fail:false,auto:false,deferred:null as null|(()=>void),queued:[] as (()=>Promise<void>)[]}));
vi.mock('../src/config.js',()=>({DATA_DIR:fixture.root,STORE_DIR:path.join(fixture.root,'db'),GROUPS_DIR:path.join(fixture.root,'groups'),MOUNT_ALLOWLIST_PATH:path.join(fixture.root,'mounts.json'),MAIN_GROUP_FOLDER:'main',ASSISTANT_NAME:'synthetic',SCHEDULER_POLL_INTERVAL:60000,TIMEZONE:'Asia/Shanghai',MAX_FILE_SIZE:1024,TRUST_PROXY:false}));
vi.mock('../src/logger.js',()=>({logger:{debug(){},info(){},warn(){},error(){}}}));
vi.mock('../src/runtime-config.js',()=>({getSystemSettings:()=>({billingEnabled:false,containerTimeout:60000,idleTimeout:60000,maxConcurrentContainers:1}),deleteContainerEnvConfig(){}}));
vi.mock('../src/feishu-cli-runtime.js',()=>({resolveFeishuCliBoundAccountId:()=>null}));
vi.mock('../src/file-manager.js',()=>({removeFlowArtifacts(){}}));
vi.mock('../src/script-runner.js',()=>({runScript(){throw Error('Real/script runner forbidden');}}));
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
 cleanupContainerTaskRuntimeEnvDirs(){},writeTasksSnapshot(){},killProcessTree(){throw Error('Real process kill forbidden');},
 runHostAgent(){throw Error('Host runner forbidden');},
 async runContainerAgent(_group:any,input:any){fixture.runs.push(input.messageTaskId);if(fixture.fail)await new Promise<void>(resolve=>{fixture.deferred=resolve;});return {status:'success',result:'original scheduler synthetic result',inputTurnCompleted:true};},
 async runAgentWithModelFallback(run:any,...args:any[]){return run(...args);}
}));
const db=await import('../src/db.js');
const scheduler=await import('../src/task-scheduler.js');
let sql:DatabaseSync;
const group={name:'Synthetic role',folder:'role',added_at:new Date().toISOString(),created_by:'member',executionMode:'container' as const,is_home:false};
const sends=vi.fn(()=>{throw Error('Notification must not drain');}),stops=vi.fn(async()=>{fixture.deferred?.();});
const gate={isPaused:()=>fixture.paused,beginWrite:()=>({id:'synthetic-ticket'}),finishWrite:vi.fn()};
const deps:any={registeredGroups:()=>({'web:role':group}),getSessions:()=>({}),queue:{isShuttingDown:()=>false,isGroupMutationPaused:()=>false,closeStdin(){},stopGroup:stops,enqueueTask(_jid:string,_id:string,work:()=>Promise<void>){if(fixture.auto){const result=work();fixture.queued.push(()=>result);}else fixture.queued.push(work);return true;}},onProcess(){},sendMessage:sends,storeResultAndNotify:vi.fn(),assistantName:'synthetic',appointmentBootGate:gate};
const admission=()=>{const controller=new AbortController();return {signal:controller.signal,controller,deadline:performance.now()+5000,revalidate(){if(fixture.blocked)throw Error('Grant revoked');},async withCurrent(work:()=>void){work();}};};
function task(id:string,due=false){db.createTask({id,group_folder:'role',chat_jid:'web:role',prompt:'synthetic',context_mode:'isolated',execution_type:'agent',execution_mode:'container',script_command:null,schedule_type:'cron',schedule_value:'0 * * * *',next_run:new Date(Date.now()+(due?-1000:3600000)).toISOString(),status:'active',created_at:new Date().toISOString(),created_by:'member',notify_channels:null});return db.getTaskById(id)!;}
function otherRows(){return {definitions:sql.prepare("SELECT * FROM scheduled_tasks WHERE id <> 'A' ORDER BY id").all(),runs:sql.prepare("SELECT * FROM task_runs WHERE task_id <> 'A' ORDER BY id").all()};}
beforeAll(()=>{
 fs.mkdirSync(path.join(fixture.root,'db'),{recursive:true});db.initDatabase();sql=new DatabaseSync(path.join(fixture.root,'db/messages.db'));
 db.createUser({id:'member',username:'synthetic',password_hash:'synthetic-unused',display_name:'Synthetic',role:'member',status:'active',must_change_password:false,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
 db.setRegisteredGroup('web:role',group);db.getOrCreateDefaultAgentProfile('member');
 task('A');task('B',true);const c=task('C'),d=task('D'),e=task('E');
 db.createTaskRun({task:c,triggerType:'manual',idempotencyKey:'other-queued'});
 const notification=db.createTaskRun({task:d,triggerType:'manual',idempotencyKey:'other-notify'}).run;
 sql.prepare("UPDATE task_runs SET status='success',notification_status='failed',notification_payload=?,notification_available_at=? WHERE id=?").run(JSON.stringify({kind:'send_message',chatJid:'web:other',text:'not for this run'}),'2000-01-01T00:00:00.000Z',notification.id);
 const expired=db.createTaskRun({task:e,triggerType:'manual',idempotencyKey:'other-expired'}).run;
 sql.prepare("UPDATE task_runs SET status='running',started_at=?,lease_owner='other',lease_token=5,lease_expires_at=? WHERE id=?").run('2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',expired.id);
});
afterAll(async()=>{await scheduler.stopSchedulerLoop({drainMs:20});sql?.close();if(db.isDatabaseInitialized())db.closeDatabase();});
it('has an explicit single-run entry rather than driving the global pump',()=>{expect(typeof scheduler.triggerTaskRunTargeted).toBe('function');});
it('executes actual scheduler and temp SQLite only for A; all other due tasks, queued runs and outbox rows remain identical',async()=>{
 expect(typeof scheduler.triggerTaskRunTargeted).toBe('function');const before=otherRows(),next=db.getTaskById('A')!.next_run;
 const result=await scheduler.triggerTaskRunTargeted('A',deps,'A-key',admission());expect(result.success).toBe(true);expect(fixture.queued).toHaveLength(1);
 await fixture.queued.shift()!();expect(fixture.runs).toEqual(['A']);expect(db.getTaskRunById(result.runId!)!).toMatchObject({status:'success',result:'original scheduler synthetic result'});
 const repeated=await scheduler.triggerTaskRunTargeted('A',deps,'A-key',admission());expect(repeated).toEqual(result);expect(fixture.queued).toHaveLength(0);
 expect(otherRows()).toEqual(before);expect(db.getTaskById('A')!.next_run).toBe(next);expect(sends).not.toHaveBeenCalled();
});
it('revalidates a queued request and fences revoked or paused work before the runner starts',async()=>{
 expect(typeof scheduler.triggerTaskRunTargeted).toBe('function');const before=otherRows();
 for(const reason of ['grant','gate','abort']){
  const a=admission(),result=await scheduler.triggerTaskRunTargeted('A',deps,'A-'+reason,a);expect(result.success).toBe(true);
  if(reason==='grant')fixture.blocked=true;if(reason==='gate')fixture.paused=true;if(reason==='abort')a.controller.abort();
  await fixture.queued.shift()!();expect(db.getTaskRunById(result.runId!)!.status).toBe('cancelled');fixture.blocked=false;fixture.paused=false;
 }
 expect(fixture.runs).toEqual(['A']);expect(otherRows()).toEqual(before);
});
it('connects public actor-bound port to the actual patched functions under original persistent grant authority',async()=>{
 const moduleUrl=(file:string)=>pathToFileURL(path.join(process.env.QIWE_SOURCE_ROOT!,'src/role-eval',file)).href;
 const {createNativeBotExecutionPort}=await import(moduleUrl('native-bot-execution.ts'));
 const {createNativeBotTasks}=await import(moduleUrl('native-bot-tasks.ts'));
 const {WorkbenchAccessStore}=await import(moduleUrl('workbench-access.ts'));
 const {createWecomBotContext}=await import(moduleUrl('wecom-bot-context.ts'));
 const {GroupQueue}=await import('../src/group-queue.js');
 const grants=new WorkbenchAccessStore(path.join(fixture.root,'original-grants.sqlite'));
 grants.change('admin',{accountId:'member',storeId:'store',roles:['marketing'],active:true,expectedVersion:0,requestKey:'open'});
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'tenant',stores:[{id:'store'}],roles:['marketing'],store:grants,
  readSubject:async()=>({botId:'bot',memberId:'member-channel'}),readBinding:async()=>({botId:'bot',corpId:'corp',memberId:'member-channel',accountId:'member',version:1,active:true}),
  readNative:async()=>({user:{id:'member',role:'member',status:'active',must_change_password:false},workspaceJid:'web:home'})});
 const request={correlationId:'synthetic',signal:new AbortController().signal,deadline:performance.now()+5000},context=await authority.authorize(request,'marketing');
 const profile=db.getOrCreateDefaultAgentProfile('member');db.assignWorkspaceAgentProfile('role',profile.id);
 const readers={getTaskById:db.getTaskById,getRegisteredGroup:db.getRegisteredGroup,getAgentProfile:db.getAgentProfile,getWorkspaceAgentProfileBinding:db.getWorkspaceAgentProfileBinding,getTaskRunById:db.getTaskRunById};
 const port=createNativeBotExecutionPort({mode:'isolated-synthetic',enabled:true,readers,target:{triggerTaskRunTargeted:(id:string,key:string,a:any)=>scheduler.triggerTaskRunTargeted(id,deps,key,a),cancelTaskRunTargeted:(id:string,a:any)=>scheduler.cancelTaskRunTargeted(id,deps,a)}}),adapter=createNativeBotTasks({port});
 const owner={tenantId:'tenant',storeId:'store',accountId:'member',workspaceJid:'web:home',role:'marketing',corpId:'corp',botId:'bot',memberId:'member-channel',bindingVersion:1},backend={kind:'native',taskId:'A',profileId:profile.id,workspaceJid:'web:role'};
 const tx=(work:()=>void)=>authority.withCurrent(context,()=>{work();}),current=()=>authority.assertCurrent(context);
 const previousGate=deps.appointmentBootGate;
 try{
  const before=otherRows();
  if(process.env.QIWE_HOST_OVERLAY){
   const {createAppointmentBootGate}=await import('../src/appointment-boot-gate.js');
   const actualGate=createAppointmentBootGate('appointment');deps.appointmentBootGate=actualGate;
   const beforePaused=sql.prepare('SELECT * FROM task_runs ORDER BY id').all();
   const refused=await adapter.start(owner,backend,'public-paused',request,current,tx);
   expect(refused.state).not.toBe('linked');expect(sql.prepare('SELECT * FROM task_runs ORDER BY id').all()).toEqual(beforePaused);
   const stamp=actualGate.beginReview();expect(stamp).not.toBeNull();
   const ticket=actualGate.publishReview(stamp!,{complete:true,safe:true,records:[{kind:'synthetic-fixture',key:'temp-only',version:'1',disposition:'terminal',evidence:['isolated temp fixture only']}],blockers:[]});
   const attempt=actualGate.claimRestore(ticket!);if(typeof attempt==='string')throw Error(attempt);
   expect(actualGate.enterFinal(attempt)).toBe(true);expect(actualGate.commitRestore(attempt,()=>undefined)).toBe(true);expect(actualGate.phase()).toBe('ready');
  }
  const fakeQueue=deps.queue,realQueue=new GroupQueue();deps.queue=realQueue;
  const completed=await adapter.start(owner,backend,'public-completed',request,current,tx);expect(completed.state).toBe('linked');
  await vi.waitFor(()=>expect(db.getTaskRunById(completed.referenceId)!).toMatchObject({status:'success',result:'original scheduler synthetic result'}));expect(otherRows()).toEqual(before);
  let releaseBusy!:()=>void;
  realQueue.enqueueTask('web:busy#task:synthetic','synthetic-busy',()=>new Promise<void>(resolve=>{releaseBusy=resolve;}),{allowInactive:true});
  const busy=await adapter.start(owner,backend,'public-busy',request,current,tx);expect(busy.state).toBe('linked');
  await vi.waitFor(()=>expect(db.getTaskRunById(busy.referenceId)!.status).toBe('cancelled'));releaseBusy();
  await realQueue.shutdown(50);deps.queue=fakeQueue;
  const started=await adapter.start(owner,backend,'public-key',request,current,tx);expect(started.state).toBe('linked');
  // The adapter closes its request scope after replying. A queued request must
  // settle cancelled, rather than leaving a globally executable retry row.
  await fixture.queued.shift()!();expect(db.getTaskRunById(started.referenceId)!.status).toBe('cancelled');expect(otherRows()).toEqual(before);
  const revoked=await adapter.start(owner,backend,'revoke-public-key',request,current,tx);expect(revoked.state).toBe('linked');
  grants.change('admin',{accountId:'member',storeId:'store',roles:['marketing'],active:false,expectedVersion:1,requestKey:'revoke'});
  await fixture.queued.shift()!();expect(db.getTaskRunById(revoked.referenceId)!.status).toBe('cancelled');expect(otherRows()).toEqual(before);
 }finally{deps.appointmentBootGate=previousGate;adapter.close();port.close();authority.close();grants.close();}
});
it('durably fences an abandoned queue item on request abort without waiting for the queue to drain',async()=>{
 const a=admission(),result=await scheduler.triggerTaskRunTargeted('A',deps,'A-abandoned',a);expect(result.success).toBe(true);
 a.controller.abort();await vi.waitFor(()=>expect(db.getTaskRunById(result.runId!)!.status).toBe('cancelled'));
 const calls=fixture.runs.length;await fixture.queued.shift()!();expect(fixture.runs).toHaveLength(calls);
});
it('cancels only the exact active run and fences late completion without stopping another workspace',async()=>{
 expect(typeof scheduler.triggerTaskRunTargeted).toBe('function');stops.mockClear();fixture.fail=true;const before=otherRows(),result=await scheduler.triggerTaskRunTargeted('A',deps,'A-cancel',admission());
 const work=fixture.queued.shift()!();await vi.waitFor(()=>expect(fixture.deferred).not.toBeNull());
 expect(await scheduler.cancelTaskRunTargeted(result.runId!,deps,admission())).toEqual({success:true});await work;
 expect(db.getTaskRunById(result.runId!)!.status).toBe('cancelled');expect(stops).toHaveBeenCalledTimes(1);expect(stops.mock.calls[0]![0]).toContain('#task:task-run-'+result.runId+'-attempt-');expect(otherRows()).toEqual(before);fixture.fail=false;
});
