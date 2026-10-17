import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {WorkbenchAccessStore} from '../dist/role-eval/workbench-access.js';
import {ManagerStore} from '../dist/role-eval/manager-store.js';
import {BotTaskStore} from '../dist/role-eval/wecom-bot-task-store.js';
import {createNativeBotIdentityReader} from '../dist/role-eval/native-bot-identity.js';
import {createWecomBotContext} from '../dist/role-eval/wecom-bot-context.js';
import {createNativeBotTasks} from '../dist/role-eval/native-bot-tasks.js';
import {createBotTasks} from '../dist/role-eval/wecom-bot-tasks.js';
import {createTrainingSummaryService} from '../dist/role-eval/training-knowledge.js';
import {createTrainingGenerationService} from '../dist/role-eval/training-generation.js';
import {createBotSender} from '../dist/role-eval/wecom-bot-sender.js';
import {createBotDelivery} from '../dist/role-eval/wecom-bot-delivery.js';

// All identities, approved evidence, scheduler rows and SDK receipts below are
// synthetic local fixtures. This example never imports Native or opens a network
// connection. Its fake trigger records a projection, not a real Agent execution.
const prefix='qiwe-tasks-demo-',marker='qiwe-tasks-demo/v1';
const tenant='synthetic-tenant',storeId='synthetic-store',accountId='synthetic-account';
const corpId='synthetic-corp',botId='synthetic-bot',memberId='synthetic-member';
const homeJid='web:synthetic-home',workspaceJid='web:synthetic-owned-marketing';
const taskId='synthetic-existing-weekly-task',profileId='synthetic-owned-marketing-profile';
const folder='synthetic-owned-marketing-folder';
const scope={tenant,store:storeId,workspace:'web:synthetic-existing-ledger'};
const trainingScope={accountId,workspaceJid:'web:local-training'};
const employee={accountId,employeeId:'synthetic-employee',employeeName:'合成员工'};
const nativeOwner={tenantId:tenant,storeId,accountId,workspaceJid:homeJid,role:'marketing',corpId,botId,memberId,bindingVersion:1};
const nativeBackend={kind:'native',taskId,profileId,workspaceJid};
const request=()=>({correlationId:'synthetic-tasks-demo',signal:new AbortController().signal,deadline:performance.now()+4000});
const text=(content,id)=>({cmd:'aibot_msg_callback',headers:{req_id:'synthetic-'+id},body:{aibotid:botId,msgid:id,chattype:'single',from:{userid:memberId},msgtype:'text',text:{content}}});
const hash=value=>createHash('sha256').update(value).digest('hex');
const sourceText='# 合成培训资料\n\n## 家访练习\n先访谈，再演练，最后复盘。所有内容仅供本地合成演示。';
function syntheticDirectory(input){
 const directory=fs.realpathSync(input);
 assert.equal(path.dirname(directory).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
 assert.ok(path.basename(directory).startsWith(prefix));
 assert.equal(fs.readFileSync(path.join(directory,'.synthetic-demo'),'utf8'),marker);
 return directory;
}
function makeFixture(directory){
 const native=new DatabaseSync(path.join(directory,'synthetic-identity.sqlite'));
 try{native.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
  CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);`);
  native.prepare('INSERT INTO users VALUES(?,?,?,?)').run(accountId,'member','active',0);
  native.prepare('INSERT INTO registered_groups VALUES(?,?,?,?)').run(homeJid,accountId,1,'container');
 }finally{native.close();}
 const evidence=path.join(directory,'synthetic-training-evidence'),sha256=hash(sourceText);
 fs.mkdirSync(evidence);
 fs.writeFileSync(path.join(evidence,'approval.json'),JSON.stringify({kind:'user_provided_summary',scope:trainingScope,sha256,fileName:'synthetic.md'}));
 fs.writeFileSync(path.join(evidence,'summary-'+sha256+'.json'),JSON.stringify({scope:trainingScope,sha256,sourceText}));
}
function open(directory){
 syntheticDirectory(directory);
 const grants=new WorkbenchAccessStore(path.join(directory,'grants.sqlite'));
 const ledger=new ManagerStore(path.join(directory,'existing-reports.sqlite'));
 const references=new BotTaskStore(path.join(directory,'existing-reports.sqlite'));
 const readNative=createNativeBotIdentityReader(path.join(directory,'synthetic-identity.sqlite'));
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId,corpId,tenantId:tenant,stores:[{id:storeId}],roles:['marketing','training'],store:grants,readNative,
  readSubject:async()=>({botId,memberId}),readBinding:async()=>({botId,corpId,memberId,accountId,version:1,active:true})});
 // This separate DB stands in for verified original task_runs projections. The
 // preconfigured existing task/profile/workspace stay constant; no scheduler task
 // is created, edited or scheduled by a chat command.
 const runs=new DatabaseSync(path.join(directory,'synthetic-task-runs.sqlite'));
 runs.exec('CREATE TABLE IF NOT EXISTS task_runs(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,body TEXT NOT NULL,cancel_requests INTEGER NOT NULL DEFAULT 0);');
 const counts=()=>({triggerCalls:Number(runs.prepare('SELECT count(*) AS n FROM task_runs').get().n),cancelCalls:Number(runs.prepare('SELECT coalesce(sum(cancel_requests),0) AS n FROM task_runs').get().n)});
 const nativeCalls={trigger:0,cancel:0,inspect:0};
 const readRun=id=>{const row=runs.prepare('SELECT body FROM task_runs WHERE id=?').get(id);assert.ok(row,'synthetic run must exist');return JSON.parse(row.body);};
 const port={mode:'isolated-synthetic',enabled:true,
  async inspect(owner,backend){nativeCalls.inspect++;assert.deepEqual(owner,nativeOwner);assert.deepEqual(backend,nativeBackend);return {
   task:{id:taskId,chat_jid:workspaceJid,group_folder:folder,execution_type:'agent',execution_mode:'container',status:'active',deleted_at:null},
   group:{jid:workspaceJid,folder,created_by:accountId,execution_mode:'container',is_home:0},
   profile:{id:profileId,owner_user_id:accountId,status:'active'},bindingProfileId:profileId};},
  async trigger(originalTaskId,idempotencyKey){
   nativeCalls.trigger++;
   assert.equal(originalTaskId,taskId);assert.match(idempotencyKey,/^bot-[a-f0-9]{64}$/);
   assert.equal(runs.prepare('SELECT id FROM task_runs WHERE idempotency_key=?').get(idempotencyKey),undefined,'duplicate event must not call trigger again');
   const id='synthetic-run-'+hash(idempotencyKey).slice(0,20);
   const row={id,task_id:taskId,idempotency_key:idempotencyKey,trigger_type:'manual',status:'running',result:null,
    definition_snapshot:{chat_jid:workspaceJid,group_folder:folder,execution_type:'agent',execution_mode:'container'}};
   runs.prepare('INSERT INTO task_runs(id,idempotency_key,body) VALUES(?,?,?)').run(id,idempotencyKey,JSON.stringify(row));
   return {success:true,runId:id};
  },
  async getRun(id){return readRun(id);},
  async cancelRun(id){nativeCalls.cancel++;const row=readRun(id);assert.equal(row.status,'running');runs.prepare('UPDATE task_runs SET cancel_requests=cancel_requests+1 WHERE id=?').run(id);return {success:true};}
 };
 const native=createNativeBotTasks({port});
 const knowledge=createTrainingSummaryService(path.join(directory,'synthetic-training-evidence'),trainingScope);
 const pending=new Map();let generated=0;
 const training=createTrainingGenerationService({dir:path.join(directory,'synthetic-training-runs'),scope:trainingScope,knowledge,timeoutMs:5000,
  generate:async(context)=>{generated++;return new Promise(resolve=>{pending.set(context.input.requestKey,{context,resolve});});}});
 const tasks=createBotTasks({mode:'isolated-synthetic',authority,store:references,native,
  catalog:[{tenantId:tenant,storeId,accountId,homeJid,role:'marketing',alias:'weekly',taskId,profileId,workspaceJid}],
  training:{enabled:true,resolve:()=>training}});
 let frame;const replies=[];
 const sender=createBotSender({sdk:{mode:'isolated-synthetic',ready:()=>true,
  reply:async(event,body)=>{replies.push({reqId:event.headers.req_id,body:structuredClone(body)});return {headers:{req_id:event.headers.req_id},errcode:0};},
  sendMessage:async()=>{throw Error('synthetic-demo-forbids-proactive-send');}}});
 const delivery=createBotDelivery({mode:'isolated-synthetic',authority,ledger,tasks,scope,employees:[employee],readEvent:()=>frame,sender});
 const reference=(id,role)=>{const row=references.get({...nativeOwner,role},id);assert.ok(row);return row;};
 return {grants,ledger,references,native,training,knowledge,replies,counts,nativeCalls:()=>({...nativeCalls}),generated:()=>generated,
  async message(content,eventId){frame=text(content,eventId);return delivery.handle(request());},
  reference,
  async settle(id,late=false){const record=reference(id,'training');assert.equal(record.backend.kind,'training');const job=pending.get(record.backend.requestKey);assert.ok(job);
   job.resolve({answer:late?'迟到合成输出，不得恢复已取消任务。':'合成建议：先访谈，再演练，最后复盘。',lesson:null,citations:[job.context.sources[0].id],limitations:['合成资料，需人工审核。']});
   await training.settled(record.backend.requestKey);pending.delete(record.backend.requestKey);
  },
  setNativeTerminal(id,status){const row=readRun(id);assert.equal(status,'cancelled');row.status=status;runs.prepare('UPDATE task_runs SET body=? WHERE id=?').run(JSON.stringify(row),id);},
  async showDefaultPaused(){const before=counts(),beforeCalls={...nativeCalls};const paused=createNativeBotTasks({port:{...port,enabled:false}});try{
   const req=request();assert.deepEqual(await paused.start(nativeOwner,nativeBackend,'synthetic-default-paused',req,async()=>{}),{state:'blocked',detail:'native_disabled'});
   assert.deepEqual(counts(),before);assert.deepEqual(nativeCalls,beforeCalls);log('native-default-paused-zero-trigger',{triggerCalls:0,cancelCalls:0});
  }finally{paused.close();}},
  close(){delivery.close();tasks.close();native.close();training.close();authority.close();readNative.close();references.close();ledger.close();grants.close();runs.close();}
 };
}
function log(step,facts={}){console.log(JSON.stringify({step,mode:'isolated-synthetic',...facts}));}
function content(result){assert.equal(result.result.status,'task');assert.equal(result.delivery.state,'accepted');return result.result.reply.body.stream.content;}
function taskNumber(result){const id=result.result.taskId;assert.match(id,/^[a-f0-9]{64}$/);return id;}
async function query(app,role,id,eventId){return content(await app.message(`查询任务 ${role} ${id}`,eventId));}
const nativeStart='执行任务 内容营销 weekly',trainingStart='培训问答 指导员 家访练习';

if(process.argv.length>2){
 assert.equal(process.argv[2],'--reopen');assert.equal(process.argv.length,7);
 const directory=syntheticDirectory(process.argv[3]),[nativeId,readyId,unknownId]=process.argv.slice(4);
 for(const id of [nativeId,readyId,unknownId])assert.match(id,/^[a-f0-9]{64}$/);
 const app=open(directory);
 try{
  for(const [command,eventId,id] of [[nativeStart,'native-start',nativeId],[trainingStart,'training-ready',readyId],[trainingStart,'training-unknown',unknownId]]){
   const repeat=await app.message(command,eventId);assert.equal(repeat.suppressed,true);assert.equal(repeat.delivery.state,'accepted');assert.equal(taskNumber(repeat),id);
  }
  assert.deepEqual(app.counts(),{triggerCalls:1,cancelCalls:1});assert.equal(app.generated(),0);assert.equal(app.replies.length,0);
  assert.equal(app.nativeCalls().trigger,0);assert.equal(app.nativeCalls().cancel,0);
  log('new-process-original-events-suppressed',{persistedRuns:1,cancellationRequests:1,triggerCalls:0,cancelCalls:0,generateCalls:0,replyCalls:0});
  const native=await query(app,'内容营销',nativeId,'child-native-query');assert.ok(native.includes('已取消'));assert.ok(native.includes('已受理'));assert.ok(native.includes(app.reference(nativeId,'marketing').referenceId));
  const ready=await query(app,'培训',readyId,'child-ready-query');assert.ok(ready.includes('合成建议'));assert.ok(ready.includes('citations'));
  const unknown=await query(app,'培训',unknownId,'child-unknown-query');assert.ok(unknown.includes('结果未知'));
  const cancel=content(await app.message('取消任务 内容营销 '+nativeId,'child-repeat-cancel'));assert.ok(cancel.includes('已受理'));
  assert.deepEqual(app.counts(),{triggerCalls:1,cancelCalls:1});assert.equal(app.generated(),0);assert.equal(app.nativeCalls().trigger,0);assert.equal(app.nativeCalls().cancel,0);
  log('new-process-original-numbers-queryable',{nativeId,readyId,unknownId,trainingReady:true,trainingUnknown:true,cancellationRequests:1,replyCalls:app.replies.length,delivery:'synthetic-ack-accepted-not-phone-receipt'});
 }finally{app.close();}
}else{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix)),createdDirectory=fs.realpathSync(directory);let app;
 try{
  fs.writeFileSync(path.join(directory,'.synthetic-demo'),marker);syntheticDirectory(directory);makeFixture(directory);
  app=open(directory);app.grants.change('synthetic-admin',{accountId,storeId,roles:['marketing','training'],active:true,expectedVersion:0,requestKey:'synthetic-open'});
  await app.showDefaultPaused();
  const start=await app.message(nativeStart,'native-start');const nativeId=taskNumber(start);assert.ok(content(start).includes('执行中'));assert.deepEqual(app.counts(),{triggerCalls:1,cancelCalls:0});
  const originalReference=app.reference(nativeId,'marketing').referenceId;assert.ok(originalReference?.startsWith('synthetic-run-'));
  const repeat=await app.message(nativeStart,'native-start');assert.equal(repeat.suppressed,true);assert.equal(app.replies.length,1);assert.deepEqual(app.counts(),{triggerCalls:1,cancelCalls:0});
  assert.ok((await query(app,'内容营销',nativeId,'native-progress')).includes('执行中'));
  const cancel=content(await app.message('取消任务 内容营销 '+nativeId,'native-cancel'));assert.ok(cancel.includes('取消请求：已受理'));assert.ok(cancel.includes('执行中'));assert.deepEqual(app.counts(),{triggerCalls:1,cancelCalls:1});
  app.setNativeTerminal(originalReference,'cancelled');assert.ok((await query(app,'内容营销',nativeId,'native-terminal')).includes('已取消'));assert.equal(app.reference(nativeId,'marketing').referenceId,originalReference);
  assert.equal(app.nativeCalls().trigger,1);assert.equal(app.nativeCalls().cancel,1);
  log('native-exact-reference-cancel-request-then-original-terminal',{nativeId,originalReference,...app.counts(),duplicateSuppressed:true});

  const ready=await app.message(trainingStart,'training-ready');const readyId=taskNumber(ready);assert.ok(content(ready).includes('执行中'));await app.settle(readyId);
  const readyContent=await query(app,'培训',readyId,'training-ready-query');assert.ok(readyContent.includes('合成建议'));assert.ok(readyContent.includes('citations'));assert.ok(readyContent.includes(app.knowledge.search('家访').matches[0].id));
  log('training-ready-with-approved-synthetic-citation',{taskId:readyId,generateCalls:app.generated(),ready:true});
  const running=await app.message(trainingStart,'training-cancel');const cancelledId=taskNumber(running);content(running);
  assert.ok(content(await app.message('取消任务 培训 '+cancelledId,'training-cancel-request')).includes('已取消'));await app.settle(cancelledId,true);
  const cancelledContent=await query(app,'培训',cancelledId,'training-cancelled-query');assert.ok(cancelledContent.includes('已取消'));assert.ok(!cancelledContent.includes('迟到合成输出'));
  log('training-cancelled-late-output-fenced',{taskId:cancelledId,generateCalls:app.generated(),lateOutputPublished:false});
  const unfinished=await app.message(trainingStart,'training-unknown');const unknownId=taskNumber(unfinished);content(unfinished);
  assert.equal(app.generated(),3);assert.equal(app.ledger.list({...scope,employeeId:employee.employeeId,employeeName:employee.employeeName}).length,0);
  app.close();app=undefined;
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--reopen',directory,nativeId,readyId,unknownId],{encoding:'utf8',timeout:15000,windowsHide:true,shell:false});
  if(child.error)throw child.error;assert.equal(child.status,0,'synthetic child failed: '+child.stderr);process.stdout.write(child.stdout);
 }finally{
  app?.close();assert.equal(syntheticDirectory(directory),createdDirectory);fs.rmSync(directory,{recursive:true,force:true});assert.equal(fs.existsSync(directory),false);
 }
 log('temporary-fixture-cleaned',{delivery:'synthetic-ack-accepted-not-phone-receipt',networkCalls:0,modelCalls:0});
}
