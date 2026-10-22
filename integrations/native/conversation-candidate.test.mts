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

it('original owner DB accepts once; a separate process reads only first-process data',async()=>{
 await import('../src/web.js');
 const {createOwnedRoleProfile}=await import('../src/routes/agent-profiles.js');
 const {createOwnedRoleWorkspace}=await import('../src/routes/groups.js');
 const native={...db,createOwnedRoleProfile,createOwnedRoleWorkspace,listAvailableSkills:async()=>[]};
 const port=createBotConversationNativePort({mode:'isolated-synthetic',gate,native,readActor});
 const marker=path.join(DATA_DIR,'conversation-first.json');
 if(process.env.QIWE_CONVERSATION_PHASE==='restart'){
  db.initDatabase();initialized=true;
  const first=JSON.parse(fs.readFileSync(marker,'utf8'));
  expect(first.processId).not.toBe(process.pid);
  const receipt=await port.readReceipt(request());
  expect(receipt).toEqual(first.receipt);
  const sdkReceipt=await port.readReceipt(request(undefined,{receiptId:first.sdkReceipt.receiptId}));
  expect(sdkReceipt).toEqual(first.sdkReceipt);
  const messages=db.getMessagesSince(receipt!.workspaceJid,{timestamp:'',id:''});
  expect(messages.filter(message=>message.id===receipt!.messageId)).toHaveLength(1);
  expect(messages.filter(message=>message.id===sdkReceipt!.messageId)).toHaveLength(1);
  const grants=new WorkbenchAccessStore(path.join(DATA_DIR,'conversation-grants.sqlite'));
  const ledger=new ManagerStore(path.join(DATA_DIR,'conversation-facts.sqlite'));
  const tasks=new BotTaskStore(path.join(DATA_DIR,'conversation-facts.sqlite'));
  const offline=offlineBotSdk(),adapter=createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client});
  const assembly=createWecomBotAssembly({mode:'isolated-synthetic',client:offline.client,botId:actor.botId,corpId:actor.corpId,
   identity:{tenantId:actor.tenantId,stores:[{id:actor.storeId}],roles:['marketing'],store:grants,
    readBinding:async()=>({botId:actor.botId,corpId:actor.corpId,memberId:actor.memberId,accountId:actor.accountId,active:true,version:1}),
    readNative:async()=>({user:{id:actor.accountId,role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-'+actor.accountId})},
   businesses:[{scope:{tenant:actor.tenantId,store:actor.storeId,workspace:'web:original'},employees:[{accountId:actor.accountId,employeeId:'synthetic-employee',employeeName:'合成员工'}],ledger,conversations:{store:tasks,native:{readRoleWorkspace:async()=>{throw Error('restart_query_must_not_prepare')},prepareRoleWorkspace:async()=>{throw Error('restart_query_must_not_prepare')}},intake:port}}],
   sender:{sdk:adapter}});
  try{
   offline.authenticate();
   const sentBeforeQuery=offline.sent.length;
   offline.frame({cmd:'aibot_msg_callback',headers:{req_id:'synthetic-restart-query'},body:{msgid:'synthetic-restart-query',aibotid:actor.botId,msgtype:'text',chattype:'single',create_time:1792458100,from:{userid:actor.memberId,corpid:actor.corpId},text:{content:'查询对话 '+sdkReceipt!.receiptId}}});
   await assembly.idle();
   expect(offline.sent).toHaveLength(sentBeforeQuery+1);
   expect(offline.sent.at(-1)?.headers.req_id).toBe('synthetic-restart-query');
   const reply=JSON.stringify(offline.sent.at(-1)?.body);
   expect(reply).toContain('已保存需求');expect(reply).toContain(sdkReceipt!.receiptId);
   expect(db.getMessagesSince(receipt!.workspaceJid,{timestamp:'',id:''})).toHaveLength(messages.length);
  }finally{assembly.close();grants.close();ledger.close();tasks.close();}
  expect(blocked).toEqual([]);
  fs.writeFileSync(process.env.QIWE_CONVERSATION_EVIDENCE!,JSON.stringify({phase:'restart',processId:process.pid,receipt,sdkReceipt,messageCount:messages.length,sdkQuery:'original_receipt_returned_without_new_native_input'}));
  return;
 }
 fs.mkdirSync(DATA_DIR,{recursive:true});fs.mkdirSync(STORE_DIR,{recursive:true});
 const dbFile=path.join(STORE_DIR,'messages.db'),legacy=new Database(dbFile);
 legacy.exec('CREATE TABLE router_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 legacy.prepare('INSERT INTO router_state (key,value) VALUES (?,?)').run('schema_version','69');
 legacy.prepare('INSERT INTO router_state (key,value) VALUES (?,?)').run('synthetic-legacy-row','preserved');
 legacy.close();
 const impossibleBackup=path.join(DATA_DIR,'backup-path-is-file');fs.writeFileSync(impossibleBackup,'synthetic-blocker');
 process.env.MINICLAW_MIGRATION_BACKUP_DIR=impossibleBackup;
 expect(()=>db.initDatabase()).toThrow('pre-migration backup failed');
 const unchanged=new Database(dbFile);
 expect(unchanged.prepare('SELECT value FROM router_state WHERE key=?').get('schema_version')).toEqual({value:'69'});
 expect(unchanged.prepare('SELECT value FROM router_state WHERE key=?').get('synthetic-legacy-row')).toEqual({value:'preserved'});
 expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='wecom_conversation_receipts'").get()).toBeUndefined();
 unchanged.close();delete process.env.MINICLAW_MIGRATION_BACKUP_DIR;
 const now=new Date().toISOString();
 db.initDatabase();initialized=true;
 expect(fs.readdirSync(path.join(STORE_DIR,'migration-backups')).some(name=>name.startsWith('messages-v69-to-v70-'))).toBe(true);
 expect(db.getRouterState('synthetic-legacy-row')).toBe('preserved');
 const inventory=db.scanAppointmentBootInventory();
 expect(inventory.safe).toBe(false);
 expect(inventory.blockers).toContain('UNKNOWN_OBJECT');
 const schemaProbe=new Database(dbFile);
 expect(schemaProbe.prepare("SELECT name FROM sqlite_master WHERE name='wecom_conversation_receipts'").get()).toEqual({name:'wecom_conversation_receipts'});
 schemaProbe.close();
 db.createUser({id:actor.accountId,username:actor.accountId,password_hash:'synthetic-not-a-password',display_name:'Synthetic',role:'member',status:'active',must_change_password:false,created_at:now,updated_at:now});
 const groups:Record<string,unknown>={};setWebDeps({getRegisteredGroups:()=>groups,ensureTerminalContainerStarted:()=>false} as any);
 const rolePort=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate,native,templates:[{key:'marketing',name:'合成内容岗位',skills:[],payload:{name:'合成内容岗位',prompt_schema_version:2}}],prepareOwnProfiles,journalDirectory:path.join(DATA_DIR,'role-journal'),readActor:async()=>({...actor,role:'marketing'})});
 const roleInput={actor:{...actor,role:'marketing'},scope:scope(),idempotencyKey:roleKey,assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work()};
 const prepared=await rolePort.prepareRoleWorkspace(roleInput);
 expect(prepared.state).toBe('ready');
 if(prepared.state!=='ready')throw Error('ROLE_NOT_READY');
 const target={workspaceJid:prepared.workspaceJid,profileId:prepared.profileId,role:'marketing',selectionId:'synthetic-selection'};
 const receipt=await port.submitMessage(request(target));
 expect(receipt).toMatchObject({receiptId,state:'accepted',...target});
 const duplicate=await Promise.all([port.submitMessage(request({...target,selectionId:'later-selection'})),port.submitMessage(request(target))]);
 expect(duplicate).toEqual([receipt,receipt]);
 await expect(port.submitMessage(request(target,{text:'changed'}))).rejects.toThrow('CONVERSATION_ORIGIN_CONFLICT');
 await expect(port.readReceipt(request(undefined,{actor:{...actor,grantVersion:2}}))).rejects.toThrow('CONVERSATION_ACTOR_CHANGED');
 await expect(port.readReceipt(request(undefined,{actor:{...actor,storeId:'other-store'}}))).rejects.toThrow('CONVERSATION_ACTOR_CHANGED');
 await expect(port.readReceipt(request(undefined,{actor:{...actor,bindingVersion:2}}))).rejects.toThrow('CONVERSATION_ACTOR_CHANGED');
 await expect(port.readReceipt(request(undefined,{roles:['qa']}))).rejects.toThrow('CONVERSATION_RECEIPT_DENIED');
 await expect(port.submitMessage(request({...target,workspaceJid:'web:wrong'},{receiptId:hash([actor.corpId,actor.botId,actor.memberId,'other']),originMessageId:'other'}))).rejects.toThrow('CONVERSATION_PROVENANCE_INVALID');
 const aborted=new AbortController();aborted.abort();
 await expect(port.submitMessage(request(target,{receiptId:hash([actor.corpId,actor.botId,actor.memberId,'aborted']),originMessageId:'aborted',scope:{...scope(),signal:aborted.signal}}))).rejects.toThrow('CONVERSATION_BUDGET_EXPIRED');
 const paused=createBotConversationNativePort({mode:'isolated-synthetic',gate:{isPaused:()=>true,beginWrite:()=>null,finishWrite:()=>{}},native,readActor});
 await expect(paused.readReceipt(request())).rejects.toThrow('CONVERSATION_MAINTENANCE');
 await expect(paused.submitMessage(request(target))).rejects.toThrow('CONVERSATION_MAINTENANCE');
 const fault=new Database(path.join(STORE_DIR,'messages.db'));
 try{
  fault.exec("CREATE TRIGGER fail_conversation_receipt BEFORE INSERT ON wecom_conversation_receipts BEGIN SELECT RAISE(ABORT, 'synthetic_receipt_failure'); END");
  await expect(port.submitMessage(request(target,{receiptId:hash([actor.corpId,actor.botId,actor.memberId,'rollback']),originMessageId:'rollback',text:'rollback-only'}))).rejects.toThrow('synthetic_receipt_failure');
 }finally{fault.exec('DROP TRIGGER IF EXISTS fail_conversation_receipt');fault.close();}
 expect(await port.readReceipt(request(undefined))).toEqual(receipt);
 const messages=db.getMessagesSince(target.workspaceJid,{timestamp:'',id:''});
 expect(messages.filter(message=>message.id===receipt.messageId)).toMatchObject([{sender:actor.accountId,content:'合成岗位需求'}]);
 expect(db.getMessage(target.workspaceJid,receipt.messageId)).toMatchObject({sender:actor.accountId,is_from_me:0});
 expect(messages.filter(message=>message.id===receipt.messageId)).toHaveLength(1);
 expect(messages.some(message=>message.content==='rollback-only')).toBe(false);
 const tamperId=hash([actor.corpId,actor.botId,actor.memberId,'tamper']);
 const tamper=await port.submitMessage(request(target,{receiptId:tamperId,originMessageId:'tamper',text:'original-only'}));
 db.storeMessageDirect(tamper.messageId,target.workspaceJid,actor.accountId,'Synthetic','overwritten',tamper.acceptedAt,false);
 await expect(port.readReceipt(request(undefined,{receiptId:tamperId}))).rejects.toThrow('CONVERSATION_RECEIPT_MESSAGE_MISMATCH');
 db.storeMessageDirect(tamper.messageId,target.workspaceJid,actor.accountId,'Synthetic','original-only',tamper.acceptedAt,false);
 expect(await port.readReceipt(request(undefined,{receiptId:tamperId}))).toEqual(tamper);
 const lostId=hash([actor.corpId,actor.botId,actor.memberId,'lost']);
 const lostPort=createBotConversationNativePort({mode:'isolated-synthetic',gate,native:{...native,submitBotConversationMessage:(input:any)=>{db.submitBotConversationMessage(input);throw Error('synthetic_response_lost')}},readActor});
 await expect(lostPort.submitMessage(request(target,{receiptId:lostId,originMessageId:'lost',text:'lost-response'}))).rejects.toThrow('synthetic_response_lost');
 const lost=await port.readReceipt(request(undefined,{receiptId:lostId}));
 expect(lost).toMatchObject({receiptId:lostId,state:'accepted',workspaceJid:target.workspaceJid});
 const grants=new WorkbenchAccessStore(path.join(DATA_DIR,'conversation-grants.sqlite'));
 const ledger=new ManagerStore(path.join(DATA_DIR,'conversation-facts.sqlite'));
 const tasks=new BotTaskStore(path.join(DATA_DIR,'conversation-facts.sqlite'));
 const offline=offlineBotSdk(),adapter=createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client});
 grants.change('admin',{accountId:actor.accountId,storeId:actor.storeId,roles:['marketing'],active:true,expectedVersion:0,requestKey:'synthetic-conversation-grant'});
 const assembly=createWecomBotAssembly({mode:'isolated-synthetic',client:offline.client,botId:actor.botId,corpId:actor.corpId,
  identity:{tenantId:actor.tenantId,stores:[{id:actor.storeId}],roles:['marketing'],store:grants,
   readBinding:async()=>({botId:actor.botId,corpId:actor.corpId,memberId:actor.memberId,accountId:actor.accountId,active:true,version:1}),
   readNative:async()=>({user:{id:actor.accountId,role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-'+actor.accountId})},
  businesses:[{scope:{tenant:actor.tenantId,store:actor.storeId,workspace:'web:original'},employees:[{accountId:actor.accountId,employeeId:'synthetic-employee',employeeName:'合成员工'}],ledger,conversations:{store:tasks,native:rolePort,intake:port}}],
  sender:{sdk:adapter}});
 let sdkReceipt:any;
 try{
  offline.authenticate();
  const frame=(msgid:string,text:string)=>({cmd:'aibot_msg_callback',headers:{req_id:'synthetic-'+msgid},body:{msgid,aibotid:actor.botId,msgtype:'text',chattype:'single',create_time:1792458000,from:{userid:actor.memberId,corpid:actor.corpId},text:{content:text}}});
  offline.frame(frame('synthetic-sdk-select','岗位 内容营销'));await assembly.idle();
  expect(tasks.currentConversation(actor)).toMatchObject({state:'ready',workspaceJid:target.workspaceJid,profileId:target.profileId});
  offline.frame(frame('synthetic-sdk-origin','帮我整理这周的内容方向'));await assembly.idle();
  sdkReceipt=await port.readReceipt(request(undefined,{receiptId:hash([actor.corpId,actor.botId,actor.memberId,'synthetic-sdk-origin'])}));
  expect(sdkReceipt).toMatchObject({state:'accepted',workspaceJid:target.workspaceJid,profileId:target.profileId});
  expect(JSON.stringify(offline.sent.at(-1)?.body)).toContain('已保存需求');
  expect(db.getMessagesSince(target.workspaceJid,{timestamp:'',id:''}).filter(message=>message.id===sdkReceipt.messageId)).toMatchObject([{content:'帮我整理这周的内容方向',sender:actor.accountId}]);
  const beforeQuery=db.getMessagesSince(target.workspaceJid,{timestamp:'',id:''}).length;
  const sentBeforeQuery=offline.sent.length;
  offline.frame(frame('synthetic-sdk-query','查询对话 '+sdkReceipt.receiptId));await assembly.idle();
  expect(offline.sent).toHaveLength(sentBeforeQuery+1);
  expect(offline.sent.at(-1)?.headers.req_id).toBe('synthetic-synthetic-sdk-query');
  const queryReply=JSON.stringify(offline.sent.at(-1)?.body);
  expect(queryReply).toContain('已保存需求');expect(queryReply).toContain(sdkReceipt.receiptId);
  expect(db.getMessagesSince(target.workspaceJid,{timestamp:'',id:''})).toHaveLength(beforeQuery);
 }finally{assembly.close();grants.close();ledger.close();tasks.close();}
 expect(blocked).toEqual([]);
 fs.writeFileSync(marker,JSON.stringify({processId:process.pid,receipt,sdkReceipt}));
 fs.writeFileSync(process.env.QIWE_CONVERSATION_EVIDENCE!,JSON.stringify({phase:'boot',processId:process.pid,receipt,sdkReceipt,messageCount:db.getMessagesSince(target.workspaceJid,{timestamp:'',id:''}).length,sdkQuery:'original_receipt_returned_without_new_native_input'}));
});
