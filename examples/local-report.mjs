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
import {createBotReportHandler} from '../dist/role-eval/wecom-bot-handler.js';

const scope={tenant:'synthetic-tenant',store:'synthetic-b',workspace:'web:synthetic-existing-ledger'};
const employee={accountId:'synthetic-account',employeeId:'synthetic-beautician',employeeName:'合成美容师'};
const request=()=>({correlationId:'synthetic-report-demo',signal:new AbortController().signal,deadline:performance.now()+3000});
const text=(content,id)=>({cmd:'aibot_msg_callback',headers:{req_id:'synthetic-'+id},body:{aibotid:'synthetic-bot',msgid:id,chattype:'single',from:{userid:'synthetic-member'},msgtype:'text',text:{content}}});
function open(directory,readEvent){
 const grants=new WorkbenchAccessStore(path.join(directory,'grants.sqlite'));
 const ledger=new ManagerStore(path.join(directory,'reports.sqlite'));
 const readNative=createNativeBotIdentityReader(path.join(directory,'native.sqlite'));
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'synthetic-bot',corpId:'synthetic-corp',tenantId:scope.tenant,stores:[{id:scope.store}],roles:['manager'],store:grants,readNative,
  readSubject:async()=>({botId:'synthetic-bot',memberId:'synthetic-member'}),
  readBinding:async()=>({botId:'synthetic-bot',corpId:'synthetic-corp',memberId:'synthetic-member',accountId:employee.accountId,version:1,active:true})});
 return {grants,ledger,handler:createBotReportHandler({mode:'isolated-synthetic',authority,ledger,scope,employees:[employee],readEvent,now:()=>new Date('2026-10-17T01:00:00Z')}),close(){authority.close();readNative.close();ledger.close();grants.close();}};
}

if(process.argv[2]==='--query'){
 // Only a temporary synthetic fixture created below may enter this child process.
 const directory=fs.realpathSync(process.argv[3]);
 assert.equal(path.dirname(directory).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
 assert.ok(path.basename(directory).startsWith('qiwe-report-demo-'));
 assert.equal(fs.readFileSync(path.join(directory,'.synthetic-demo'),'utf8'),'qiwe-report-demo/v1');
 const id=process.argv[4];assert.match(id,/^[a-f0-9]{64}$/);
 const app=open(directory,()=>text('查询 '+id,'after-process-restart'));
 try{
  const result=await app.handler.handle(request());assert.equal(result.reportId,id);assert.equal(result.status,'confirmed');
  assert.ok(result.reply.body.stream.content.includes('88.88元'));
  assert.equal(app.ledger.getReport({...scope,...employee},id).delivery.state,'prepared');
  console.log(JSON.stringify({step:'new-process-query',reportId:id,state:result.status,notification:'prepared',amountCents:8888}));
 }finally{app.close();}
}else{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-report-demo-'));
 let app;
 try{
  fs.writeFileSync(path.join(directory,'.synthetic-demo'),'qiwe-report-demo/v1');
  const native=new DatabaseSync(path.join(directory,'native.sqlite'));
  try{native.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
   CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
   INSERT INTO users VALUES('synthetic-account','member','active',0);
   INSERT INTO registered_groups VALUES('web:synthetic-home','synthetic-account',1,'container');`);}finally{native.close();}
  let frame=text('今天销售成交88.88元','report-1');app=open(directory,()=>frame);
  app.grants.change('synthetic-admin',{accountId:employee.accountId,storeId:scope.store,roles:['manager'],active:true,expectedVersion:0,requestKey:'synthetic-open'});
  const pending=await app.handler.handle(request());assert.equal(pending.status,'pending');
  const saved=app.ledger.getReport({...scope,...employee},pending.reportId);
  assert.equal(saved.proposed.items[0].amountCents,8888);
  console.log(JSON.stringify({step:'pending',reportId:saved.id,state:saved.state,amountCents:8888}));
  frame={cmd:'aibot_event_callback',headers:{req_id:'synthetic-card'},body:{aibotid:'synthetic-bot',msgid:'card-1',chattype:'single',from:{userid:'synthetic-member'},msgtype:'event',event:{eventtype:'template_card_event',task_id:pending.reply.body.template_card.task_id,event_key:'confirm:'+saved.hash}}};
  assert.equal((await app.handler.handle(request())).status,'confirmed');
  assert.equal((await app.handler.handle(request())).status,'confirmed');
  assert.equal(app.ledger.summary({...scope,...employee},'2026-10-17','month').salesCents,8888);
  app.close();app=undefined;
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--query',directory,saved.id],{encoding:'utf8',timeout:10000,windowsHide:true});
  if(child.error)throw child.error;
  if(child.status!==0)throw Error('synthetic_child_query_failed: '+child.stderr);
  process.stdout.write(child.stdout);
 }finally{app?.close();fs.rmSync(directory,{recursive:true,force:true});}
}
