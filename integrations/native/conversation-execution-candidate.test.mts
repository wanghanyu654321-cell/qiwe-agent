import {afterAll,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import Database from '../src/sqlite-compat.js';
import * as db from '../src/db.js';
import {DATA_DIR,STORE_DIR} from '../src/config.js';
import {setWebDeps} from '../src/web-context.js';
import {prepareOwnProfiles} from '../test-support/workbench-opening.mjs';
import {createRoleWorkspaceNativePort} from '../test-support/role-workspace-overlay.mjs';
import {createBotConversationNativePort} from '../test-support/conversation-overlay.mjs';
import {createWecomBotAssembly} from '../test-support/wecom-bot-assembly.mjs';
import {createBotSdkAdapter} from '../test-support/wecom-bot-sdk.mjs';
import {WorkbenchAccessStore} from '../test-support/workbench-access.mjs';
import {ManagerStore} from '../test-support/manager-store.mjs';
import {BotTaskStore} from '../test-support/wecom-bot-task-store.mjs';
import {offlineBotSdk} from '../test-support/offline-bot-sdk.mjs';

const actor={tenantId:'synthetic-tenant',accountId:'synthetic-conversation-owner',storeId:'synthetic-store',corpId:'synthetic-corp',botId:'synthetic-bot',memberId:'synthetic-member',bindingVersion:1,grantVersion:1};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receiptId=hash([actor.corpId,actor.botId,actor.memberId,'synthetic-origin']);
const roleKey=hash([actor.tenantId,actor.accountId,actor.storeId,'marketing']);
const gate={isPaused:()=>false,beginWrite:()=>Symbol('isolated-candidate'),finishWrite:()=>{}};
const readActor=async()=>({...actor});
const scope=()=>({signal:new AbortController().signal,deadline:performance.now()+20000,correlationId:'synthetic-conversation'});
const request=(target?:any,changes:any={})=>({actor:{...actor},roles:['marketing'],receiptId,originMessageId:'synthetic-origin',fingerprint:'synthetic-fingerprint',text:'合成岗位需求',target,scope:scope(),assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work(),...changes});
let initialized=false;
const blocked:string[]=[];
vi.spyOn(net.Socket.prototype,'connect').mockImplementation((()=>{blocked.push('tcp');throw Error('CONVERSATION_NETWORK_FORBIDDEN');}) as any);
vi.spyOn(net.Server.prototype,'listen').mockImplementation((()=>{blocked.push('listen');throw Error('CONVERSATION_LISTEN_FORBIDDEN');}) as any);
for(const name of Object.keys(dns).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'||name==='lookup'))vi.spyOn(dns,name as any).mockImplementation((()=>{blocked.push('dns');throw Error('CONVERSATION_DNS_FORBIDDEN');}) as any);
for(const name of Object.keys(dns.promises).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'||name==='lookup'))vi.spyOn(dns.promises,name as any).mockImplementation((()=>{blocked.push('dns');throw Error('CONVERSATION_DNS_FORBIDDEN');}) as any);
for(const name of ['send','connect','bind'] as const)vi.spyOn(dgram.Socket.prototype,name as any).mockImplementation((()=>{blocked.push('udp');throw Error('CONVERSATION_UDP_FORBIDDEN');}) as any);
for(const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'] as const)vi.spyOn(childProcess,name as any).mockImplementation((()=>{blocked.push('child');throw Error('CONVERSATION_CHILD_FORBIDDEN');}) as any);
syncBuiltinESMExports();
afterAll(()=>{if(initialized)db.closeDatabase();vi.restoreAllMocks();syncBuiltinESMExports();});

it('fixture actually rejects socket, listener, DNS, UDP and child execution',()=>{
 for(const target of [{host:'192.0.2.1',port:443},{host:'::1',port:443},{path:'/synthetic-denied.sock'},{path:'\\\\.\\pipe\\synthetic-denied'}])expect(()=>new net.Socket().connect(target as any)).toThrow('CONVERSATION_NETWORK_FORBIDDEN');
 expect(()=>new net.Socket().connect(443,'192.0.2.1')).toThrow('CONVERSATION_NETWORK_FORBIDDEN');
 for(const target of [{host:'127.0.0.1',port:0},{host:'::1',port:0},'/synthetic-denied.sock','\\\\.\\pipe\\synthetic-denied'])expect(()=>net.createServer().listen(target as any)).toThrow('CONVERSATION_LISTEN_FORBIDDEN');
 expect(()=>net.createServer().listen(0,'127.0.0.1')).toThrow('CONVERSATION_LISTEN_FORBIDDEN');
 expect(()=>dns.resolve('synthetic.invalid',()=>{})).toThrow('CONVERSATION_DNS_FORBIDDEN');
 expect(()=>dns.promises.resolve('synthetic.invalid')).toThrow('CONVERSATION_DNS_FORBIDDEN');
 const udp=dgram.createSocket('udp4');expect(()=>udp.send('x',1234,'192.0.2.1')).toThrow('CONVERSATION_UDP_FORBIDDEN');
 expect(()=>udp.connect(1234,'192.0.2.1')).toThrow('CONVERSATION_UDP_FORBIDDEN');
 expect(()=>udp.bind(1234,'127.0.0.1')).toThrow('CONVERSATION_UDP_FORBIDDEN');udp.close();
 expect(()=>childProcess.spawn('synthetic')).toThrow('CONVERSATION_CHILD_FORBIDDEN');
 expect(()=>childProcess.spawnSync('synthetic')).toThrow('CONVERSATION_CHILD_FORBIDDEN');
 blocked.length=0;
});


it('same SDK request executes original queue/index/session and exact cancel survives process restart',async()=>{
 if(process.env.QIWE_CONVERSATION_PHASE!=='restart'){
  fs.mkdirSync(STORE_DIR,{recursive:true});fs.mkdirSync(DATA_DIR,{recursive:true});
  const old=new Database(path.join(STORE_DIR,'messages.db'));
  old.exec("CREATE TABLE router_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO router_state VALUES ('schema_version','70'); INSERT INTO router_state VALUES ('d3-migration-marker','preserved')");old.close();
  const bad=path.join(DATA_DIR,'migration-blocker');fs.writeFileSync(bad,'synthetic');process.env.MINICLAW_MIGRATION_BACKUP_DIR=bad;
  expect(()=>db.initDatabase()).toThrow('pre-migration backup failed');
  const probe=new Database(path.join(STORE_DIR,'messages.db'));
  expect(probe.prepare("SELECT value FROM router_state WHERE key='schema_version'").get()).toEqual({value:'70'});
  expect(probe.prepare("SELECT name FROM sqlite_master WHERE name='wecom_conversation_execution'").get()).toBeUndefined();probe.close();delete process.env.MINICLAW_MIGRATION_BACKUP_DIR;
 }
 db.initDatabase();initialized=true;
 expect(db.getRouterState('schema_version')).toBe('71');
 expect(db.getRouterState('d3-migration-marker')).toBe('preserved');
 const marker=path.join(DATA_DIR,'d3-first.json');
 if(process.env.QIWE_CONVERSATION_PHASE==='restart'){
  const first=JSON.parse(fs.readFileSync(marker,'utf8'));expect(first.processId).not.toBe(process.pid);
  db.bindConversationAuthority(()=>true);
  for(const item of first.receipts)expect(db.readConversationExecution(item.receiptId)).toEqual(item.execution);
  expect(db.getMessagesSince(first.jid,{timestamp:'',id:''}).filter(message=>first.receipts.some((item:any)=>item.messageId===message.id))).toEqual([]);
  const grants=new WorkbenchAccessStore(path.join(DATA_DIR,'conversation-grants.sqlite'));
  const ledger=new ManagerStore(path.join(DATA_DIR,'conversation-facts.sqlite'));const tasks=new BotTaskStore(path.join(DATA_DIR,'conversation-facts.sqlite'));
  const offline=offlineBotSdk(),adapter=createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client});
  const port=createBotConversationNativePort({mode:'isolated-synthetic',gate,native:db,readActor,execution:{enqueue:()=>{throw Error('RESTART_NO_EXECUTION')},cancel:()=>{throw Error('RESTART_NO_CANCEL')}}});
  const assembly=createWecomBotAssembly({mode:'isolated-synthetic',client:offline.client,botId:actor.botId,corpId:actor.corpId,
   identity:{tenantId:actor.tenantId,stores:[{id:actor.storeId}],roles:['marketing'],store:grants,readBinding:async()=>({botId:actor.botId,corpId:actor.corpId,memberId:actor.memberId,accountId:actor.accountId,active:true,version:1}),readNative:async()=>({user:{id:actor.accountId,role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-'+actor.accountId})},
   businesses:[{scope:{tenant:actor.tenantId,store:actor.storeId,workspace:'web:original'},employees:[{accountId:actor.accountId,employeeId:'synthetic-employee',employeeName:'合成员工'}],ledger,conversations:{store:tasks,native:{readRoleWorkspace:async()=>{throw Error('RESTART_NO_PREPARE')},prepareRoleWorkspace:async()=>{throw Error('RESTART_NO_PREPARE')}},intake:port}}],sender:{sdk:adapter}});
  try{
   offline.authenticate();
   for(const item of first.receipts){
    const id='restart-'+item.receiptId;
    offline.frame({cmd:'aibot_msg_callback',headers:{req_id:id},body:{msgid:id,aibotid:actor.botId,msgtype:'text',chattype:'single',from:{userid:actor.memberId,corpid:actor.corpId},text:{content:'查询对话 '+item.receiptId}}});await assembly.idle();
    expect(JSON.stringify(offline.sent.at(-1))).toContain(item.receiptId);
    expect(JSON.stringify(offline.sent.at(-1))).toContain(item.execution.state==='completed'?'执行已结束':item.execution.state==='cancelled'?'已取消':item.execution.state==='failed'?'执行失败':item.execution.state==='cancelling'?'取消处理中':'执行结果待核实');
   }
  }finally{assembly.close();grants.close();ledger.close();tasks.close();}
  fs.writeFileSync(process.env.QIWE_CONVERSATION_EVIDENCE!,JSON.stringify({phase:'restart',processId:process.pid,receipts:first.receipts,sdkQueries:offline.sent.length}));return;
 }
 const now=new Date().toISOString();
 db.createUser({id:actor.accountId,username:actor.accountId,password_hash:'synthetic-only',display_name:'Synthetic',role:'member',status:'active',must_change_password:false,created_at:now,updated_at:now});
 await import('../src/web.js');
 const {createOwnedRoleProfile}=await import('../src/routes/agent-profiles.js');
 const {createOwnedRoleWorkspace}=await import('../src/routes/groups.js');
 const native={...db,createOwnedRoleProfile,createOwnedRoleWorkspace,listAvailableSkills:async()=>[]};
 setWebDeps({getRegisteredGroups:()=>({}),ensureTerminalContainerStarted:()=>false} as any);
 const rolePort=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate,native,templates:[{key:'marketing',name:'合成内容岗位',skills:[],payload:{name:'合成内容岗位',prompt_schema_version:2}}],prepareOwnProfiles,journalDirectory:path.join(DATA_DIR,'role-journal'),readActor:async()=>({...actor,role:'marketing'})});
 const prepared=await rolePort.prepareRoleWorkspace({actor:{...actor,role:'marketing'},scope:scope(),idempotencyKey:roleKey,assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work()});
 expect(prepared.state).toBe('ready');if(prepared.state!=='ready')throw Error('not_ready');
 let nextOutcome:'success'|'error'|'wrong'|'wrong-interrupt'='success',leaveRunning=false;const captures:any[]=[];const denied=new Set<string>();let release:(interrupted?:boolean)=>void=()=>{};
 const grants=new WorkbenchAccessStore(path.join(DATA_DIR,'conversation-grants.sqlite'));
 const actors=new Map([[actor.accountId,actor]]);
 const host=await import('../src/index.js');
 const execution=host.initializeIsolatedConversationExecution({mode:'isolated-synthetic',authorize:receipt=>{if(!receipt)return false;try{receipt.actor.accountId='mutation-attempt';}catch{} const grant=grants.get(receipt.actor.accountId);return !!grant?.active&&grant.version===receipt.actor.grantVersion&&grant.storeId===receipt.actor.storeId&&grant.roles.includes(receipt.role)&&!denied.has(receipt.receiptId)&&Object.entries(actors.get(receipt.actor.accountId)??{}).length>0&&Object.entries(actors.get(receipt.actor.accountId)!).every(([key,value])=>(receipt.actor as any)[key]===value);},runner:async(group,input,onProcess,onOutput)=>{
  const outcome=nextOutcome;nextOutcome='success';captures.push(structuredClone(input));onProcess({pid:0} as any,'synthetic-runner',null);
  const interrupted=await new Promise<boolean>(resolve=>{release=(value=false)=>resolve(value);});
  if(interrupted){fs.rmSync(path.join(DATA_DIR,'ipc',group.folder,'input','_interrupt'),{force:true});}
  if(interrupted)await onOutput?.({status:'stream',result:null,streamEvent:{eventType:'status',statusText:'interrupted',turnId:input.turnId}} as any);
  if(outcome==='wrong-interrupt')await onOutput?.({status:'stream',result:null,streamEvent:{eventType:'status',statusText:'interrupted',turnId:'foreign-turn'}} as any);
  if(outcome==='error')return {status:'error',result:null,error:'synthetic-runner-failure'};
  const output={status:'success' as const,result:'合成执行结果',inputTurnCompleted:true,inputTurnId:outcome==='wrong'?'wrong-turn':input.turnId,turnId:input.turnId,newSessionId:input.sessionId??'synthetic-session-'+captures.length};
  await onOutput?.(output);return output;
 }});
 const port=createBotConversationNativePort({mode:'isolated-synthetic',gate,native,readActor,execution});
 const ledger=new ManagerStore(path.join(DATA_DIR,'conversation-facts.sqlite'));const tasks=new BotTaskStore(path.join(DATA_DIR,'conversation-facts.sqlite'));
 grants.change('admin',{accountId:actor.accountId,storeId:actor.storeId,roles:['marketing'],active:true,expectedVersion:0,requestKey:'synthetic-grant'});
 const offline=offlineBotSdk(),adapter=createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client});
 const assembly=createWecomBotAssembly({mode:'isolated-synthetic',client:offline.client,botId:actor.botId,corpId:actor.corpId,
 identity:{tenantId:actor.tenantId,stores:[{id:actor.storeId}],roles:['marketing'],store:grants,readBinding:async()=>({botId:actor.botId,corpId:actor.corpId,memberId:actor.memberId,accountId:actor.accountId,active:true,version:1}),readNative:async()=>({user:{id:actor.accountId,role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-'+actor.accountId})},
 businesses:[{scope:{tenant:actor.tenantId,store:actor.storeId,workspace:'web:original'},employees:[{accountId:actor.accountId,employeeId:'synthetic-employee',employeeName:'合成员工'}],ledger,conversations:{store:tasks,native:rolePort,intake:port}}],sender:{sdk:adapter}});
 const send=async(id:string,text:string)=>{offline.frame({cmd:'aibot_msg_callback',headers:{req_id:id},body:{msgid:id,aibotid:actor.botId,msgtype:'text',chattype:'single',create_time:1792458000,from:{userid:actor.memberId,corpid:actor.corpId},text:{content:text}}});await assembly.idle();};
 const get=async(id:string)=>port.readReceipt(request(undefined,{receiptId:hash([actor.corpId,actor.botId,actor.memberId,id])}));
 const until=async(predicate:()=>boolean)=>{for(let n=0;n<200&&!predicate();n++)await new Promise(resolve=>setTimeout(resolve,10));expect(predicate()).toBe(true);};
 try{
  offline.authenticate();await send('select','岗位 内容营销');
  await send('first','第一条合成需求');await until(()=>captures.length===1);
  const first=await get('first');expect(first.execution).toMatchObject({state:'running',queryId:captures[0].queryRunId,turnId:captures[0].turnId});
  expect(captures[0].prompt).toContain('第一条合成需求');expect(captures[0].sessionId).toBeUndefined();
  await send('second','后续合成需求');expect((await get('second')).execution.state).toBe('queued');expect(captures).toHaveLength(1);
  await send('cancel-queued','取消对话 '+(await get('second')).receiptId);expect((await get('second')).execution.state).toBe('cancelled');
  await send('third','保留的连续需求');release();await until(()=>captures.length===2);
  expect(captures[1].sessionId).toBe('synthetic-session-1');expect(captures[1].prompt).toContain('保留的连续需求');expect(captures[1].prompt).not.toContain('后续合成需求');
  expect((await get('first')).execution.state).toBe('completed');
  const third=await get('third');await send('cancel-active','取消对话 '+third.receiptId);
  expect((await get('third')).execution.state).toBe('cancelling');
  await send('query-active','查询对话 '+third.receiptId);expect(JSON.stringify(offline.sent.at(-1))).toContain('取消处理中');
  const group=db.getRegisteredGroup(prepared.workspaceJid)!;
  expect(fs.existsSync(path.join(DATA_DIR,'ipc',group.folder,'input','_interrupt'))).toBe(true);
  db.storeMessageDirect('synthetic-web-input',prepared.workspaceJid,actor.accountId,'Web','混合Web需求',new Date().toISOString(),false);
  await send('fourth','混合岗位需求');
  release(true);await until(()=>captures.length===3);
  expect((await get('third')).execution.state).toBe('cancelled');
  const fourth=await get('fourth');expect(fourth.execution.batchSize).toBe(2);
  expect(captures[2].prompt).toContain('混合Web需求');expect(captures[2].prompt).toContain('混合岗位需求');
  expect(captures[2].sessionId).toBeUndefined();
  await send('late-cancel','取消对话 '+first.receiptId);expect((await get('first')).execution.state).toBe('completed');
  expect((await get('fourth')).execution.state).toBe('running');
  expect(fs.existsSync(path.join(DATA_DIR,'ipc',group.folder,'input','_interrupt'))).toBe(false);
  await send('first','第一条合成需求');expect(captures).toHaveLength(3);
  release();await until(()=>db.readConversationExecution(fourth.receiptId)?.state==='completed');
  denied.add(first.receiptId);denied.add(fourth.receiptId);
  await send('fifth','清理历史后的新需求');await until(()=>captures.length===4);
  expect(captures[3].sessionId).toBeUndefined();expect(captures[3].prompt).not.toContain('第一条合成需求');expect(captures[3].prompt).not.toContain('混合Web需求');expect(captures[3].prompt).not.toContain('合成执行结果');
  release();await until(()=>db.readConversationExecution((hash([actor.corpId,actor.botId,actor.memberId,'fifth'])))?.state==='completed');
  await until(()=>!execution.queue.hasDirectActiveRunner(prepared.workspaceJid));
  const snapshotFile=path.join(DATA_DIR,'ipc',group.folder,'current_tasks.json');
  fs.unlinkSync(snapshotFile);fs.mkdirSync(snapshotFile);
  await send('snapshot-failed','合成快照写入失败');await until(()=>!execution.queue.hasDirectActiveRunner(prepared.workspaceJid));
  expect(captures).toHaveLength(4);
  expect(db.readConversationExecution(hash([actor.corpId,actor.botId,actor.memberId,'snapshot-failed']))?.state).toBe('unknown');
  fs.rmdirSync(snapshotFile);
  nextOutcome='error';await send('failed','合成失败需求');await until(()=>captures.length===5);release();
  await until(()=>db.readConversationExecution(hash([actor.corpId,actor.botId,actor.memberId,'failed']))?.state==='failed');
  await until(()=>!execution.queue.hasDirectActiveRunner(prepared.workspaceJid));
  nextOutcome='wrong';await send('wrong','合成错误turn需求');await until(()=>captures.length===6);release();
  await until(()=>db.readConversationExecution(hash([actor.corpId,actor.botId,actor.memberId,'wrong']))?.state==='unknown');
  await until(()=>!execution.queue.hasDirectActiveRunner(prepared.workspaceJid));
  nextOutcome='wrong-interrupt';await send('wrong-interrupt','合成错误中断turn需求');await until(()=>captures.length===7);release();
  await until(()=>!execution.queue.hasDirectActiveRunner(prepared.workspaceJid));
  expect(db.readConversationExecution(hash([actor.corpId,actor.botId,actor.memberId,'wrong-interrupt']))?.state).toBe('unknown');
  await send('unfinished','退出进程前仍待终态');await until(()=>captures.length===8);
  await send('cancel-unfinished','取消对话 '+(await get('unfinished')).receiptId);leaveRunning=true;
  expect((await get('unfinished')).execution.state).toBe('cancelling');
  const actor2={...actor,accountId:'synthetic-revoked-owner',memberId:'synthetic-revoked-member'};actors.set(actor2.accountId,actor2);
  db.createUser({id:actor2.accountId,username:actor2.accountId,password_hash:'synthetic',display_name:'Revoked',role:'member',status:'active',must_change_password:false,created_at:now,updated_at:now});
  grants.change('admin',{accountId:actor2.accountId,storeId:actor2.storeId,roles:['marketing'],active:true,expectedVersion:0,requestKey:'second-grant'});
  const rolePort2=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate,native,templates:[{key:'marketing',name:'第二合成岗位',skills:[],payload:{name:'第二合成岗位',prompt_schema_version:2}}],prepareOwnProfiles,journalDirectory:path.join(DATA_DIR,'role-journal2'),readActor:async()=>({...actor2,role:'marketing'})});
  const prepared2=await rolePort2.prepareRoleWorkspace({actor:{...actor2,role:'marketing'},scope:scope(),idempotencyKey:hash([actor2.tenantId,actor2.accountId,actor2.storeId,'marketing']),assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work()});
  expect(prepared2.state).toBe('ready');if(prepared2.state!=='ready')throw Error('second_not_ready');
  const paused=execution.queue.pauseGroupsForMutation([prepared2.workspaceJid]);
  const port2=createBotConversationNativePort({mode:'isolated-synthetic',gate,native,readActor:async()=>({...actor2,grantVersion:grants.get(actor2.accountId)!.version}),execution});
  const revokedId=hash([actor2.corpId,actor2.botId,actor2.memberId,'revoked-origin']);
  await port2.submitMessage(request({workspaceJid:prepared2.workspaceJid,profileId:prepared2.profileId,role:'marketing',selectionId:'second-selection'},{actor:actor2,receiptId:revokedId,originMessageId:'revoked-origin',text:'禁止启动的撤权需求'}));
  expect(db.readConversationExecution(revokedId)?.state).toBe('queued');
  grants.change('admin',{accountId:actor2.accountId,storeId:actor2.storeId,roles:['marketing'],active:false,expectedVersion:1,requestKey:'second-revoke'});
  execution.queue.resumeGroupsAfterMutation(paused);await new Promise(resolve=>setTimeout(resolve,30));
  expect(captures).toHaveLength(8);expect(db.getMessagesSince(prepared2.workspaceJid,{timestamp:'',id:''})).toEqual([]);
  const receipts=await Promise.all(['first','second','third','fourth','fifth','snapshot-failed','failed','wrong','wrong-interrupt','unfinished'].map(get));
  expect(blocked).toEqual([]);
  fs.writeFileSync(marker,JSON.stringify({processId:process.pid,jid:prepared.workspaceJid,receipts}));
  fs.writeFileSync(process.env.QIWE_CONVERSATION_EVIDENCE!,JSON.stringify({phase:'boot',processId:process.pid,captures,receipts}));
 }finally{if(!leaveRunning)release();assembly.close();grants.close();ledger.close();tasks.close();}
});
