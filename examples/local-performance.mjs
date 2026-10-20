import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspect} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import AdmZip from 'adm-zip';
import {WorkbenchAccessStore} from '../dist/role-eval/workbench-access.js';
import {ManagerStore} from '../dist/role-eval/manager-store.js';
import {ManagerArtifactStore} from '../dist/role-eval/manager-artifacts.js';
import {BotTaskStore} from '../dist/role-eval/wecom-bot-task-store.js';
import {createNativeBotIdentityReader} from '../dist/role-eval/native-bot-identity.js';
import {createWecomBotContext} from '../dist/role-eval/wecom-bot-context.js';
import {createNativeBotTasks} from '../dist/role-eval/native-bot-tasks.js';
import {createBotTasks} from '../dist/role-eval/wecom-bot-tasks.js';
import {createBotSender} from '../dist/role-eval/wecom-bot-sender.js';
import {createBotDelivery} from '../dist/role-eval/wecom-bot-delivery.js';

// Run after npm run build. One JSON object on stdout; SQLite warnings use stderr.
// Local synthetic facts/SDK projections only. No Native import, model or network.
const prefix='qiwe-performance-',marker='qiwe-performance/v1';
const storage=new AsyncLocalStorage(),samples=[],batches=[];
const scope={tenant:'synthetic-tenant',store:'synthetic-store',workspace:'web:synthetic-ledger'};
const botId='synthetic-bot',corpId='synthetic-corp',date='2026-10-20';
const requestBudgetMs=4000,senderTimeoutMs=1000,measuredCount=20,warmupCount=2;
const employees=Array.from({length:4},(_,i)=>({accountId:'synthetic-account-'+i,employeeId:'synthetic-employee-'+i,employeeName:'合成员工'+i}));
const sha=value=>createHash('sha256').update(value).digest('hex');
const actor=employee=>({...scope,employeeId:employee.employeeId,employeeName:employee.employeeName});
function redactDiagnostic(value){
 let text=String(value);
 // Keep the failure reason and source line while removing local path prefixes.
 const roots=[os.tmpdir(),os.homedir(),process.cwd(),fileURLToPath(new URL('..',import.meta.url))].sort((a,b)=>b.length-a.length);
 for(const root of roots)for(const form of new Set([root,root.replaceAll('\\','/'),pathToFileURL(root).href]))text=text.replaceAll(form,'<local>');
 return text.slice(0,6000);
}
function safeError(error){
 const value=input=>typeof input==='string'?redactDiagnostic(input):input===null||['number','boolean','undefined'].includes(typeof input)?input:redactDiagnostic(inspect(input,{depth:2,maxArrayLength:8,maxStringLength:1000}));
 return {name:redactDiagnostic(error?.name??'Error'),code:redactDiagnostic(error?.code??'sample_failure'),
  message:redactDiagnostic(error?.message??error),stack:redactDiagnostic(error?.stack??''),
  ...('actual' in Object(error)?{actual:value(error.actual)}:{}),...('expected' in Object(error)?{expected:value(error.expected)}:{}),
  ...(error?.operator?{operator:redactDiagnostic(error.operator)}:{})};
}
function timed(stage,name,work){
 const sample=storage.getStore();if(!sample)return work();
 const start=performance.now();let failed=false;
 const finish=()=>sample.spans.push({stage,name,ms:performance.now()-start,failed});
 try{const value=work();if(value&&typeof value.then==='function')return value.then(result=>{finish();return result;},error=>{failed=true;finish();throw error;});finish();return value;}
 catch(error){failed=true;finish();throw error;}
}
function instrument(target,stage,names){
 const methods=new Map(names.map(name=>[name,(...args)=>timed(stage,name,()=>Reflect.apply(target[name],target,args))]));
 return new Proxy(target,{get(object,key){return methods.get(key)??Reflect.get(object,key);}});
}
function statistics(values){
 if(!values.length)return {samples:0,p50Ms:null,p95Ms:null,maxMs:null};
 const sorted=[...values].sort((a,b)=>a-b),rank=p=>sorted[Math.ceil(p*sorted.length)-1];
 return {samples:values.length,p50Ms:rank(.5),p95Ms:rank(.95),maxMs:sorted.at(-1)};
}
function contained(input){
 const directory=fs.realpathSync(input),temp=fs.realpathSync(os.tmpdir());
 assert.equal(path.dirname(directory).toLowerCase(),temp.toLowerCase(),'temporary_parent_changed');
 assert.ok(path.basename(directory).startsWith(prefix),'temporary_prefix_changed');
 assert.equal(fs.readFileSync(path.join(directory,'.synthetic-performance'),'utf8'),marker,'temporary_marker_changed');
 return directory;
}
function initialize(directory){
 const identity=new DatabaseSync(path.join(directory,'native-identity.sqlite'));
 try{
  identity.exec('CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER); CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);');
  for(const [i,employee] of employees.entries()){
   identity.prepare('INSERT INTO users VALUES(?,?,?,?)').run(employee.accountId,'member','active',0);
   identity.prepare('INSERT INTO registered_groups VALUES(?,?,?,?)').run('web:synthetic-home-'+i,employee.accountId,1,'container');
  }
 }finally{identity.close();}
}
function open(directory){
 const started=performance.now(),closers=[];
 function owned(value){closers.unshift(()=>value.close());return value;}
 try{
  const grants=instrument(owned(new WorkbenchAccessStore(path.join(directory,'grants.sqlite'))),'grant-sync',['bindTenant','get','list','withCurrent','change']);
  const ledger=instrument(owned(new ManagerStore(path.join(directory,'ledger.sqlite'))),'ledger-outbox-sync',['receive','receiveBot','receiveBotCorrection','confirm','getReport','list','summary','supersededEntryIds','getBotReply','getBotFileReply','reserveBotReply','prepareBotReply','claimBotReply','finishBotReply','claimReturn','finishReturn']);
  const references=instrument(owned(new BotTaskStore(path.join(directory,'ledger.sqlite'))),'taskref-sync',['reserve','get','claimStart','finishStart','claimCancel','finishCancel']);
  const artifacts=instrument(new ManagerArtifactStore({mode:'isolated-synthetic',directory:path.join(directory,'artifacts')}),'artifact-export',['export']);
  // Persisted synthetic original task/run facts. No scheduler or runtime starts.
  const runs=owned(new DatabaseSync(path.join(directory,'synthetic-original-runs.sqlite')));
  runs.exec('CREATE TABLE task_runs(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,body TEXT NOT NULL,cancel_requests INTEGER NOT NULL DEFAULT 0);');
  const counters={reply:0,upload:0,fileSend:0,nativeTrigger:0,nativeCancel:0};
  const memberApps=employees.map((employee,i)=>{
   const memberId='synthetic-member-'+i,homeJid='web:synthetic-home-'+i,workspaceJid='web:synthetic-marketing-'+i;
   const taskId='synthetic-existing-task-'+i,profileId='synthetic-profile-'+i,folder='synthetic-folder-'+i;
   const read=owned(createNativeBotIdentityReader(path.join(directory,'native-identity.sqlite')));
   const authority=instrument(owned(createWecomBotContext({mode:'isolated-synthetic',botId,corpId,tenantId:scope.tenant,stores:[{id:scope.store}],roles:['manager','marketing'],store:grants,
    readSubject:()=>timed('identity-read','subject',async()=>({botId,memberId})),
    readBinding:()=>timed('identity-read','binding',async()=>({botId,corpId,memberId,accountId:employee.accountId,version:1,active:true})),
    readNative:(...args)=>timed('identity-read','native-readonly-sqlite',()=>read(...args))})),
    'public-authority',['authorize','assertCurrent','withCurrent']);
   const readRun=id=>{const row=runs.prepare('SELECT body FROM task_runs WHERE id=?').get(id);assert.ok(row,'synthetic_run_missing');return JSON.parse(row.body);};
   const port=instrument({mode:'isolated-synthetic',enabled:true,
    async inspect(owner,backend){
     assert.equal(owner.accountId,employee.accountId,'synthetic_owner_mismatch');assert.equal(backend.taskId,taskId,'synthetic_task_mismatch');
     return {task:{id:taskId,chat_jid:workspaceJid,group_folder:folder,execution_type:'agent',execution_mode:'container',status:'active',deleted_at:null},
      group:{jid:workspaceJid,folder,created_by:employee.accountId,execution_mode:'container',is_home:0},
      profile:{id:profileId,owner_user_id:employee.accountId,status:'active'},bindingProfileId:profileId};
    },
    async trigger(id,key){
     assert.equal(id,taskId,'synthetic_trigger_target');const runId='synthetic-run-'+sha(key).slice(0,24);
     const body={id:runId,task_id:taskId,idempotency_key:key,trigger_type:'manual',status:'running',result:null,definition_snapshot:{chat_jid:workspaceJid,group_folder:folder,execution_type:'agent',execution_mode:'container'}};
     runs.prepare('INSERT INTO task_runs(id,key,body) VALUES(?,?,?)').run(runId,key,JSON.stringify(body));counters.nativeTrigger++;return {success:true,runId};
    },
    async getRun(id){return readRun(id);},
    async cancelRun(id){readRun(id);runs.prepare('UPDATE task_runs SET cancel_requests=cancel_requests+1 WHERE id=?').run(id);counters.nativeCancel++;return {success:true};}
   },'synthetic-native',['inspect','trigger','getRun','cancelRun']);
   const native=owned(createNativeBotTasks({port}));
   const tasks=owned(createBotTasks({mode:'isolated-synthetic',authority,store:references,native,catalog:[{tenantId:scope.tenant,storeId:scope.store,accountId:employee.accountId,homeJid,role:'marketing',alias:'weekly',taskId,profileId,workspaceJid}]}));
   const sdk=instrument({mode:'isolated-synthetic',ready:()=>true,
    async reply(event){counters.reply++;return {headers:{req_id:event.headers.req_id},errcode:0};},
    async sendMessage(){throw Error('unexpected_proactive_send');}
   },'synthetic-sdk',['reply','sendMessage']);
   const fileSdk=instrument({mode:'isolated-synthetic',
    async uploadMedia(bytes,options){
     assert.equal(options.type,'file','synthetic_upload_type');
     const zip=new AdmZip(bytes);assert.ok(zip.test(),'invalid_workbook');
     for(const name of ['[Content_Types].xml','xl/workbook.xml','xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml'])assert.ok(zip.getEntry(name),'missing_workbook_part');
     counters.upload++;return {type:'file',media_id:'synthetic-media-'+counters.upload};
    },
    async sendMessage(recipient,body){assert.equal(recipient,memberId,'synthetic_file_recipient');assert.equal(body.chat_type,1,'synthetic_single_chat');counters.fileSend++;return {headers:{req_id:'synthetic-file-'+counters.fileSend},errcode:0};}
   },'synthetic-sdk',['uploadMedia','sendMessage']);
   const sender=createBotSender({sdk,fileSdk,timeoutMs:senderTimeoutMs});let frame;
   const delivery=owned(createBotDelivery({mode:'isolated-synthetic',authority,ledger,artifacts,tasks,scope,employees,readEvent:()=>frame,now:()=>new Date(date+'T01:00:00Z'),sender}));
   const text=(content,id)=>({cmd:'aibot_msg_callback',headers:{req_id:id},body:{aibotid:botId,msgid:id,chattype:'single',from:{userid:memberId},msgtype:'text',text:{content}}});
   async function handle(event){
    frame=event;const request={correlationId:event.headers.req_id,signal:new AbortController().signal,deadline:performance.now()+requestBudgetMs};
    const result=await timed('full-handle','delivery.handle',()=>delivery.handle(request));
    storage.getStore()?.handles.push({status:result.result.status,delivery:result.delivery?.state??null,suppressed:result.suppressed??false});
    assert.equal(result.delivery?.state,'accepted','delivery_not_accepted');assert.ok(!result.deferred,'delivery_persistence_deferred');return result;
   }
   return {employee,actor:actor(employee),async message(content,id){return handle(text(content,id));},
    async confirm(report,task,id){return handle({cmd:'aibot_event_callback',headers:{req_id:id},body:{aibotid:botId,msgid:id,chattype:'single',from:{userid:memberId},msgtype:'event',event:{eventtype:'template_card_event',task_id:task,event_key:'confirm:'+report.hash}}});}};
  });
  return {ledger,references,artifacts,counters,memberApps,runs,openMs:performance.now()-started,close(){for(const close of closers)close();}};
 }catch(error){for(const close of closers)close();throw error;}
}
function seed(app,index,id,target=false){
 const member=app.memberApps[index];
 const report=app.ledger.receive(member.actor,id,target?'本月目标10000元':'今天新增销售1元',date);
 assert.equal(report.state,'pending','seed_not_pending');
 app.ledger.confirm(member.actor,report.id,report.hash,report.proposed.items);
}
const workflows={
 async 'pending-confirm-query'(app,index,key){
  const member=app.memberApps[index],pending=await member.message('今天新增销售1元',key+'-pending');
  assert.equal(pending.result.status,'pending','report_not_pending');
  const report=app.ledger.getReport(member.actor,pending.result.reportId);assert.ok(report,'pending_report_missing');
  const confirmed=await member.confirm(report,pending.result.reply.body.template_card.task_id,key+'-confirm');
  assert.equal(confirmed.result.status,'confirmed','report_not_confirmed');
  const query=await member.message('查询 '+report.id,key+'-query');assert.equal(query.result.status,'confirmed','confirmed_query_failed');
 },
 async 'summary-export-file-query'(app,index,key){
  const member=app.memberApps[index],summary=await member.message('经营汇总 '+date+' 本月',key+'-summary');
  assert.equal(summary.result.status,'summary','summary_failed');const id=summary.result.snapshotId;
  const exported=await member.message('导出Excel '+id,key+'-export');assert.equal(exported.result.status,'file','export_failed');
  const saved=app.artifacts.artifact({accountId:member.employee.accountId,actor:member.actor},id);assert.ok(saved,'artifact_missing');
  assert.equal(saved.info.sha256,sha(saved.bytes),'artifact_hash_mismatch');
  const file=await member.message('查询文件 '+id,key+'-file');assert.equal(file.result.status,'file','file_query_failed');
 },
 async 'task-start-progress-cancel'(app,index,key){
  const member=app.memberApps[index],started=await member.message('执行任务 内容营销 weekly',key+'-start');
  assert.equal(started.result.status,'task','task_start_failed');assert.equal(started.result.taskStatus,'running','task_not_running');
  const id=started.result.taskId,progress=await member.message('查询任务 内容营销 '+id,key+'-progress');
  assert.equal(progress.result.taskStatus,'running','task_progress_failed');
  const cancelled=await member.message('取消任务 内容营销 '+id,key+'-cancel');
  assert.ok(cancelled.result.reply.body.stream.content.includes('取消请求：已受理'),'task_cancel_not_requested');
  // Accepted cancellation request is measured; no synthetic terminal completion.
 }
};
async function sample(app,workflow,phase,index,ordinal){
 const item={workflow,phase,member:index,ordinal,spans:[],handles:[],ok:false};samples.push(item);
 const key='perf-'+workflow.split('-')[0]+'-'+phase+'-'+ordinal;
 await storage.run(item,async()=>{
  const start=performance.now();
  try{await workflows[workflow](app,index,key);item.ok=true;}catch(error){item.error=safeError(error);}
  finally{item.totalMs=performance.now()-start;}
 });
}
function summarize(){
 const result=[];
 for(const workflow of Object.keys(workflows))for(const phase of ['cold-first-use','warmup','hot-serial','hot-concurrent-4']){
  const selected=samples.filter(s=>s.workflow===workflow&&s.phase===phase),stages={};
  for(const stage of new Set(selected.flatMap(s=>s.spans.map(span=>span.stage)))){
   const relevant=selected.filter(s=>s.spans.some(span=>span.stage===stage));
   stages[stage]={...statistics(relevant.map(s=>s.spans.filter(span=>span.stage===stage).reduce((total,span)=>total+span.ms,0))),
    calls:relevant.reduce((total,s)=>total+s.spans.filter(span=>span.stage===stage).length,0),
    failedCalls:relevant.reduce((total,s)=>total+s.spans.filter(span=>span.stage===stage&&span.failed).length,0)};
  }
  result.push({workflow,phase,...statistics(selected.map(s=>s.totalMs)),errors:selected.filter(s=>!s.ok).length,stages});
 }
 return result;
}
const started=performance.now(),directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
let app,createdDirectory,setupError,cleanupError,counts,openMs;
try{
 fs.writeFileSync(path.join(directory,'.synthetic-performance'),marker);createdDirectory=contained(directory);initialize(directory);app=open(directory);openMs=app.openMs;
 for(const [index,employee] of employees.entries()){
  // Fixture preparation is outside every timed sample.
  const grantStore=new WorkbenchAccessStore(path.join(directory,'grants.sqlite'));
  try{grantStore.change('synthetic-admin',{accountId:employee.accountId,storeId:scope.store,roles:['manager','marketing'],active:true,expectedVersion:0,requestKey:'synthetic-grant-'+index});}finally{grantStore.close();}
  seed(app,index,'seed-target-'+index,true);for(let j=0;j<2;j++)seed(app,index,'seed-sale-'+index+'-'+j);
 }
 for(const workflow of Object.keys(workflows)){
  let ordinal=0;
  async function prepareAndRun(phase,indices){
   // New snapshot per serial sample / concurrent batch; prevents hot export
   // measurements becoming only cached-workbook retrieval. Outside timer.
   if(workflow==='summary-export-file-query')for(const index of indices)seed(app,index,'summary-seed-'+ordinal+'-'+index);
   const batchStart=performance.now();
   await Promise.all(indices.map(index=>sample(app,workflow,phase,index,ordinal++)));
   batches.push({workflow,phase,members:indices.length,ms:performance.now()-batchStart});
  }
  await prepareAndRun('cold-first-use',[0]);
  for(let n=0;n<warmupCount;n++)await prepareAndRun('warmup',[n%4]);
  for(let n=0;n<measuredCount;n++)await prepareAndRun('hot-serial',[n%4]);
  for(let n=0;n<measuredCount/4;n++)await prepareAndRun('hot-concurrent-4',[0,1,2,3]);
 }
 const facts=new DatabaseSync(path.join(directory,'ledger.sqlite'),{readOnly:true});
 try{
  counts={initialConfirmedReports:12,finalReports:app.ledger.list(actor(employees[0])).length,
   confirmedReports:Number(facts.prepare("SELECT count(*) AS n FROM employee_reports WHERE json_extract(body,'$.state')='confirmed'").get().n),
   taskReferences:Number(facts.prepare('SELECT count(*) AS n FROM bot_task_refs').get().n),
   outboxIntents:Number(facts.prepare('SELECT count(*) AS n FROM bot_reply_intents').get().n),
   persistedTaskRuns:Number(app.runs.prepare('SELECT count(*) AS n FROM task_runs').get().n),
   cancellationRequests:Number(app.runs.prepare('SELECT sum(cancel_requests) AS n FROM task_runs').get().n),...app.counters};
 }finally{facts.close();}
 assert.equal(counts.confirmedReports,98,'confirmed_report_count');
 assert.equal(counts.taskReferences,43,'task_reference_count');assert.equal(counts.persistedTaskRuns,43,'native_run_count');
 assert.equal(counts.cancellationRequests,43,'native_cancel_count');
}catch(error){setupError=safeError(error);}
finally{
 try{app?.close();assert.equal(contained(directory),createdDirectory,'temporary_directory_changed');fs.rmSync(directory,{recursive:true,force:true});assert.equal(fs.existsSync(directory),false,'temporary_cleanup_failed');}
 catch(error){cleanupError=safeError(error);}
}
const errors=samples.filter(s=>!s.ok).length;
const output={schema:'qiwe-local-performance/v1',mode:'isolated-synthetic',sourceSha256:sha(fs.readFileSync(new URL(import.meta.url))),
 environment:{node:process.version,platform:process.platform,arch:process.arch,hostLabel:'synthetic-local-host',logicalCpus:os.availableParallelism()},
 config:{members:4,requestBudgetMs,senderTimeoutMs,warmupsPerWorkflow:warmupCount,serialSamplesPerWorkflow:measuredCount,concurrentSamplesPerWorkflow:measuredCount,concurrentBatchSize:4},
 definitions:{units:'milliseconds',clock:'performance.now; unrounded double precision; display rounding is not clock accuracy',percentiles:'nearest rank: sorted[ceil(p*n)-1]; all samples, including failed samples, retained',
  cold:'First invocation of each workflow in this one Node process after fixture setup; not a fresh process or cold OS page cache. Setup/open measured separately.',
  concurrent:'Four independent trusted member readers/authorities and deliveries, one Node event loop, shared SQLite/artifact directory; not multi-process load.',
  total:'Entire 3-handle workflow plus script assertions. Each handle has its own 4000ms request budget; sender timeout is 1000ms.',
  stages:'Per-workflow sum of wrapper call durations. Public authority calls include identity and synchronous grant/ledger work; artifact export includes authority calls. Nested spans overlap and MUST NOT be added together.',
  sync:'Grant/ledger/taskref public synchronous method durations include real SQLite work; not a SQLite engine-only transaction profiler. Internal self-calls are not separately wrapped.',
  artifact:'Real XLSX generation/publication. New confirmed source data before each measured summary batch; members own separate artifact locations. File query resends existing bytes.',
  sdk:'In-memory synthetic SDK with real workbook integrity assertions; no network latency. Native stage uses local synthetic projections and SQLite task_runs; cancellation acceptance is not task completion.',
  excluded:'Fixture setup/seed writes and final counting/cleanup excluded from workflow samples. No model calls, actual Native runtime, real SDK, network, phone receipt or production SLA.'},
 setupOpenMs:openMs??null,data:counts??null,sampleCount:samples.length,warmupSamples:samples.filter(s=>s.phase==='warmup').length,
 errorCount:errors+(setupError?1:0)+(cleanupError?1:0),cleanupSucceeded:!cleanupError,
 ...(setupError?{setupError}:{}),...(cleanupError?{cleanupError}:{}),wallMs:performance.now()-started,summary:summarize(),batches,samples};
console.log(JSON.stringify(output,null,2));
if(output.errorCount)process.exitCode=1;
