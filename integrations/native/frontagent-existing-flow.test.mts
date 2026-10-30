import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import http from 'node:http';
import {installRestorationIsolation} from './full-host-restoration-isolation.fixture.mts';
import {prepareLocalContainerTransport,localContainerAnswer,localContainerRequest} from './full-host-local-container.fixture.mts';
import {createBotConversationNativePort} from '../test-support/conversation-overlay.mjs';
import {createRoleWorkspaceNativePort,createExistingRoleWorkspaceAdopter} from '../test-support/role-workspace-overlay.mjs';
import {WorkbenchAccessStore} from '../test-support/workbench-access.mjs';
import {ManagerStore} from '../test-support/manager-store.mjs';
import {BotTaskStore} from '../test-support/wecom-bot-task-store.mjs';
import {createWecomBotContext} from '../test-support/wecom-bot-context.mjs';
import {createWecomBotBindingReader} from '../test-support/wecom-bot-bindings.mjs';
import {createWecomBotPilot} from '../test-support/wecom-bot-pilot.mjs';
import {offlineBotSdk} from '../test-support/offline-bot-sdk.mjs';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const budget=()=>({signal:new AbortController().signal,deadline:performance.now()+30000,correlationId:'frontagent-existing-synthetic'});
const forbidden=()=>{throw Error('EXISTING_RESOURCE_CREATION_FORBIDDEN');};
const originalHomeRefresh=(before:any,after:any,started:number,checked:number)=>{
 if(!after)return false;
 const {updated_at:previous,...original}=before,{updated_at:current,...retained}=after;
 const time=typeof current==='string'?Date.parse(current):NaN,prior=typeof previous==='string'?Date.parse(previous):NaN;
 return hash(original)===hash(retained)&&Number.isFinite(time)&&Number.isFinite(prior)&&
  new Date(time).toISOString()===current&&time>=prior&&time>=started&&time<=checked;
};

it('uses restored original Frontagent identity and role in the same real host with offline synthetic I/O',async()=>{
 expect(process.env.QIWE_RESTORATION_REAL_CONTAINER).toBe('1');
 expect(process.env.QIWE_C4_SYNTHETIC_CASE).toBe('grounded');
 const input=process.env.QIWE_FRONTAGENT_EXISTING_INPUT;
 if(!input)throw Error('EXISTING_STATE_INPUT_REQUIRED');
 const descriptor=JSON.parse(fs.readFileSync(path.join(input,'descriptor.json'),'utf8'));
 if(descriptor.format!=='frontagent-existing-state-v1'||descriptor.role!=='marketing'||!/^\w[\w-]*$/.test(descriptor.accountId)||! /^[a-z0-9][a-z0-9_-]{0,127}$/.test(descriptor.folder))throw Error('EXISTING_STATE_DESCRIPTOR_INVALID');
 const transportCalls:any[]=[],events:string[]=[],restarting=process.env.QIWE_FULL_HOST_PHASE==='restart';
 const prefix='miniclaw-'+descriptor.folder+'-';
 const local=prepareLocalContainerTransport(transportCalls,{actor:{accountId:descriptor.accountId},folder:descriptor.folder,ownedContainerPrefix:prefix});
 const boundary=installRestorationIsolation(local.ports);
 const db=await import('../src/db.js'),config=await import('../src/config.js');
 const sql=new Database(path.join(config.STORE_DIR,'messages.db'),{fileMustExist:true});
  // Capture original rows before any original main startup, first HTTP review
  // or product read. Newly introduced tables do not invent a preboot baseline.
  const retainedTables=['users','agent_profiles','registered_groups','workspace_agent_profiles','agent_profile_prompt_versions','workspace_memory_items','workspace_memory_versions','workspace_memory_audit_events','workspace_memory_outbox','scheduled_tasks','task_runs','task_run_logs','messages','wecom_conversation_receipts','wecom_conversation_execution','wecom_conversation_results'];
  const tableExists=(table:string)=>!!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const retainedRows=retainedTables.filter(tableExists).map(table=>({table,rows:sql.prepare('SELECT rowid AS retained_rowid,* FROM '+table+' ORDER BY rowid').all() as any[]}));
  let retainedAfterStartup=retainedRows;
  const assertRetained=()=>{for(const {table,rows}of retainedAfterStartup)for(const row of rows)expect(hash(sql.prepare('SELECT rowid AS retained_rowid,* FROM '+table+' WHERE rowid=?').get(row.retained_rowid)),'retained original '+table+' row').toBe(hash(row));};
  const reportsFile=path.resolve('manager/reports.sqlite');
  if(!fs.existsSync(reportsFile))throw Error('EXISTING_BUSINESS_DATABASE_REQUIRED');
  const originalLedger=new Database(reportsFile,{fileMustExist:true});
  const originalLedgerRows=['employee_reports','bot_reply_intents'].filter(table=>originalLedger.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).map(table=>({table,rows:originalLedger.prepare('SELECT rowid AS retained_rowid,* FROM '+table+' ORDER BY rowid').all() as any[]}));originalLedger.close();
  const marker=path.resolve('frontagent-existing-result.json');
  if(!restarting&&fs.existsSync(marker))throw Error('EXISTING_RESULT_MARKER_ALREADY_EXISTS');
 const context=await import('../src/web-context.js'),web=await import('../src/web.js');
 const originalBootStarted=Date.now();
 const host=await import('../src/index.js') as any;
 let shutdown=false,pilot:any,authority:any,grants:any,ledger:any,tasks:any;
 const counts=()=>({users:(sql.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n,profiles:(sql.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get() as any).n,groups:(sql.prepare('SELECT COUNT(*) AS n FROM registered_groups').get() as any).n});
 // Hash retained business rows, never include their private contents in logs.
 const retained=()=>hash(['scheduled_tasks','task_runs','task_run_logs','messages','wecom_conversation_receipts','wecom_conversation_execution','wecom_conversation_results'].map(table=>[table,sql.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 try{
  await boundary.wait(()=>!!context.getWebDeps()&&boundary.servers.some(server=>server.listening),'original main exposes local HTTP');
  // Original db.ts backfill and ensureUserHomeGroup refresh the existing Home
  // binding timestamp at startup. Verify that exact original transition first;
  // every field (including that refreshed timestamp) is frozen thereafter.
  const homeFolders=new Set(retainedRows.find(item=>item.table==='registered_groups')!.rows.filter(row=>row.is_home===1).map(row=>row.folder));
  let homeBindingRefreshes=0;const startupChecked=Date.now();
  retainedAfterStartup=retainedRows.map(({table,rows})=>({table,rows:rows.map(row=>{
   const current=sql.prepare('SELECT rowid AS retained_rowid,* FROM '+table+' WHERE rowid=?').get(row.retained_rowid) as any;
   if(table==='workspace_agent_profiles'&&homeFolders.has(row.group_folder)){
    expect(originalHomeRefresh(row,current,originalBootStarted,startupChecked),'only original Home startup timestamp refresh').toBe(true);homeBindingRefreshes++;
    for(const key of ['agent_profile_id','interaction_mode','created_at','retained_rowid','group_folder'])
     expect(originalHomeRefresh(row,{...current,[key]:'synthetic-invalid-change'},originalBootStarted,startupChecked)).toBe(false);
    for(const updated_at of ['invalid',new Date(originalBootStarted-1).toISOString(),new Date(startupChecked+1).toISOString()])
     expect(originalHomeRefresh(row,{...current,updated_at},originalBootStarted,startupChecked)).toBe(false);
   }else expect(hash(current),'original preboot '+table+' row').toBe(hash(row));
   return current;
  })}));
  expect(homeBindingRefreshes).toBe(2);
  expect(host.fullHostBootGate.phase()).toBe('paused');expect(context.getWebDeps()!.queue).toBe(host.fullHostQueue);expect(counts()).toEqual(descriptor.expectedCounts);
  const address=boundary.servers.find(server=>server.listening)!.address() as any,base='http://127.0.0.1:'+address.port;
  const headers={cookie:descriptor.adminCookie,Origin:'http://127.0.0.1:39130','content-type':'application/json',Connection:'close'};
  const authResponse=await fetch(base+'/api/auth/me',{headers});expect(authResponse.status,'original server-issued administrator session authenticates').toBe(200);
  const authBody=await authResponse.json() as any,admin=authBody.user??authBody;
  expect(admin.role).toBe('admin');
  const productRead=async(route:string):Promise<any>=>new Promise((resolve,reject)=>{
   const request=http.request({hostname:'127.0.0.1',port:address.port,path:'/api/local-product/'+route,method:'GET',headers:{...headers,Host:'127.0.0.1:39130'}},response=>{
    const chunks:Buffer[]=[];let bytes=0;response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>8*1024*1024){request.destroy(Error('EXISTING_PRODUCT_READ_BUDGET'));return;}chunks.push(chunk);});
    response.on('end',()=>{try{if(response.statusCode!==200)throw Error('EXISTING_PRODUCT_READ_'+route+'_'+response.statusCode);resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});response.on('error',reject);
   });request.on('error',reject);request.setTimeout(10000,()=>request.destroy(Error('EXISTING_PRODUCT_READ_TIMEOUT')));request.end();
  });
  const productViews:any={};for(const route of ['config','drafts','manager','training']){const body=await productRead(route);expect(body.identity).toEqual({accountId:admin.id,workspaceJid:'web:main'});productViews[route]=body;}
  expect(productViews.config.roles).toHaveLength(7);expect(productViews.drafts.drafts).toHaveLength(5);expect(productViews.manager.reports).toHaveLength(4);expect(productViews.training.knowledge.documentsAvailable).toBe(11);
  const productEvidence={roles:7,drafts:5,reports:4,trainingDocuments:11,sha256:Object.fromEntries(['config','drafts','manager','training'].map(route=>[route,hash(productViews[route])]))};
  events.push('original-product-four-authenticated-HTTP-reads-retain-original-material-counts');
  const auth=await import('../src/auth.js') as any;
  const token=descriptor.adminCookie.match(/(?:^|;\s*)miniclaw_session=([^;]+)/)?.[1];
  if(!token)throw Error('EXISTING_ADMIN_COOKIE_REQUIRED');
  const verified=auth.verifySessionToken(decodeURIComponent(token));
  if(!verified||verified.legacy||typeof verified.token!=='string'||!verified.token)throw Error('EXISTING_ADMIN_SESSION_INVALID');
  const who={sessionId:verified.token,userId:admin.id};
  const status=await fetch(base+'/api/appointment/maintenance',{headers});expect(status.status).toBe(200);expect(await status.json()).toMatchObject({maintenance:true,phase:'paused'});
  // Exercise the actual original descriptor walker before granting recovery.
  // Changes are confined to this disposable host copy and always restored.
  const configurationRecord=(file:string)=>db.scanAppointmentBootInventory().records.find((r:any)=>r.key===createHash('sha256').update('config/'+file).digest('hex'));
  const keyFile=path.join(config.DATA_DIR,'config/session-secret.key'),settingsFile=path.join(config.DATA_DIR,'config/system-settings.json');
  const keyBytes=fs.readFileSync(keyFile),settingsBytes=fs.readFileSync(settingsFile);
  const expected=[['session-secret.key','original_loaded_session_secret'],['system-settings.json','original_disabled_plugin_autoscan']] as const;
  for(const [file,reason]of expected){const row=configurationRecord(file);expect(row?.disposition).toBe('eligible');expect(row?.evidence).toContain('verified_existing_config:'+reason);}
  try{
   fs.writeFileSync(keyFile,'synthetic-invalid-key');expect(configurationRecord('session-secret.key')?.disposition).toBe('blocked');
  }finally{fs.writeFileSync(keyFile,keyBytes);}
  try{
   fs.writeFileSync(settingsFile,'{"pluginAutoScan":true}');expect(configurationRecord('system-settings.json')?.disposition).toBe('blocked');
  }finally{fs.writeFileSync(settingsFile,settingsBytes);}
  const existingInput=process.env.QIWE_FRONTAGENT_EXISTING_INPUT;
  try{delete process.env.QIWE_FRONTAGENT_EXISTING_INPUT;for(const [file]of expected)expect(configurationRecord(file)?.disposition).toBe('blocked');}
  finally{process.env.QIWE_FRONTAGENT_EXISTING_INPUT=existingInput;}
  for(const [file]of expected)expect(configurationRecord(file)?.disposition).toBe('eligible');
  events.push('original-config-descriptor-walk-rejects-mismatch-and-unenabled-mode');
  const initial=await fetch(base+'/api/appointment/maintenance/review',{method:'POST',headers,body:'{}'});expect(initial.status).not.toBe(403);await initial.json();
  const before=retained(),preserved:any[]=[];
  const {classifyRestorationRow}=await import('../src/full-host-restoration-classifier.js');
  const observedRows=new Map(retainedRows.map(({table,rows})=>[table,rows]));
  const selections:any[]=[...sql.prepare('SELECT id FROM scheduled_tasks ORDER BY id').all().map((row:any)=>({kind:'task',taskId:row.id})),
   ...sql.prepare("SELECT m.chat_jid,m.id FROM messages m LEFT JOIN wecom_conversation_execution e ON e.workspace_jid=m.chat_jid AND e.message_id=m.id WHERE m.is_from_me=0 AND (m.delivery_status IS NULL OR m.delivery_status NOT IN ('cancelled','rejected')) AND NOT (COALESCE(e.state,'')='completed' AND EXISTS (SELECT 1 FROM wecom_conversation_results r WHERE r.receipt_id=e.receipt_id)) ORDER BY m.chat_jid,m.id").all().map((row:any)=>({kind:'message',chatJid:row.chat_jid,messageId:row.id}))];
  for(const selection of selections){
   if(selection.kind==='task'?db.isLegacyTaskPreserved(selection.taskId):db.isLegacyMessagePreserved(selection.chatJid,selection.messageId))continue;
   const table=selection.kind==='task'?'scheduled_tasks':'messages',row=observedRows.get(table)?.find((r:any)=>selection.kind==='task'?r.id===selection.taskId:r.id===selection.messageId&&r.chat_jid===selection.chatJid);
   if(!row||classifyRestorationRow(table,row,{rows:observedRows,evidence:[]}).disposition!=='blocked')continue;
   const selected=host.inspectFullHostLegacyWork(who,selection);
   expect(host.preserveFullHostLegacyWork(who,selection,selected.version)).toMatchObject({state:'manual_review_required'});preserved.push({kind:selection.kind,records:selected.records.length});
  }
  expect(retained()).toBe(before);expect(transportCalls).toEqual([]);
  const reviewed=await fetch(base+'/api/appointment/maintenance/review',{method:'POST',headers,body:'{}'}),review=await reviewed.json() as any;
  if(reviewed.status!==200||!review.recoverable){const inventory=db.scanAppointmentBootInventory();console.error('FRONTAGENT_EXISTING_RESTORE_BLOCKED',JSON.stringify({status:reviewed.status,blockers:inventory.blockers,records:inventory.records.filter((r:any)=>r.disposition==='blocked').map((r:any)=>({kind:r.kind,key:r.key,evidence:r.evidence}))}));throw Error('EXISTING_ORIGINAL_RESTORE_REVIEW_BLOCKED');}
  const restored=await fetch(base+'/api/appointment/maintenance/restore',{method:'POST',headers,body:JSON.stringify({confirmed:true,...review.ticket})});expect(restored.status).toBe(200);expect(await restored.json()).toMatchObject({restored:true,maintenance:false});
  expect(host.fullHostBootGate.phase()).toBe('ready');expect(retained()).toBe(before);
  expect((await fetch(base+'/api/groups/'+encodeURIComponent(descriptor.workspaceJid)+'/messages',{headers})).status,'administrator restore does not grant employee content').toBe(404);
  events.push('original-admin-auth-review-preserve-real-legacy-restore-no-content-acl-expansion');

  const bindingFile=path.join(config.DATA_DIR,'frontagent-wecom-bindings.json'),approvedFile=path.join(config.DATA_DIR,'frontagent-approved-roles.json'),grantFile=path.join(config.DATA_DIR,'frontagent-workbench-access.sqlite');
  const bindings=JSON.parse(fs.readFileSync(bindingFile,'utf8')),approved=JSON.parse(fs.readFileSync(approvedFile,'utf8'));
  if(!Array.isArray(bindings)||!Array.isArray(approved))throw Error('EXISTING_IDENTITY_CATALOG_INVALID');
  const matches=bindings.filter((b:any)=>b.accountId===descriptor.accountId&&b.active);if(matches.length!==1)throw Error('EXISTING_ACTIVE_BINDING_NOT_UNIQUE');const binding=matches[0];
  if(!fs.existsSync(grantFile)||!fs.existsSync(path.resolve('manager/reports.sqlite')))throw Error('EXISTING_BUSINESS_DATABASE_REQUIRED');
  grants=new WorkbenchAccessStore(grantFile);const grant=grants.get(descriptor.accountId);expect(grant).toMatchObject({active:true,storeId:descriptor.storeId,version:1,roles:['marketing']});
  const readBinding=createWecomBotBindingReader(async()=>JSON.parse(fs.readFileSync(bindingFile,'utf8')));
  const readNative=async(accountId:string)=>{const user=db.getUserById(accountId),homes=db.getGroupsByOwner(accountId).filter((g:any)=>g.is_home);if(homes.length!==1||homes[0].jid!==descriptor.homeJid||homes[0].created_by!==accountId||homes[0].executionMode!=='container')throw Error('EXISTING_HOME_CHANGED');return {user,workspaceJid:homes[0].jid};};
  const identity={tenantId:descriptor.tenantId,stores:[{id:descriptor.storeId}],roles:['marketing'],store:grants,readBinding,readNative};
  const readSubject=async()=>({botId:binding.botId,memberId:binding.memberId});
  authority=createWecomBotContext({mode:'isolated-synthetic',botId:binding.botId,corpId:binding.corpId,...identity,readSubject});
  const actorFrom=(ctx:any)=>({tenantId:ctx.identity.tenantId,accountId:ctx.identity.accountId,storeId:ctx.identity.storeId,grantVersion:ctx.identity.grantVersion,...ctx.channel});
  const readActor=async(scope:any)=>({...actorFrom(await authority.authorize({...scope,correlationId:'frontagent-existing-current'},'marketing')),role:'marketing'});
  const issued=await authority.authorize(budget(),'marketing'),actor=actorFrom(issued),roleActor={...actor,role:'marketing'};
  const group=db.getRegisteredGroup(descriptor.workspaceJid);expect(group).toMatchObject({folder:descriptor.folder,created_by:descriptor.accountId,is_home:false,executionMode:'container'});
  expect(db.getWorkspaceAgentProfileId(descriptor.folder)).toBe(descriptor.profileId);
  const mapping=approved.filter((r:any)=>Object.entries({...actor,role:'marketing',profileId:descriptor.profileId,workspaceJid:descriptor.workspaceJid}).filter(([k])=>!['grantVersion','bindingVersion'].includes(k)).every(([k,v])=>r[k]===v));expect(mapping).toHaveLength(1);
  const adopter=createExistingRoleWorkspaceAdopter({gate:host.fullHostBootGate,native:db,readActor,approvedResources:approved});
  const adoption={actor:roleActor,scope:budget(),idempotencyKey:hash([actor.tenantId,actor.accountId,actor.storeId,'marketing']),assertCurrent:()=>authority.assertCurrent(issued),withCurrent:<T,>(work:()=>T)=>authority.withCurrent(issued,work)};
  const adopted=await adopter.adopt(adoption);expect(adopted).toMatchObject({state:'ready',workspaceJid:descriptor.workspaceJid,profileId:descriptor.profileId});expect(await adopter.adopt(adoption)).toEqual(adopted);expect(counts()).toEqual(descriptor.expectedCounts);
  // Prefix activation follows current authority and exact Native resource checks.
  await authority.assertCurrent(issued);local.prepare(config);local.activate();
  ledger=new ManagerStore(reportsFile);tasks=new BotTaskStore(reportsFile);
  const offline=offlineBotSdk(binding.botId),deliveries:any[]=[];offline.lifecycle('disconnected');
  const manager=Reflect.get(offline.client,'wsManager') as any;
  pilot=createWecomBotPilot({mode:'isolated-synthetic',botId:binding.botId,corpId:binding.corpId,identity,readSubject,
   business:{scope:{tenant:descriptor.tenantId,store:descriptor.storeId,workspace:descriptor.homeJid},employees:[{accountId:descriptor.accountId,...descriptor.employee}],ledger,store:tasks},
   initializeExecution:(options:any)=>{const execution=host.initializeFullHostConversationExecution(options);expect(execution.queue).toBe(host.fullHostQueue);expect(execution.gate).toBe(host.fullHostBootGate);return execution;},
   authorize:(receipt:any)=>{const current=grants.get(descriptor.accountId),rows=JSON.parse(fs.readFileSync(bindingFile,'utf8'));const active=Array.isArray(rows)?rows.filter((r:any)=>r.active&&r.botId===binding.botId&&r.memberId===binding.memberId):[];const owner=db.getUserById(descriptor.accountId);return !!receipt&&owner?.role==='member'&&owner.status==='active'&&owner.must_change_password===false&&active.length===1&&['botId','corpId','memberId','accountId','version'].every(k=>active[0][k]===binding[k])&&current?.active&&current.version===receipt.actor.grantVersion&&current.storeId===receipt.actor.storeId&&current.roles.includes(receipt.role)&&Object.entries(actor).every(([k,v])=>receipt.actor[k]===v);},
   createIntake:(execution:any)=>createBotConversationNativePort({mode:'isolated-synthetic',gate:execution.gate,native:db,readActor,execution}),
   createRoles:(gate:any)=>{const port=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate,native:db,templates:[{key:'marketing',skills:[]}],prepareOwnProfiles:forbidden,journalDirectory:path.resolve('unused-existing-role-journal'),readActor});return {readRoleWorkspace:port.readRoleWorkspace,prepareRoleWorkspace:forbidden};},
   createClient:()=>offline.client,connect:()=>{offline.lifecycle('connected');manager.handleFrame({headers:{req_id:'aibot_subscribe_frontagent_existing'},errcode:0});},disconnect:()=>{offline.lifecycle('disconnected');manager.disconnect();},
   readFingerprint:()=>({botId:binding.botId,corpId:binding.corpId,ownerId:descriptor.accountId,configVersion:String(binding.version),credentialFingerprint:'synthetic-offline-only',workspaceFingerprint:hash(descriptor.workspaceJid)}),onDelivery:(_id:string,result:any)=>deliveries.push(result),
  });
  await expect(pilot.prepare()).resolves.toBe('prepared');expect(pilot.activate()).toBe(true);await pilot.idle();expect(offline.sent).toEqual([]);expect(transportCalls).toEqual([]);
  const send=async(id:string,text:string)=>{const req='frontagent-existing-'+id;offline.frame({cmd:'aibot_msg_callback',headers:{req_id:req},body:{msgid:id,aibotid:binding.botId,msgtype:'text',chattype:'single',create_time:1792458000,from:{userid:binding.memberId,corpid:binding.corpId},text:{content:text}}});await pilot.idle();return offline.sent.findLast((frame:any)=>frame.cmd==='aibot_respond_msg'&&frame.headers.req_id===req);};
  expect(JSON.stringify(await send((restarting?'restart':'boot')+'-select','岗位 内容营销'))).toContain('已选择');expect(tasks.currentConversation(actor)).toMatchObject({state:'ready',workspaceJid:descriptor.workspaceJid});
  let result:any,receiptId:string;
  if(!restarting){
   const origin='frontagent-existing-synthetic-demand';receiptId=hash([binding.corpId,binding.botId,binding.memberId,origin]);
   expect(JSON.stringify(await send(origin,localContainerRequest))).toContain(receiptId);
   await boundary.wait(()=>db.readConversationExecution(receiptId)?.state==='completed','same original queue freezes D5');await boundary.wait(()=>deliveries.length===1,'offline original sender receives ACK');
   expect(transportCalls).toHaveLength(1);expect(transportCalls[0].prompt).toContain(localContainerRequest);
   const results=db.readConversationResults(receiptId);expect(results).toHaveLength(1);result=results[0];expect(result.content).toBe(localContainerAnswer);expect(result.sourceOutputIds).toHaveLength(1);
   const execution=db.readConversationExecution(receiptId);expect(result).toMatchObject({queryId:execution.queryId,turnId:execution.turnId});
   const canonical=sql.prepare('SELECT content,turn_id,is_from_me FROM messages WHERE chat_jid=? AND id=?').get(descriptor.workspaceJid,result.sourceOutputIds[0]);expect(canonical).toEqual({content:result.content,turn_id:result.turnId,is_from_me:1});
   expect(deliveries[0].deliveries).toMatchObject([{state:'accepted'}]);expect(offline.sent.filter((f:any)=>f.cmd==='aibot_send_msg')).toHaveLength(1);
   fs.writeFileSync(marker,JSON.stringify({processId:process.pid,receiptId,result,counts:counts(),resource:{workspaceJid:descriptor.workspaceJid,profileId:descriptor.profileId},retainedBefore:before}),{flag:'wx'});
  }else{
   const first=JSON.parse(fs.readFileSync(marker,'utf8'));expect(first.processId).not.toBe(process.pid);receiptId=first.receiptId;result=first.result;
   expect(db.readConversationResults(receiptId)).toEqual([result]);expect(transportCalls).toEqual([]);expect(deliveries).toEqual([]);expect(offline.sent.filter((f:any)=>f.cmd==='aibot_send_msg')).toEqual([]);expect(counts()).toEqual(first.counts);
  }
  expect(JSON.stringify(await send((restarting?'restart':'boot')+'-query','查询对话 '+receiptId))).toContain(JSON.stringify(result.content).slice(1,-1));
  const checkedLedger=new Database(reportsFile,{fileMustExist:true});try{for(const {table,rows}of originalLedgerRows)for(const row of rows)expect(hash(checkedLedger.prepare('SELECT rowid AS retained_rowid,* FROM '+table+' WHERE rowid=?').get(row.retained_rowid)),'original ledger scope and body retained').toBe(hash(row));}finally{checkedLedger.close();}
  assertRetained();expect(counts()).toEqual(descriptor.expectedCounts);expect(db.getRegisteredGroup(descriptor.workspaceJid)?.folder).toBe(descriptor.folder);expect(db.getWorkspaceAgentProfileId(descriptor.folder)).toBe(descriptor.profileId);
  expect(offline.connect).not.toHaveBeenCalled();expect(boundary.blocked).toEqual([]);
  const localContainer=await local.verify(boundary);await pilot.close();pilot=undefined;
  process.emit('SIGTERM');shutdown=true;await boundary.wait(()=>boundary.exits.length>0,'original main shutdown');expect(boundary.exits).toEqual([0]);
  events.push(restarting?'different-process-query-original-D5-no-runner-or-resend':'same-identity-adoption-original-queue-shell-pi-three-restored-skills-canonical-D5-offline-ACK');
  fs.writeFileSync(process.env.QIWE_RESTORATION_FLOW_EVIDENCE??path.resolve('restoration-flow.json'),JSON.stringify({phase:restarting?'restart':'boot',processId:process.pid,events,transportCalls:transportCalls.length,employee:{runnerCalls:transportCalls.length,sdkReplies:offline.sent.filter((f:any)=>f.cmd==='aibot_respond_msg').length,sdkNotifies:offline.sent.filter((f:any)=>f.cmd==='aibot_send_msg').length},counts:counts(),homeBindingRefreshes,preserved,product:productEvidence,originalLedgerRowsRetained:originalLedgerRows.reduce((n,item)=>n+item.rows.length,0),localContainer},null,2),{flag:'wx'});
 }finally{
  await pilot?.close();authority?.close();grants?.close();ledger?.close();tasks?.close();
  if(!shutdown&&db.isDatabaseInitialized()){process.emit('SIGTERM');await boundary.wait(()=>boundary.exits.length>0,'failure cleanup original shutdown');}
  await web.shutdownWebServer();if(db.isDatabaseInitialized())db.closeDatabase();sql.close();boundary.close();
 }
});
