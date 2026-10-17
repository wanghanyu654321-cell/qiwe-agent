import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import AdmZip from 'adm-zip';
import {WorkbenchAccessStore} from '../dist/role-eval/workbench-access.js';
import {ManagerStore} from '../dist/role-eval/manager-store.js';
import {ManagerArtifactStore} from '../dist/role-eval/manager-artifacts.js';
import {createNativeBotIdentityReader} from '../dist/role-eval/native-bot-identity.js';
import {createWecomBotContext} from '../dist/role-eval/wecom-bot-context.js';
import {createBotSender} from '../dist/role-eval/wecom-bot-sender.js';
import {createBotDelivery} from '../dist/role-eval/wecom-bot-delivery.js';

// A real SQLite/artifact fixture with SDK calls handled entirely in memory.
// Every identity and amount is synthetic. No credentials or network adapters.
const prefix='qiwe-operations-demo-',marker='qiwe-operations-demo/v1';
const scope={tenant:'synthetic-tenant',store:'synthetic-store',workspace:'web:synthetic-existing-ledger'};
const employee={accountId:'synthetic-account',employeeId:'synthetic-employee',employeeName:'合成员工'};
const actor={...scope,employeeId:employee.employeeId,employeeName:employee.employeeName};
const member='synthetic-member',bot='synthetic-bot';
const request=()=>({correlationId:'synthetic-operations-demo',signal:new AbortController().signal,deadline:performance.now()+3000});
const text=(content,id)=>({cmd:'aibot_msg_callback',headers:{req_id:'synthetic-'+id},body:{aibotid:bot,msgid:id,chattype:'single',from:{userid:member},msgtype:'text',text:{content}}});
const confirmation=(report,taskId,id)=>({cmd:'aibot_event_callback',headers:{req_id:'synthetic-'+id},body:{aibotid:bot,msgid:id,chattype:'single',from:{userid:member},msgtype:'event',event:{eventtype:'template_card_event',task_id:taskId,event_key:'confirm:'+report.hash}}});
const ack=reqId=>({headers:{req_id:reqId},errcode:0});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function syntheticDirectory(input){
 const directory=fs.realpathSync(input);
 assert.equal(path.dirname(directory).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
 assert.ok(path.basename(directory).startsWith(prefix));
 assert.equal(fs.readFileSync(path.join(directory,'.synthetic-demo'),'utf8'),marker);
 return directory;
}
function open(directory){
 const grants=new WorkbenchAccessStore(path.join(directory,'grants.sqlite'));
 const ledger=new ManagerStore(path.join(directory,'reports.sqlite'));
 const readNative=createNativeBotIdentityReader(path.join(directory,'native.sqlite'));
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:bot,corpId:'synthetic-corp',tenantId:scope.tenant,stores:[{id:scope.store}],roles:['manager'],store:grants,readNative,
  readSubject:async()=>({botId:bot,memberId:member}),
  readBinding:async()=>({botId:bot,corpId:'synthetic-corp',memberId:member,accountId:employee.accountId,version:1,active:true})});
 const artifacts=new ManagerArtifactStore({mode:'isolated-synthetic',directory:path.join(directory,'manager-artifacts')});
 const replies=[],uploads=[],files=[];let frame;
 const sender=createBotSender({timeoutMs:1000,sdk:{mode:'isolated-synthetic',ready:()=>true,
  reply:async(event,body)=>{replies.push({reqId:event.headers.req_id,body:structuredClone(body)});return ack(event.headers.req_id);},
  sendMessage:async()=>{throw Error('unexpected_markdown_fallback');}},fileSdk:{mode:'isolated-synthetic',
  uploadMedia:async(bytes,options)=>{assert.equal(options.type,'file');uploads.push({bytes:Buffer.from(bytes),filename:options.filename});return {type:'file',media_id:'synthetic-file-media'};},
  sendMessage:async(userid,body)=>{assert.equal(userid,member);assert.deepEqual(body,{msgtype:'file',chat_type:1,file:{media_id:'synthetic-file-media'}});files.push({userid,body:structuredClone(body)});return ack('synthetic-file-ack-'+files.length);}}});
 const delivery=createBotDelivery({mode:'isolated-synthetic',authority,ledger,artifacts,scope,employees:[employee],readEvent:()=>frame,now:()=>new Date('2026-10-18T01:00:00Z'),sender});
 return {grants,ledger,artifacts,delivery,replies,uploads,files,setFrame:value=>{frame=value;},
  close(){delivery.close();authority.close();readNative.close();ledger.close();grants.close();}};
}
function workbook(bytes,snapshotId){
 const zip=new AdmZip(Buffer.from(bytes)),summary=zip.readAsText('xl/worksheets/sheet1.xml');
 assert.ok(zip.getEntry('[Content_Types].xml'));assert.ok(zip.getEntry('xl/workbook.xml'));
 assert.ok(summary.includes(snapshotId));assert.ok(summary.includes('<v>0.2</v>'));assert.ok(summary.includes('<v>200</v>'));
 assert.ok(zip.readAsText('xl/worksheets/sheet2.xml').includes('2026-10-18'));
}
function log(step,app,extra={}){console.log(JSON.stringify({step,mode:'isolated-synthetic',...extra,replyCalls:app.replies.length,uploadCalls:app.uploads.length,fileSendCalls:app.files.length}));}
async function reportAndConfirm(app,content,id){
 app.setFrame(text(content,id));const pending=await app.delivery.handle(request());assert.equal(pending.result.status,'pending');assert.equal(pending.delivery.state,'accepted');
 const report=app.ledger.getReport(actor,pending.result.reportId);assert.equal(report.state,'pending');
 app.setFrame(confirmation(report,pending.result.reply.body.template_card.task_id,'confirm-'+id));
 const confirmed=await app.delivery.handle(request());assert.equal(confirmed.result.status,'confirmed');assert.equal(confirmed.reportDelivery.state,'accepted');
 return app.ledger.getReport(actor,report.id);
}

if(process.argv.length>2){
 assert.equal(process.argv[2],'--reopen');assert.equal(process.argv.length,7);
 const directory=syntheticDirectory(process.argv[3]),[snapshotId,originalId,correctionId]=process.argv.slice(4);
 for(const id of [snapshotId,originalId,correctionId])assert.match(id,/^[a-f0-9]{64}$/);
 const app=open(directory);
 try{
  assert.equal(app.ledger.summary(actor,'2026-10-18','month').salesCents,20000);
  assert.equal(app.ledger.getReport(actor,originalId).entries[0].amountCents,25000);
  assert.deepEqual(app.ledger.supersededEntryIds(actor,originalId),[originalId+':0']);
  assert.equal(app.ledger.getReport(actor,correctionId).state,'confirmed');
  // Replay the accepted parent event on a brand-new process: no upload/send.
  app.setFrame(text('导出Excel '+snapshotId,'export-excel'));const repeated=await app.delivery.handle(request());
  assert.equal(repeated.suppressed,true);assert.equal(repeated.delivery.state,'accepted');assert.equal(app.uploads.length,0);assert.equal(app.files.length,0);
  log('new-process-original-event-suppressed',app,{snapshotId});
  app.setFrame(text('查询汇总 '+snapshotId,'query-summary-after-reopen'));const summary=await app.delivery.handle(request());
  assert.equal(summary.result.status,'summary');assert.equal(summary.result.snapshotId,snapshotId);assert.ok(summary.result.reply.body.stream.content.includes('200.00元'));assert.ok(summary.result.reply.body.stream.content.includes('20.00%'));
  const saved=app.artifacts.artifact({accountId:employee.accountId,actor},snapshotId);assert.ok(saved);assert.equal(saved.info.sha256,sha256(saved.bytes));workbook(saved.bytes,snapshotId);
  app.setFrame(text('查询文件 '+snapshotId,'query-file-after-reopen'));const file=await app.delivery.handle(request());
  assert.equal(file.result.status,'file');assert.equal(file.delivery.state,'accepted');assert.equal(app.uploads.length,1);assert.equal(app.files.length,1);assert.deepEqual(app.uploads[0].bytes,Buffer.from(saved.bytes));
  const duplicate=await app.delivery.handle(request());assert.equal(duplicate.suppressed,true);assert.equal(app.uploads.length,1);assert.equal(app.files.length,1);
  log('new-process-query-summary-and-existing-file',app,{snapshotId,sha256:saved.info.sha256,byteLength:saved.info.byteLength,duplicateSuppressed:true,delivery:'synthetic-ack-accepted-not-phone-receipt'});
 }finally{app.close();}
}else{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix)),createdDirectory=fs.realpathSync(directory);let app;
 try{
  fs.writeFileSync(path.join(directory,'.synthetic-demo'),marker);syntheticDirectory(directory);
  const native=new DatabaseSync(path.join(directory,'native.sqlite'));
  try{native.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
   CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
   INSERT INTO users VALUES('synthetic-account','member','active',0);
   INSERT INTO registered_groups VALUES('web:synthetic-home','synthetic-account',1,'container');`);}finally{native.close();}
  app=open(directory);app.grants.change('synthetic-admin',{accountId:employee.accountId,storeId:scope.store,roles:['manager'],active:true,expectedVersion:0,requestKey:'synthetic-open'});
  await reportAndConfirm(app,'本月目标1000元','target');const original=await reportAndConfirm(app,'今天销售成交250元','sale');
  assert.equal(app.ledger.summary(actor,'2026-10-18','month').salesCents,25000);
  log('original-confirmed',app,{amountCents:25000});
  app.setFrame(text(`更正 ${original.id} 1 200元`,'correction'));const pending=await app.delivery.handle(request());assert.equal(pending.result.status,'pending');
  const correction=app.ledger.getReport(actor,pending.result.reportId);assert.deepEqual(correction.correction,{reportId:original.id,entryId:original.entries[0].id,previousAmountCents:25000});assert.equal(correction.proposed.items[0].amountCents,20000);
  assert.ok(pending.result.reply.body.stream.content.includes('250.00元'));assert.ok(pending.result.reply.body.stream.content.includes('200.00元'));assert.equal(app.ledger.summary(actor,'2026-10-18','month').salesCents,25000);
  log('correction-pending-original-still-counted',app,{oldAmountCents:25000,newAmountCents:20000});
  app.setFrame(confirmation(correction,pending.result.reply.body.template_card.task_id,'confirm-correction'));const confirmed=await app.delivery.handle(request());assert.equal(confirmed.result.status,'confirmed');assert.equal(confirmed.reportDelivery.state,'accepted');
  assert.equal(app.ledger.summary(actor,'2026-10-18','month').salesCents,20000);assert.deepEqual(app.ledger.getReport(actor,original.id),original);
  app.setFrame(text('经营汇总 2026-10-18 本月','summary'));const summary=await app.delivery.handle(request());assert.equal(summary.result.status,'summary');const snapshotId=summary.result.snapshotId;assert.match(snapshotId,/^[a-f0-9]{64}$/);assert.ok(summary.result.reply.body.stream.content.includes('20.00%'));
  app.setFrame(text('导出Excel '+snapshotId,'export-excel'));const exported=await app.delivery.handle(request());assert.equal(exported.result.status,'file');assert.equal(exported.delivery.state,'accepted');assert.equal(app.uploads.length,1);assert.equal(app.files.length,1);
  const saved=app.artifacts.artifact({accountId:employee.accountId,actor},snapshotId);assert.ok(saved);assert.equal(saved.info.sha256,sha256(app.uploads[0].bytes));assert.equal(saved.info.byteLength,app.uploads[0].bytes.length);assert.equal(app.uploads[0].filename,'sales-'+snapshotId+'.xlsx');workbook(app.uploads[0].bytes,snapshotId);
  assert.ok(fs.statSync(path.join(directory,'reports.sqlite')).isFile());assert.ok(fs.statSync(path.join(directory,'manager-artifacts')).isDirectory());
  const repeated=await app.delivery.handle(request());assert.equal(repeated.suppressed,true);assert.equal(app.uploads.length,1);assert.equal(app.files.length,1);
  log('correction-confirmed-summary-excel-synthetic-upload',app,{amountCents:20000,targetCents:100000,rate:0.2,snapshotId,sha256:saved.info.sha256,byteLength:saved.info.byteLength,duplicateSuppressed:true,delivery:'synthetic-ack-accepted-not-phone-receipt'});
  app.close();app=undefined;
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--reopen',directory,snapshotId,original.id,correction.id],{encoding:'utf8',timeout:10000,windowsHide:true,shell:false});
  if(child.error)throw child.error;assert.equal(child.status,0,'synthetic child failed: '+child.stderr);process.stdout.write(child.stdout);
 }finally{
  app?.close();assert.equal(syntheticDirectory(directory),createdDirectory);fs.rmSync(directory,{recursive:true,force:true});assert.equal(fs.existsSync(directory),false);
 }
 console.log(JSON.stringify({step:'temporary-fixture-cleaned',mode:'isolated-synthetic'}));
}
