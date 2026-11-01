import {afterAll,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as db from '../src/db.js';
import {DATA_DIR} from '../src/config.js';
import {setWebDeps} from '../src/web-context.js';
import {createAppointmentBootGate} from '../src/appointment-boot-gate.js';
import {prepareOwnProfiles} from '../test-support/workbench-opening.mjs';
import {createRoleWorkspaceNativePort} from '../test-support/role-workspace-overlay.mjs';
import {createWecomBotAssembly} from '../test-support/wecom-bot-assembly.mjs';
import {createBotSdkAdapter} from '../test-support/wecom-bot-sdk.mjs';
import {WorkbenchAccessStore} from '../test-support/workbench-access.mjs';
import {ManagerStore} from '../test-support/manager-store.mjs';
import {BotTaskStore} from '../test-support/wecom-bot-task-store.mjs';
import {offlineBotSdk} from '../test-support/offline-bot-sdk.mjs';

const ownerId='synthetic-role-owner',actor={tenantId:'synthetic-tenant',accountId:ownerId,storeId:'synthetic-store',role:'marketing',grantVersion:1,corpId:'synthetic-corp',botId:'synthetic-bot',memberId:'synthetic-member',bindingVersion:1};
const key=createHash('sha256').update(JSON.stringify([actor.tenantId,actor.accountId,actor.storeId,actor.role])).digest('hex');
const request=(currentActor=actor,currentKey=key)=>({actor:currentActor,
 scope:{signal:new AbortController().signal,deadline:performance.now()+20000,correlationId:'synthetic-role-request'},
 idempotencyKey:currentKey,assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work()});
let initialized=false;
const blocked:string[]=[];
vi.spyOn(net.Socket.prototype,'connect').mockImplementation((()=>{blocked.push('tcp');throw Error('ROLE_TEST_NETWORK_FORBIDDEN');}) as any);
vi.spyOn(net.Server.prototype,'listen').mockImplementation((()=>{blocked.push('listen');throw Error('ROLE_TEST_LISTEN_FORBIDDEN');}) as any);
for(const name of Object.keys(dns).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'||name==='lookup'))vi.spyOn(dns,name as any).mockImplementation((()=>{blocked.push('dns:'+name);throw Error('ROLE_TEST_DNS_FORBIDDEN');}) as any);
for(const name of Object.keys(dns.promises).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'||name==='lookup'))vi.spyOn(dns.promises,name as any).mockImplementation((()=>{blocked.push('dns:'+name);throw Error('ROLE_TEST_DNS_FORBIDDEN');}) as any);
for(const name of ['send','connect','bind'] as const)vi.spyOn(dgram.Socket.prototype,name as any).mockImplementation((()=>{blocked.push('udp:'+name);throw Error('ROLE_TEST_UDP_FORBIDDEN');}) as any);
for(const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'] as const)vi.spyOn(childProcess,name as any).mockImplementation((()=>{blocked.push('child:'+name);throw Error('ROLE_TEST_CHILD_FORBIDDEN');}) as any);
syncBuiltinESMExports();
it('isolation guards reject external sockets, DNS, UDP, listeners and child processes',()=>{
 for(const target of [{host:'192.0.2.1',port:443},{host:'::1',port:443},{path:'/synthetic-denied.sock'},{path:'\\\\.\\pipe\\synthetic-denied'}])
  expect(()=>new net.Socket().connect(target as any)).toThrow('ROLE_TEST_NETWORK_FORBIDDEN');
 expect(()=>new net.Socket().connect(443,'192.0.2.1')).toThrow('ROLE_TEST_NETWORK_FORBIDDEN');
 for(const target of [{host:'127.0.0.1',port:0},{host:'::1',port:0},'/synthetic-denied.sock','\\\\.\\pipe\\synthetic-denied'])
  expect(()=>net.createServer().listen(target as any)).toThrow('ROLE_TEST_LISTEN_FORBIDDEN');
 expect(()=>net.createServer().listen(0,'127.0.0.1')).toThrow('ROLE_TEST_LISTEN_FORBIDDEN');
 expect(()=>dns.resolve('synthetic.invalid',()=>{})).toThrow('ROLE_TEST_DNS_FORBIDDEN');
 expect(()=>dns.promises.resolve('synthetic.invalid')).toThrow('ROLE_TEST_DNS_FORBIDDEN');
 const udp=dgram.createSocket('udp4');expect(()=>udp.send('x',1234,'192.0.2.1')).toThrow('ROLE_TEST_UDP_FORBIDDEN');
 expect(()=>udp.connect(1234,'192.0.2.1')).toThrow('ROLE_TEST_UDP_FORBIDDEN');
 expect(()=>udp.bind(1234,'127.0.0.1')).toThrow('ROLE_TEST_UDP_FORBIDDEN');udp.close();
 expect(()=>childProcess.spawn('synthetic')).toThrow('ROLE_TEST_CHILD_FORBIDDEN');
 expect(()=>childProcess.spawnSync('synthetic')).toThrow('ROLE_TEST_CHILD_FORBIDDEN');
 expect(blocked).toEqual(['tcp','tcp','tcp','tcp','tcp','listen','listen','listen','listen','listen','dns:resolve','dns:resolve','udp:send','udp:connect','udp:bind','child:spawn','child:spawnSync']);blocked.length=0;
});
afterAll(()=>{
 if(initialized)db.closeDatabase();
 vi.restoreAllMocks();syncBuiltinESMExports();
 const root=fs.realpathSync(process.cwd()),data=path.resolve(DATA_DIR);
 if(path.dirname(data)!==root||path.basename(data)!=='data')throw Error('ROLE_TEST_UNSAFE_CLEANUP');
 if(fs.existsSync(data))fs.rmSync(data,{recursive:true,force:true});
});

it('original owner Profile and group services publish once; lost response reads the committed provenance',async()=>{
 await import('../src/web.js');
 const {createOwnedRoleProfile}=await import('../src/routes/agent-profiles.js');
 const {createOwnedRoleWorkspace}=await import('../src/routes/groups.js');
 db.initDatabase();initialized=true;
 const now=new Date().toISOString();
 db.createUser({id:ownerId,username:ownerId,password_hash:'synthetic-not-a-password',display_name:'Synthetic',role:'member',status:'active',must_change_password:false,created_at:now,updated_at:now});
 const groups:Record<string,unknown>={};let prewarm=0,createCalls=0;
 setWebDeps({getRegisteredGroups:()=>groups,ensureTerminalContainerStarted:()=>{prewarm++;return false;}} as any);
 // This local service fixture does not represent appointment restoration.
 const isolatedServiceGate={isPaused:()=>false,beginWrite:()=>Symbol('isolated-service-write'),finishWrite:()=>{}};
 const native={...db,createOwnedRoleProfile,createOwnedRoleWorkspace:async(...args:Parameters<typeof createOwnedRoleWorkspace>)=>{createCalls++;const result=await createOwnedRoleWorkspace(...args);if(result.body&&typeof result.body==='object'&&'success' in result.body)throw Error('synthetic_response_lost');return result;},listAvailableSkills:async()=>[]};
 const options={mode:'isolated-synthetic',gate:isolatedServiceGate,native,templates:[{key:'marketing',name:'合成内容岗位',skills:[],payload:{name:'合成内容岗位',prompt_schema_version:2}}],prepareOwnProfiles,journalDirectory:path.join(DATA_DIR,'role-journal'),readActor:async()=>({...actor})};
 const port=createRoleWorkspaceNativePort(options);
 expect(await port.prepareRoleWorkspace(request())).toMatchObject({state:'unknown'});
 const recovered=await port.readRoleWorkspace(request());
 expect(recovered).toMatchObject({state:'ready',ownerAccountId:ownerId,storeId:actor.storeId,role:'marketing'});
 expect(await port.prepareRoleWorkspace(request())).toEqual(recovered);
 expect(createCalls).toBe(1);
 expect(db.getGroupsByOwner(ownerId).filter(group=>!group.is_home)).toHaveLength(1);
 expect(prewarm).toBe(1);
 const claim=db.getOwnedRoleWorkspaceClaim(key);
 expect(claim).toMatchObject({state:'ready',workspaceJid:(recovered as any).workspaceJid,profileId:(recovered as any).profileId});
 const inventory=db.scanAppointmentBootInventory();
 expect(inventory.safe).toBe(false);
 expect(inventory.records.some(record=>record.kind==='execution/router_state')).toBe(true);
 const pausedPort=createRoleWorkspaceNativePort({...options,gate:createAppointmentBootGate('appointment')});
 const writesBefore=db.getGroupsByOwner(ownerId).length;
 const another={...actor,storeId:'synthetic-other-store'},anotherKey=createHash('sha256').update(JSON.stringify([another.tenantId,another.accountId,another.storeId,another.role])).digest('hex');
 expect(await pausedPort.prepareRoleWorkspace(request(another,anotherKey))).toMatchObject({state:'unknown'});
 expect(db.getOwnedRoleWorkspaceClaim(anotherKey)).toBeUndefined();
 expect(db.getGroupsByOwner(ownerId)).toHaveLength(writesBefore);
 const secondActor={...actor,role:'qa'},secondKey=createHash('sha256').update(JSON.stringify([secondActor.tenantId,secondActor.accountId,secondActor.storeId,secondActor.role])).digest('hex');
 const secondPort=createRoleWorkspaceNativePort({...options,templates:[{key:'qa',name:'合成质检岗位',skills:[],payload:{name:'合成质检岗位',prompt_schema_version:2}}],readActor:async()=>({...secondActor})});
 expect(await secondPort.prepareRoleWorkspace(request(secondActor,secondKey))).toMatchObject({state:'unknown'}); // Lost HTTP response, committed original publication.
 expect(await secondPort.readRoleWorkspace(request(secondActor,secondKey))).toMatchObject({state:'ready',ownerAccountId:ownerId,role:'qa'});
 expect(createCalls).toBe(2);
 const readySecond=db.getOwnedRoleWorkspaceClaim(secondKey);expect(readySecond).toMatchObject({state:'ready'});
 const legacyJid='web:synthetic-legacy-unbound';
 db.setRegisteredGroup(legacyJid,{...db.getRegisteredGroup(readySecond!.workspaceJid!)!,name:'Legacy unbound',folder:'synthetic-legacy-unbound'});
 const thirdActor={...actor,role:'training'},thirdKey=createHash('sha256').update(JSON.stringify([thirdActor.tenantId,thirdActor.accountId,thirdActor.storeId,thirdActor.role])).digest('hex');
 const thirdPort=createRoleWorkspaceNativePort({...options,templates:[{key:'training',name:'合成培训岗位',skills:[],payload:{name:'合成培训岗位',prompt_schema_version:2}}],readActor:async()=>({...thirdActor})});
 expect(await thirdPort.prepareRoleWorkspace(request(thirdActor,thirdKey))).toMatchObject({state:'unknown'});
 expect(db.getOwnedRoleWorkspaceClaim(thirdKey)).toBeUndefined();expect(createCalls).toBe(2);
 expect(blocked).toEqual([]);
});

it('one offline SDK selection runs Q authority and assembly through the original Native services into a durable reply',async()=>{
 const combo={...actor,accountId:'synthetic-combo-owner',memberId:'synthetic-combo-member'};
 const now=new Date().toISOString();
 db.createUser({id:combo.accountId,username:combo.accountId,password_hash:'synthetic-not-a-password',display_name:'Synthetic Combo',role:'member',status:'active',must_change_password:false,created_at:now,updated_at:now});
 const {createOwnedRoleProfile}=await import('../src/routes/agent-profiles.js');
 const {createOwnedRoleWorkspace}=await import('../src/routes/groups.js');
 const groups:Record<string,unknown>={};let originalCreates=0;
 setWebDeps({getRegisteredGroups:()=>groups,ensureTerminalContainerStarted:()=>false} as any);
 const native={...db,createOwnedRoleProfile,createOwnedRoleWorkspace:async(...args:Parameters<typeof createOwnedRoleWorkspace>)=>{originalCreates++;return createOwnedRoleWorkspace(...args);},listAvailableSkills:async()=>[]};
 const gate={isPaused:()=>false,beginWrite:()=>Symbol('isolated-service-write'),finishWrite:()=>{}};
 const port=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate,native,templates:[{key:'marketing',name:'合成内容岗位',skills:[],payload:{name:'合成内容岗位',prompt_schema_version:2}}],prepareOwnProfiles,journalDirectory:path.join(DATA_DIR,'role-journal'),readActor:async()=>({...combo})});
 const grants=new WorkbenchAccessStore(path.join(DATA_DIR,'combo-grants.sqlite'));
 const ledger=new ManagerStore(path.join(DATA_DIR,'combo-facts.sqlite'));
 const tasks=new BotTaskStore(path.join(DATA_DIR,'combo-facts.sqlite'));
 const offline=offlineBotSdk(),adapter=createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client});
 const outcomes:any[]=[];
 try{
  grants.change('admin',{accountId:combo.accountId,storeId:combo.storeId,roles:['marketing'],active:true,expectedVersion:0,requestKey:'synthetic-combo-grant'});
  const assembly=createWecomBotAssembly({mode:'isolated-synthetic',client:offline.client,botId:combo.botId,corpId:combo.corpId,
   identity:{tenantId:combo.tenantId,stores:[{id:combo.storeId}],roles:['marketing'],store:grants,
    readBinding:async()=>({botId:combo.botId,corpId:combo.corpId,memberId:combo.memberId,accountId:combo.accountId,active:true,version:1}),
    readNative:async()=>({user:{id:combo.accountId,role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-'+combo.accountId})},
   businesses:[{scope:{tenant:combo.tenantId,store:combo.storeId,workspace:'web:original'},employees:[{accountId:combo.accountId,employeeId:'synthetic-employee',employeeName:'合成员工'}],ledger,conversations:{store:tasks,native:port}}],
   sender:{sdk:adapter},onOutcome:(outcome:any)=>outcomes.push(outcome)});
  try{
   offline.authenticate();
   offline.frame({cmd:'aibot_msg_callback',headers:{req_id:'synthetic-combo-request'},body:{msgid:'synthetic-combo-message',aibotid:combo.botId,msgtype:'text',chattype:'single',create_time:1792458000,from:{userid:combo.memberId,corpid:combo.corpId},text:{content:'岗位 内容营销'}}});
   await assembly.idle();
   const {role:_role,...conversationActor}=combo;
   const selected=tasks.currentConversation(conversationActor);
   expect(selected).toMatchObject({state:'ready',role:'marketing',actor:{accountId:combo.accountId,storeId:combo.storeId}});
   expect(selected?.workspaceJid).toMatch(/^web:(?!home)/);
   expect(db.getOwnedRoleWorkspaceClaim(createHash('sha256').update(JSON.stringify([combo.tenantId,combo.accountId,combo.storeId,combo.role])).digest('hex'))).toMatchObject({state:'ready',workspaceJid:selected?.workspaceJid,profileId:selected?.profileId});
   expect(originalCreates).toBe(1);
   expect(JSON.stringify(offline.sent.at(-1)?.body)).toContain('已选择内容营销岗位对话');
   expect(outcomes.at(-1)?.state).toBe('handled');
   expect(blocked).toEqual([]);
  }finally{assembly.close();}
 }finally{adapter.close();tasks.close();ledger.close();grants.close();}
});
