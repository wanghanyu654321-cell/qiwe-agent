import Database from '../src/sqlite-compat.js';
import {createHash} from 'node:crypto';
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
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {afterAll,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {ModelRuntime} from '../runner/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {PiRuntimeAdapter} from '../runner/src/runtime/pi/pi-runtime.js';
import {adaptClaudeMcpToolsToPi} from '../runner/src/runtime/pi/pi-tools.js';
import {createMcpTools} from '../runner/src/mcp-tools.js';
afterAll(()=>{db.closeDatabase();vi.restoreAllMocks();syncBuiltinESMExports();});

const blocked:string[]=[];
vi.spyOn(net.Socket.prototype,'connect').mockImplementation((()=>{blocked.push('tcp');throw Error('CONVERSATION_NETWORK_FORBIDDEN');}) as any);
vi.spyOn(net.Server.prototype,'listen').mockImplementation((()=>{blocked.push('listen');throw Error('CONVERSATION_LISTEN_FORBIDDEN');}) as any);
for(const name of Object.keys(dns).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'||name==='lookup'))vi.spyOn(dns,name as any).mockImplementation((()=>{blocked.push('dns');throw Error('CONVERSATION_DNS_FORBIDDEN');}) as any);
for(const name of Object.keys(dns.promises).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'||name==='lookup'))vi.spyOn(dns.promises,name as any).mockImplementation((()=>{blocked.push('dns');throw Error('CONVERSATION_DNS_FORBIDDEN');}) as any);
for(const name of ['send','connect','bind'] as const)vi.spyOn(dgram.Socket.prototype,name as any).mockImplementation((()=>{blocked.push('udp');throw Error('CONVERSATION_UDP_FORBIDDEN');}) as any);
for(const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'] as const)vi.spyOn(childProcess,name as any).mockImplementation((()=>{blocked.push('child');throw Error('CONVERSATION_CHILD_FORBIDDEN');}) as any);
syncBuiltinESMExports();

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


it.each([
 {kind:'returned MCP error',name:'mcp__miniclaw__workspace_memory_search',args:{query:'synthetic'},error:'ENOTDIR'},
 {kind:'invalid arguments before original handler',name:'mcp__miniclaw__workspace_memory_search',args:{query:7},error:'string'},
 {kind:'missing source file',name:'read',args:{path:'missing.txt'},error:'ENOENT'},
])('$kind remains an SDK tool error, never a successful observation',async scenario=>{
 const root=fs.mkdtempSync(path.resolve('synthetic-error-'));
 const ipc=path.join(root,'ipc-file');fs.writeFileSync(ipc,'blocks IPC directory creation');
 const tools=adaptClaudeMcpToolsToPi(createMcpTools({chatJid:'web:synthetic',groupFolder:'synthetic',isHome:false,isAdminHome:false,agentBuilderEnabled:false,ownerProfileEnabled:false,workspaceIpc:ipc,workspaceGroup:root}),{namespace:'mcp__miniclaw'});
 const original=ModelRuntime.prototype.streamSimple;
 let calls=0;const observations:any[]=[];
 ModelRuntime.prototype.streamSimple=function(model:any,context:any){
  const content=calls++===0?[{type:'toolCall',id:'synthetic-memory',name:scenario.name,arguments:scenario.args}]:[{type:'text',text:'资料不可用，无法确认。'}];
  observations.push(...context.messages.filter((m:any)=>m.role==='toolResult'));
  const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:content[0].type==='toolCall'?'toolUse':'stop',timestamp:Date.now()};
  return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},result:async()=>message} as any;
 } as any;
 let session:any;
 try {
  session=await new PiRuntimeAdapter().createSession({cwd:root,sessionDir:path.join(root,'sessions'),systemPrompt:'Offline synthetic verification',allowedTools:['read','mcp__miniclaw__workspace_memory_search'],customTools:tools,provider:{apiKey:'synthetic-not-a-secret'},autoCompactEnabled:false});
  const events:any[]=[];session.subscribe((event:any)=>events.push(event));
  await session.prompt({text:'Read synthetic memory evidence.'});
  expect(observations.length).toBeGreaterThan(0);
  expect(observations[0].content[0].text).toContain(scenario.error);
  expect(events.find(event=>event.type==='tool_end'&&event.toolCallId==='synthetic-memory')?.isError).toBe(true);
  expect(observations[0].isError).toBe(true);
  expect(fs.readFileSync(ipc,'utf8')).toBe('blocks IPC directory creation');
  const stored=fs.readdirSync(path.join(root,'sessions')).filter(file=>file.endsWith('.jsonl')).map(file=>fs.readFileSync(path.join(root,'sessions',file),'utf8')).join('');
  expect(stored).toContain('"isError":true');expect(stored).toContain('资料不可用');
 } finally {await session?.dispose();ModelRuntime.prototype.streamSimple=original;}
});

 it('same SDK request reaches original runTurn, actual SDK tools, persistence and lookup',async()=>{
 db.initDatabase();
 const now=new Date().toISOString();
 db.createUser({id:actor.accountId,username:actor.accountId,password_hash:'synthetic-only',display_name:'Synthetic',role:'member',status:'active',must_change_password:false,created_at:now,updated_at:now});
 await import('../src/web.js');
 const {createOwnedRoleProfile}=await import('../src/routes/agent-profiles.js');
 const {createOwnedRoleWorkspace}=await import('../src/routes/groups.js');
 const skillIds=['beauty-local-content','vendor-content-strategy','vendor-copywriting'];
 const managedSkills=path.join(DATA_DIR,'skills',actor.accountId);fs.mkdirSync(managedSkills,{recursive:true});
 for(const id of skillIds)fs.cpSync(path.resolve('skill-sources',id),path.join(managedSkills,id),{recursive:true});
 const native={...db,createOwnedRoleProfile,createOwnedRoleWorkspace,listAvailableSkills:async()=>fs.readdirSync(managedSkills).filter(id=>fs.existsSync(path.join(managedSkills,id,'SKILL.md')))};
 setWebDeps({getRegisteredGroups:()=>({}),ensureTerminalContainerStarted:()=>false} as any);
 const rolePort=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate,native,templates:[{key:'marketing',name:'合成内容岗位',skills:skillIds,payload:{name:'合成内容岗位',prompt_schema_version:2,runtime_policy:{reasoning:{effort:'low'},context:{source:'managed',auto_compact_window:0,auto_compact_percentage:0},skills:{mode:'custom',ids:skillIds,host:{mode:'disabled',ids:[]}},mcp:{mode:'disabled',ids:[]}}}}],prepareOwnProfiles,journalDirectory:path.join(DATA_DIR,'role-journal'),readActor:async()=>({...actor,role:'marketing'})});
 const prepared=await rolePort.prepareRoleWorkspace({actor:{...actor,role:'marketing'},scope:scope(),idempotencyKey:roleKey,assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work()});
 expect(prepared.state).toBe('ready');if(prepared.state!=='ready')throw Error('not_ready');
 const work=path.resolve('synthetic-workspace');fs.mkdirSync(work,{recursive:true});
 fs.writeFileSync(path.join(work,'approved.txt'),'合成方案：每场限额 12 人；来源 synthetic-approved-v1');
 process.env.MINICLAW_WORKSPACE_GROUP=work;process.env.MINICLAW_WORKSPACE_IPC=path.join(work,'ipc');process.env.CLAUDE_CONFIG_DIR=path.join(work,'config');
 fs.mkdirSync(path.join(process.env.MINICLAW_WORKSPACE_IPC,'input'),{recursive:true});
 fs.writeFileSync(path.join(process.env.MINICLAW_WORKSPACE_IPC,'tasks'),'synthetic unavailable memory RPC transport');
 process.env.ANTHROPIC_API_KEY='synthetic-not-a-secret';
 const {runTurn}=await import('../runner/src/pi-index.js');
 const {resolveAgentProfileUserSkillsPolicy,resolveAgentProfileMcpPolicy}=await import('../src/container-runner.js');
 const modelRequests:any[]=[],captures:any[]=[],outputs:any[]=[];
 const modelSpy=vi.spyOn(ModelRuntime.prototype,'streamSimple').mockImplementation(((model:any,context:any)=>{
  // SDK context.tools retains executable callbacks; capture only evidence data.
  modelRequests.push({systemPrompt:context.systemPrompt,messages:structuredClone(context.messages),offeredTools:context.tools?.map((tool:any)=>tool.name)});
  const results=context.messages.filter((m:any)=>m.role==='toolResult');
  const textOf=(id:string)=>results.find((r:any)=>r.toolCallId===id)?.content.map((p:any)=>p.text??'').join('')??'';
  const material=textOf('read-approved'),strategy=textOf('read-vendor-content-strategy'),copy=textOf('read-vendor-copywriting');
  const fact=material.match(/每场限额 \d+ 人/)?.[0],cta=copy.match(/行动号召为([^。]+)。/)?.[1];
  const available=results.length>0&&!results.some((r:any)=>r.isError)&&!!fact&&!!cta&&strategy.includes('拍摄资源需求');
  const draft=available?{topic:`项目体验介绍：${fact}`,filming:'展示已审服务步骤；拍摄资源需求待员工补充。',copy:`了解项目体验。${fact}。${cta}。`,methods:[{source:'vendor-content-strategy/SKILL.md',method:'主题对应到可展示的服务步骤'},{source:'vendor-copywriting/SKILL.md',method:'单一行动号召'}],evidence:'synthetic-approved-v1'}:null;
  const content=results.length===0?[
   {type:'toolCall',id:'read-approved',name:'read',arguments:{path:'approved.txt'}},
   ...skillIds.map(id=>({type:'toolCall',id:'read-'+id,name:'read',arguments:{path:path.join(process.env.CLAUDE_CONFIG_DIR!,'skills',id,'SKILL.md')}})),
   {type:'toolCall',id:'channel-context',name:'mcp__miniclaw__get_channel_context',arguments:{}},
  ]:[{type:'text',text:JSON.stringify({status:available?'draft':'partial',executed:false,draft,missing:available?[]:['批准资料或方法来源不可用；无法生成草稿'],channel:results.at(-1).content})}];
  const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:results.length?'stop':'toolUse',timestamp:Date.now()};
  return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
 }) as any);
 const grants=new WorkbenchAccessStore(path.join(DATA_DIR,'d4-grants.sqlite'));
 grants.change('admin',{accountId:actor.accountId,storeId:actor.storeId,roles:['marketing'],active:true,expectedVersion:0,requestKey:'grant'});
 const host=await import('../src/index.js');
 const authorizations:Array<{receiptId:string;allowed:boolean}>=[];
 const execution=host.initializeIsolatedConversationExecution({mode:'isolated-synthetic',authorize:receipt=>{const grant=grants.get(actor.accountId);const allowed=!!receipt&&!!grant?.active&&receipt.actor.accountId===actor.accountId&&receipt.actor.grantVersion===grant.version&&grant.roles.includes(receipt.role);if(receipt)authorizations.push({receiptId:receipt.receiptId,allowed});return allowed;},runner:async(group,input,onProcess,onOutput)=>{
  captures.push(structuredClone(input));
  const policy=resolveAgentProfileUserSkillsPolicy(actor.accountId,input.agentProfile);expect(policy.mountUserSkills).toBe(true);
  expect(input.agentProfile.runtimePolicy.skills.ids).toEqual(skillIds);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!,{recursive:true});const mounted=path.join(process.env.CLAUDE_CONFIG_DIR!,'skills');if(fs.existsSync(mounted)){expect(fs.lstatSync(mounted).isSymbolicLink()).toBe(true);fs.unlinkSync(mounted);}fs.symlinkSync(policy.userSkillsDirOverride!,mounted,process.platform==='win32'?'junction':'dir');
  const onlyCopy=resolveAgentProfileUserSkillsPolicy(actor.accountId,{...input.agentProfile,version:999,runtimePolicy:{...input.agentProfile.runtimePolicy,skills:{mode:'custom',ids:['vendor-copywriting']}}});
  expect(fs.readdirSync(onlyCopy.userSkillsDirOverride!)).toEqual(['vendor-copywriting']);
  expect(()=>resolveAgentProfileUserSkillsPolicy(actor.accountId,{...input.agentProfile,runtimePolicy:{...input.agentProfile.runtimePolicy,skills:{mode:'custom',ids:['missing-synthetic-skill']}}})).toThrow('agent_profile_unavailable');
  expect(resolveAgentProfileUserSkillsPolicy(actor.accountId,{...input.agentProfile,runtimePolicy:{...input.agentProfile.runtimePolicy,skills:{mode:'disabled',ids:[]}}})).toEqual({mountUserSkills:false});
  expect(()=>resolveAgentProfileMcpPolicy({system:{},user:{},restrictedSystemIds:[]},{...input.agentProfile,runtimePolicy:{...input.agentProfile.runtimePolicy,mcp:{mode:'custom',ids:['missing-synthetic-mcp']}}})).toThrow('agent_profile_unavailable');
  const turnOutputs:any[]=[];
  // Match the original stdin serialization boundary: runTurn mutates its DTO.
  const runnerInput=structuredClone(input);
  const stdout=vi.spyOn(console,'log').mockImplementation((value:any)=>{if(typeof value==='string'&&value.startsWith('{'))turnOutputs.push(JSON.parse(value));});
  try{await runTurn(runnerInput,{chatJid:runnerInput.currentSourceJid||runnerInput.chatJid,channelContext:runnerInput.channelContext,groupFolder:runnerInput.groupFolder,isHome:runnerInput.isHome??runnerInput.isMain??false,isAdminHome:runnerInput.isAdminHome??runnerInput.isMain??false,agentBuilderEnabled:runnerInput.agentBuilderEnabled??false,ownerProfileEnabled:runnerInput.miniclawOwnerProfileEnabled===true,interactionMode:runnerInput.interactionMode??'assistant',isScheduledTask:runnerInput.isScheduledTask===true,currentTaskId:runnerInput.messageTaskId??null,currentInputTurnId:runnerInput.turnId,currentSessionId:runnerInput.sessionId??null,workspaceIpc:process.env.MINICLAW_WORKSPACE_IPC!,workspaceGroup:work},runnerInput.prompt,runnerInput.images,[]);}finally{stdout.mockRestore();}
  for(const output of turnOutputs){outputs.push(output);await onOutput?.(output);}
  const final=turnOutputs.findLast((output:any)=>output.status==='success'&&output.inputTurnCompleted);if(!final){console.error('D4_OUTPUT_METADATA',JSON.stringify(turnOutputs.map(output=>({status:output.status,inputTurnCompleted:output.inputTurnCompleted,finalizationReason:output.finalizationReason,error:output.error,eventType:output.streamEvent?.eventType}))));throw Error('D4_ORIGINAL_FINAL_MISSING');}return final;
 }});
 const port=createBotConversationNativePort({mode:'isolated-synthetic',gate,native,readActor,execution});
 const ledger=new ManagerStore(path.join(DATA_DIR,'d4-facts.sqlite')),tasks=new BotTaskStore(path.join(DATA_DIR,'d4-facts.sqlite'));
 const offline=offlineBotSdk(),adapter=createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client});
 const assembly=createWecomBotAssembly({mode:'isolated-synthetic',client:offline.client,botId:actor.botId,corpId:actor.corpId,
 identity:{tenantId:actor.tenantId,stores:[{id:actor.storeId}],roles:['marketing'],store:grants,readBinding:async()=>({botId:actor.botId,corpId:actor.corpId,memberId:actor.memberId,accountId:actor.accountId,active:true,version:1}),readNative:async()=>({user:{id:actor.accountId,role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-'+actor.accountId})},
 businesses:[{scope:{tenant:actor.tenantId,store:actor.storeId,workspace:'web:original'},employees:[{accountId:actor.accountId,employeeId:'synthetic-employee',employeeName:'合成员工'}],ledger,conversations:{store:tasks,native:rolePort,intake:port}}],sender:{sdk:adapter}});
 const send=async(id:string,text:string)=>{offline.frame({cmd:'aibot_msg_callback',headers:{req_id:id},body:{msgid:id,aibotid:actor.botId,msgtype:'text',chattype:'single',from:{userid:actor.memberId,corpid:actor.corpId},text:{content:text}}});await assembly.idle();};
 const id=hash([actor.corpId,actor.botId,actor.memberId,'joint']);
 try{
  offline.authenticate();await send('select','岗位 内容营销');await send('joint','读取批准方案，并给出当前渠道上下文。');
  for(let n=0;n<300&&db.readConversationExecution(id)?.state!=='completed';n++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(db.readConversationExecution(id)).toMatchObject({state:'completed',queryId:captures[0].queryRunId,turnId:captures[0].turnId});
  expect(captures[0].agentProfile.id).toBe(prepared.profileId);
  const result=outputs.findLast(output=>output.result)?.result;
  expect(result).toContain('每场限额 12 人');expect(result).toContain(prepared.workspaceJid);
  expect(modelRequests[0].systemPrompt).toContain('vendor-content-strategy');expect(modelRequests[0].systemPrompt).toContain('vendor-copywriting');
  expect(JSON.parse(result)).toMatchObject({status:'draft',executed:false,draft:{topic:'项目体验介绍：每场限额 12 人',copy:'了解项目体验。每场限额 12 人。咨询核对项目。',methods:[{source:'vendor-content-strategy/SKILL.md'},{source:'vendor-copywriting/SKILL.md'}],evidence:'synthetic-approved-v1'}});
  const observed=modelRequests.at(-1).messages.filter((m:any)=>m.role==='toolResult');
  expect(observed.find((m:any)=>m.toolCallId==='read-vendor-content-strategy').content[0].text).toContain('主题对应到可展示的服务步骤');
  expect(observed.find((m:any)=>m.toolCallId==='read-vendor-copywriting').content[0].text).toContain('单一行动号召');
  expect(observed.find((m:any)=>m.toolCallId==='read-approved').content[0].text).toContain('synthetic-approved-v1');
  expect(modelRequests.at(-1).messages.filter((m:any)=>m.role==='toolResult').map((m:any)=>m.toolName)).toEqual(['read','read','read','read','mcp__miniclaw__get_channel_context']);
  expect(db.getMessagesPage(prepared.workspaceJid).find(message=>message.content===result)).toMatchObject({is_from_me:true});
  await send('lookup','查询对话 '+id);expect(JSON.stringify(offline.sent.at(-1))).toContain('执行已结束');
  for(let n=0;n<200&&execution.queue.hasDirectActiveRunner(prepared.workspaceJid);n++)await new Promise(resolve=>setTimeout(resolve,10));
  await send('wrong-role','岗位 前台办理');expect(captures).toHaveLength(1);
  const revised=db.updateAgentProfile(prepared.profileId,actor.accountId,{identityPrompt:'合成岗位修订：仍只使用已审资料。'});expect(revised?.version).toBe(2);
  await send('revised','修订后重新读取资料');const revisedId=hash([actor.corpId,actor.botId,actor.memberId,'revised']);
  for(let n=0;n<300&&db.readConversationExecution(revisedId)?.state!=='completed';n++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(db.readConversationExecution(revisedId)?.state).toBe('completed');expect(captures).toHaveLength(2);
  expect(captures[1].agentProfile.version).toBe(2);expect(captures[1].sessionId).toBeUndefined();
  expect(db.readConversationExecution(revisedId)?.sessionId).not.toBe(db.readConversationExecution(id)?.sessionId);
  for(let n=0;n<200&&execution.queue.hasDirectActiveRunner(prepared.workspaceJid);n++)await new Promise(resolve=>setTimeout(resolve,10));
  fs.unlinkSync(path.join(work,'approved.txt'));db.updateAgentProfile(prepared.profileId,actor.accountId,{identityPrompt:'合成岗位第三版：重新核对来源，不沿用旧资料。'});
  await send('missing','来源删除后重新读取资料');const missingId=hash([actor.corpId,actor.botId,actor.memberId,'missing']);
  for(let n=0;n<300&&db.readConversationExecution(missingId)?.state!=='completed';n++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(db.readConversationExecution(missingId)?.state).toBe('completed');expect(captures).toHaveLength(3);
  const partial=outputs.findLast(output=>output.result)?.result;expect(JSON.parse(partial)).toMatchObject({status:'partial',executed:false,draft:null,missing:['批准资料或方法来源不可用；无法生成草稿']});
  expect(db.getMessagesPage(prepared.workspaceJid).find(message=>message.content===partial)).toMatchObject({is_from_me:true});
  for(let n=0;n<200&&execution.queue.hasDirectActiveRunner(prepared.workspaceJid);n++)await new Promise(resolve=>setTimeout(resolve,10));
  const paused=execution.queue.pauseGroupsForMutation([prepared.workspaceJid]);
  await send('revoked','撤权后不得执行');const revokedId=hash([actor.corpId,actor.botId,actor.memberId,'revoked']);
  expect(db.readConversationExecution(revokedId)?.state).toBe('queued');
  const beforeRevocationModelCalls=modelRequests.length;
  grants.change('admin',{accountId:actor.accountId,storeId:actor.storeId,roles:['marketing'],active:false,expectedVersion:1,requestKey:'revoke'});
  execution.queue.resumeGroupsAfterMutation(paused);
  for(let n=0;n<300&&!authorizations.some(entry=>entry.receiptId===revokedId&&!entry.allowed);n++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(authorizations.some(entry=>entry.receiptId===revokedId&&!entry.allowed)).toBe(true);
  expect(captures).toHaveLength(3);
  expect(modelRequests).toHaveLength(beforeRevocationModelCalls);
  expect(blocked).toEqual([]);
  fs.writeFileSync(process.env.QIWE_CONVERSATION_EVIDENCE!,JSON.stringify({processId:process.pid,receipt:db.readConversationExecution(id),revisedReceipt:db.readConversationExecution(revisedId),revokedReceipt:db.readConversationExecution(revokedId),profileId:prepared.profileId,toolNames:['read','mcp__miniclaw__get_channel_context'],result,modelRequests:modelRequests.length,networkCalls:0}));
 }finally{assembly.close();grants.close();ledger.close();tasks.close();modelSpy.mockRestore();}
});
