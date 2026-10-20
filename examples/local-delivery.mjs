import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {WorkbenchAccessStore} from '../dist/role-eval/workbench-access.js';
import {ManagerStore} from '../dist/role-eval/manager-store.js';
import {createNativeBotIdentityReader} from '../dist/role-eval/native-bot-identity.js';
import {createWecomBotContext} from '../dist/role-eval/wecom-bot-context.js';
import {createBotSender} from '../dist/role-eval/wecom-bot-sender.js';
import {createBotDelivery} from '../dist/role-eval/wecom-bot-delivery.js';

const prefix='qiwe-delivery-demo-',marker='qiwe-delivery-demo/v1';
const scope={tenant:'synthetic-tenant',store:'synthetic-b',workspace:'web:synthetic-existing-ledger'};
const employee={accountId:'synthetic-account',employeeId:'synthetic-beautician',employeeName:'合成美容师'};
const actor={...scope,...employee};
const member='synthetic-member';
const request=()=>({correlationId:'synthetic-delivery-demo',signal:new AbortController().signal,deadline:performance.now()+3000});
const text=(content,id)=>({cmd:'aibot_msg_callback',headers:{req_id:'synthetic-'+id},body:{aibotid:'synthetic-bot',msgid:id,chattype:'single',from:{userid:member},msgtype:'text',text:{content}}});
const confirm=(report,taskId,id)=>({cmd:'aibot_event_callback',headers:{req_id:'synthetic-'+id},body:{aibotid:'synthetic-bot',msgid:id,chattype:'single',from:{userid:member},msgtype:'event',event:{eventtype:'template_card_event',task_id:taskId,event_key:'confirm:'+report.hash}}});
const ack=reqId=>({headers:{req_id:reqId},errcode:0}); // SDK ACK deliberately has no HTTP msgid.

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
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'synthetic-bot',corpId:'synthetic-corp',tenantId:scope.tenant,stores:[{id:scope.store}],roles:['manager'],store:grants,readNative,
  readSubject:async()=>({botId:'synthetic-bot',memberId:member}),
  readBinding:async()=>({botId:'synthetic-bot',corpId:'synthetic-corp',memberId:member,accountId:employee.accountId,version:1,active:true})});
 let frame,ready=true,failReply=false;
 const replies=[],notifications=[];
 const sender=createBotSender({timeoutMs:1000,sdk:{mode:'isolated-synthetic',ready:()=>ready,
  reply:async(event,body)=>{replies.push({reqId:event.headers.req_id,body:structuredClone(body)});if(failReply)throw Error('synthetic-post-invocation-failure');return ack(event.headers.req_id);},
  updateTemplateCard:async(event,update)=>{replies.push({reqId:event.headers.req_id,update:structuredClone(update)});if(failReply)throw Error('synthetic-post-invocation-failure');return ack(event.headers.req_id);},
  sendMessage:async(userid,body)=>{notifications.push({userid,body:structuredClone(body)});return ack('synthetic-proactive-ack');}}});
 const delivery=createBotDelivery({mode:'isolated-synthetic',authority,ledger,scope,employees:[employee],readEvent:()=>frame,now:()=>new Date('2026-10-17T01:00:00Z'),sender});
 return {grants,ledger,delivery,replies,notifications,setFrame:value=>{frame=value;},disconnect:()=>{ready=false;},failReply:()=>{failReply=true;},
  close(){delivery.close();authority.close();readNative.close();ledger.close();grants.close();}};
}
function log(step,id,business,notification,app){
 console.log(JSON.stringify({step,reportId:id,business,notification,replyCalls:app.replies.length,sendMessageCalls:app.notifications.length}));
}
function child(mode,directory,id){
 const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),mode,directory,id],{encoding:'utf8',timeout:10000,windowsHide:true,shell:false});
 if(result.error)throw result.error;
 assert.equal(result.status,0,'synthetic child failed: '+result.stderr);
 process.stdout.write(result.stdout);
}

if(process.argv.length>2){
 const mode=process.argv[2];assert.ok(['--recover','--repeat','--query-unknown'].includes(mode));assert.equal(process.argv.length,5);
 const directory=syntheticDirectory(process.argv[3]),id=process.argv[4];assert.match(id,/^[a-f0-9]{64}$/);
 const app=open(directory);
 try{
  const before=app.ledger.getReport(actor,id);assert.equal(before.state,'confirmed');
  if(mode==='--recover'){
   assert.equal(before.delivery.state,'blocked');
   const result=await app.delivery.recover(request(),id);
   assert.equal(result.delivery.state,'accepted');assert.equal(result.delivery.apiErrorCode,0);assert.equal(result.delivery.msgid,null);
   assert.equal(result.delivery.ackReqId,'synthetic-proactive-ack');assert.equal(app.replies.length,0);assert.equal(app.notifications.length,1);
   const notification=app.notifications[0];assert.equal(notification.userid,before.botSource.memberId);assert.equal(notification.userid,member);
   assert.equal(notification.body.msgtype,'markdown');const content=notification.body.markdown.content;
   assert.ok(content.includes('88.88元'));assert.ok(content.includes('2026-10-17至2026-10-17'));assert.ok(content.includes(id));
   assert.equal(app.ledger.getReport(actor,id).state,'confirmed');
   log('new-process-recovery',id,'confirmed',result.delivery.state,app);
  }else if(mode==='--repeat'){
   assert.equal(before.delivery.state,'accepted');
   const result=await app.delivery.recover(request(),id);
   assert.equal(result.delivery.state,'accepted');assert.equal(result.suppressed,true);
   assert.equal(app.replies.length,0);assert.equal(app.notifications.length,0);
   log('another-new-process-no-resend',id,'confirmed',result.delivery.state,app);
  }else{
   assert.equal(before.delivery.state,'unknown');
   const result=await app.delivery.recover(request(),id);
   assert.equal(result.delivery.state,'unknown');assert.equal(result.suppressed,true);
   assert.equal(app.replies.length,0);assert.equal(app.notifications.length,0);
   log('new-process-unknown-no-resend',id,'confirmed',result.delivery.state,app);
   app.setFrame(text('查询 '+id,'query-after-unknown'));
   const query=await app.delivery.handle(request());
   assert.equal(query.result.status,'confirmed');assert.equal(query.result.reportId,id);assert.equal(query.delivery.state,'accepted');
   assert.equal(app.replies.length,1);assert.equal(app.notifications.length,0);
   assert.equal(app.replies[0].reqId,'synthetic-query-after-unknown');
   const content=app.replies[0].body.stream.content;
   assert.ok(content.includes('66.66元'));assert.ok(content.includes('2026-10-16至2026-10-16'));assert.ok(content.includes(id));assert.ok(content.includes('结果未知'));
   assert.equal(app.ledger.getReport(actor,id).delivery.state,'unknown');
   log('new-query-callback-accepted-original-unknown',id,'confirmed','unknown',app);
  }
 }finally{app.close();}
}else{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
 const createdDirectory=fs.realpathSync(directory);
 let app;
 try{
  fs.writeFileSync(path.join(directory,'.synthetic-demo'),marker);
  syntheticDirectory(directory);
  const native=new DatabaseSync(path.join(directory,'native.sqlite'));
  try{native.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
   CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
   INSERT INTO users VALUES('synthetic-account','member','active',0);
   INSERT INTO registered_groups VALUES('web:synthetic-home','synthetic-account',1,'container');`);}finally{native.close();}
  app=open(directory);
  app.grants.change('synthetic-admin',{accountId:employee.accountId,storeId:scope.store,roles:['manager'],active:true,expectedVersion:0,requestKey:'synthetic-open'});
  app.setFrame(text('今天销售成交88.88元','report-blocked'));
  const pending=await app.delivery.handle(request());assert.equal(pending.result.status,'pending');assert.equal(pending.delivery.state,'accepted');
  const saved=app.ledger.getReport(actor,pending.result.reportId);assert.equal(saved.proposed.items[0].amountCents,8888);
  app.disconnect();app.setFrame(confirm(saved,pending.result.reply.body.template_card.task_id,'confirm-blocked'));
  const blocked=await app.delivery.handle(request());
  assert.equal(blocked.result.status,'confirmed');assert.equal(blocked.reportDelivery.state,'blocked');assert.equal(app.replies.length,1);assert.equal(app.notifications.length,0);
  assert.equal(app.ledger.getReport(actor,saved.id).state,'confirmed');assert.equal(app.ledger.summary(actor,'2026-10-17','month').salesCents,8888);
  log('parent-disconnected-confirmation',saved.id,'confirmed','blocked',app);
  app.close();app=undefined;
  child('--recover',directory,saved.id);
  child('--repeat',directory,saved.id);

  app=open(directory);app.setFrame(text('昨天销售成交66.66元','report-unknown'));
  const second=await app.delivery.handle(request());assert.equal(second.result.status,'pending');assert.equal(second.delivery.state,'accepted');
  const savedUnknown=app.ledger.getReport(actor,second.result.reportId);assert.notEqual(savedUnknown.id,saved.id);
  assert.equal(savedUnknown.proposed.items[0].start,'2026-10-16');assert.equal(savedUnknown.proposed.items[0].amountCents,6666);
  app.failReply();app.setFrame(confirm(savedUnknown,second.result.reply.body.template_card.task_id,'confirm-unknown'));
  const unknown=await app.delivery.handle(request());
  assert.equal(unknown.result.status,'confirmed');assert.equal(unknown.reportDelivery.state,'unknown');assert.equal(app.replies.length,2);assert.equal(app.notifications.length,0);
  assert.equal(app.ledger.getReport(actor,savedUnknown.id).state,'confirmed');assert.equal(app.ledger.summary(actor,'2026-10-17','month').salesCents,15554);
  log('parent-post-invocation-unknown',savedUnknown.id,'confirmed','unknown',app);
  app.close();app=undefined;
  child('--query-unknown',directory,savedUnknown.id);
 }finally{
  app?.close();
  // Only remove the exact directory this invocation created, after rechecking its scope and marker.
  assert.equal(syntheticDirectory(directory),createdDirectory);
  fs.rmSync(directory,{recursive:true,force:true});
 }
}
