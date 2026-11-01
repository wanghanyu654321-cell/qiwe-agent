import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createWecomBotPilot} from '../../src/role-eval/wecom-bot-pilot.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
import {offlineBotSdk} from '../fixtures/offline-bot-sdk.js';
import type {BotConversationResult} from '../../src/role-eval/wecom-bot-conversations.js';
const overlay='../../integrations/native/conversation-overlay.mjs';
const {createBotConversationNativePort}=await import(overlay);
const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const actor={tenantId:'t',accountId:'a',storeId:'s',corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1,grantVersion:1};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function setup(config:{early?:boolean;initializeFailure?:boolean;assemblyFailure?:boolean;disconnectFailure?:boolean;timeoutMs?:number}={}){
 const dir=mkdtempSync(join(tmpdir(),'bot-pilot-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const grants=new WorkbenchAccessStore(join(dir,'grants')),ledger=new ManagerStore(join(dir,'facts')),tasks=new BotTaskStore(join(dir,'facts'));
 cleanup.push(()=>grants.close(),()=>ledger.close(),()=>tasks.close());
 grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:true,expectedVersion:0,requestKey:'grant'});
 const offline=offlineBotSdk();offline.lifecycle('disconnected');
 let phase:'paused'|'ready'='paused',arrivals=0,sequence=0;const tickets=new Set<unknown>();
 const gate={phase:()=>phase,isPaused:()=>phase!=='ready',noteArrival:()=>{arrivals++;},beginWrite:()=>{if(phase!=='ready')return null;const ticket={id:String(++sequence)};tickets.add(ticket);return ticket;},finishWrite:(ticket:unknown)=>{tickets.delete(ticket);}};
 let completed:(ids:string[])=>Promise<void>=async()=>{},early:Promise<void>|undefined,boundAuthorize:(receipt:any)=>boolean=()=>false,receiptHook=async()=>{};
 const records=new Map<string,any>(),results=new Map<string,BotConversationResult>(),queued:string[]=[],deliveries:any[]=[],outcomes:any[]=[];
 const queue={close:vi.fn(()=>{throw Error('borrowed_queue_must_not_close');}),idle:vi.fn(()=>{throw Error('completion_must_not_wait_for_runner');})};
 const execution={queue,gate,enqueue:(id:string)=>{queued.push(id);},cancel:()=>{throw Error('unexpected_cancel');}};
 const native={getUserById:()=>({id:'a',role:'member',status:'active',must_change_password:false}),
  getOwnedRoleWorkspaceClaim:()=>({...actor,state:'ready',ownerId:'a',role:'marketing',workspaceJid:'web:marketing',profileId:'profile'}),
  getRegisteredGroup:()=>({created_by:'a',is_home:false,executionMode:'container',folder:'marketing'}),getAgentProfileForUser:()=>({owner_user_id:'a',status:'active'}),getWorkspaceAgentProfileId:()=> 'profile',
  readBotConversationReceipt:(id:string)=>records.get(id),readConversationExecution:(id:string)=>({state:results.has(id)?'completed':'queued'}),
  readConversationResults:(id:string)=>results.has(id)?[results.get(id)]:[],readLatestConversationResult:(id:string)=>results.get(id),
  submitBotConversationMessage:(input:any)=>{const receipt={actor:input.actor,originMessageId:input.originMessageId,textHash:hash(input.text),receiptId:input.receiptId,messageId:'native-input',acceptedAt:'2026-10-24',state:'accepted',...input.target,fingerprint:input.fingerprint};records.set(input.receiptId,receipt);return receipt;}};
 const identity={tenantId:'t',stores:[{id:'s'}],roles:['marketing'] as const,store:grants,
  readBinding:async()=>({botId:'bot',corpId:'corp',memberId:'member',accountId:'a',version:1,active:true}),readNative:async()=>({user:native.getUserById(),workspaceJid:'web:home-a'})};
 const options={mode:'isolated-synthetic' as const,botId:'bot',corpId:'corp',identity,
  readSubject:async()=>({botId:'bot',memberId:'member'}),business:{scope:{tenant:'t',store:config.assemblyFailure?'':'s',workspace:'web:ledger'},employees:[{accountId:'a',employeeId:'employee',employeeName:'员工'}],ledger,store:tasks},
  initializeExecution:vi.fn((input:any)=>{if(config.initializeFailure)throw Error('initialize_failed');completed=input.onCompleted;boundAuthorize=input.authorize;if(config.early)early=completed(['e'.repeat(64)]);return execution;}),
  authorize:(receipt:any)=>!!receipt&&grants.get(receipt.actor.accountId)?.active===true,
  createIntake:(current:any)=>{expect(current).toBe(execution);const port=createBotConversationNativePort({mode:'isolated-synthetic',gate:current.gate,native,readActor:async()=>({...actor}),execution:current});return {...port,readReceipt:async(input:any)=>{await receiptHook();return port.readReceipt(input);}};},
  createRoles:(current:any)=>{expect(current).toBe(gate);return {readRoleWorkspace:async()=>({state:'ready' as const,workspaceJid:'web:marketing',profileId:'profile',ownerAccountId:'a',storeId:'s',role:'marketing' as const}),prepareRoleWorkspace:async()=>{throw Error('unexpected_prepare');}};},
  createClient:()=>offline.client,connect:()=>{},disconnect:()=>{if(config.disconnectFailure)throw Error('disconnect_failed');offline.lifecycle('disconnected');},
  readFingerprint:()=>({botId:'bot',corpId:'corp',ownerId:'a',configVersion:'1',credentialFingerprint:'synthetic',workspaceFingerprint:'synthetic'}),
  timeoutMs:config.timeoutMs??60,onDelivery:(id:string,result:unknown)=>{deliveries.push({id,result});},onOutcome:(outcome:unknown)=>{outcomes.push(outcome);}};
 let pilot:any;const create=()=>{pilot=createWecomBotPilot(options);cleanup.push(()=>pilot.close());return pilot;};
 const request=()=>({signal:new AbortController().signal,deadline:performance.now()+1000,correlationId:'explicit-recover'});
 const send=async(id:string,text:string)=>{offline.frame({cmd:'aibot_msg_callback',headers:{req_id:'request-'+id},body:{msgid:id,aibotid:'bot',msgtype:'text',chattype:'single',create_time:1792458000,from:{userid:'member',corpid:'corp'},text:{content:text}}});await pilot.idle();};
 const activate=async()=>{const preparing=pilot.prepare();offline.authenticate();await preparing;phase='ready';expect(pilot.activate()).toBe(true);};
 const complete=async(id:string)=>{results.set(id,{receiptId:id,revision:1,digest:'b'.repeat(64),queryId:'query',turnId:'turn',sourceOutputIds:['output'],content:'同一条需求的冻结答案'});await completed([id]);};
 return {create,offline,gate,execution,options,grants,ledger,tasks,queued,records,results,deliveries,outcomes,send,activate,complete,request,early:()=>early,completed:(ids:string[])=>completed(ids),ready:()=>{phase='ready';},arrivals:()=>arrivals,tickets:()=>tickets.size,authorize:(receipt:any)=>boundAuthorize(receipt),hook:(fn:()=>Promise<void>)=>{receiptHook=fn;}};
}

it('requires original ready gate, synthetic authentication and explicit activation before entry',async()=>{
 const s=setup(),pilot=s.create();const waiting=pilot.prepare();
 expect(pilot.status()).toBe('connecting');expect(pilot.activate()).toBe(false);
 s.offline.authenticate();await expect(waiting).resolves.toBe('prepared');
 expect(pilot.activate()).toBe(false);expect(s.offline.sent).toEqual([]);expect(s.queued).toEqual([]);
 s.ready();expect(pilot.activate()).toBe(true);await s.send('select','岗位 内容营销');
 expect(s.tasks.currentConversation(actor)).toMatchObject({state:'ready',workspaceJid:'web:marketing'});
 expect(JSON.stringify(s.offline.sent.at(-1))).toContain('已选择');expect(s.options.initializeExecution).toHaveBeenCalledTimes(1);
 expect(s.offline.connect).not.toHaveBeenCalled();
});

it('routes one entry to completion, explicit known-rejection recovery and query without rerunning',async()=>{
 const s=setup(),pilot=s.create();await s.activate();await s.send('select','岗位 内容营销');await s.send('demand','写一条合成文案');
 const id=hash(['corp','bot','member','demand']);expect(s.queued).toEqual([id]);expect(s.records.get(id)).toMatchObject({actor,role:'marketing',workspaceJid:'web:marketing'});
 s.offline.setAcknowledge(async frame=>({headers:frame.headers,errcode:40001}));await s.complete(id);
 expect(s.deliveries).toMatchObject([{id,result:{deliveries:[{state:'rejected'}]}}]);
 await pilot.recover(s.request(),id);expect(s.offline.sent.filter(frame=>frame.cmd==='aibot_send_msg')).toHaveLength(1);
 s.offline.setAcknowledge(undefined);expect((await pilot.recover(s.request(),id,{retryRejected:true})).deliveries).toMatchObject([{state:'accepted',attempt:2}]);
 await pilot.recover(s.request(),id,{retryRejected:true});expect(s.offline.sent.filter(frame=>frame.cmd==='aibot_send_msg')).toHaveLength(2);
 for(const frame of s.offline.sent.filter(frame=>frame.cmd==='aibot_send_msg'))expect(frame.body).toMatchObject({chatid:'member',chat_type:1,msgtype:'markdown'});
 const before=structuredClone(s.results.get(id));await s.send('query','查询对话 '+id);
 expect(JSON.stringify(s.offline.sent.at(-1))).toContain('同一条需求的冻结答案');expect(s.results.get(id)).toEqual(before);expect(s.queued).toEqual([id]);
});

it('defers setup and late completions without buffering, new sends or touching the host queue',async()=>{
 const s=setup({early:true}),pilot=s.create();await s.early();
 expect(s.deliveries).toMatchObject([{id:'e'.repeat(64),result:{deferred:true}}]);expect(s.offline.sent).toEqual([]);
 await s.activate();await pilot.idle();expect(s.offline.sent).toEqual([]);
 await pilot.close();await pilot.close();const count=s.deliveries.length;await s.completed(['e'.repeat(64)]);
 expect(s.deliveries).toHaveLength(count+1);expect(s.deliveries.at(-1).result).toMatchObject({deferred:true});expect(s.offline.sent).toEqual([]);
 expect(s.execution.queue.close).not.toHaveBeenCalled();expect(s.execution.queue.idle).not.toHaveBeenCalled();
 expect(s.grants.get('a')?.active).toBe(true);expect(s.tasks.currentConversation(actor)).toBeUndefined();
 expect(s.offline.client.listenerCount('message')).toBe(0);expect(s.offline.client.listenerCount('authenticated')).toBe(0);expect(s.offline.client.listenerCount('error')).toBe(1);
});

it('captures startup callbacks and config while original live grants still revoke entry and completion',async()=>{
 const s=setup(),pilot=s.create();s.options.connect=()=>{throw Error('mutated_connect');};
 s.options.readSubject=async()=>({botId:'bot',memberId:'intruder'});s.options.identity.readBinding=async()=>{throw Error('mutated_binding');};
 s.options.createIntake=()=>{throw Error('mutated_factory');};s.options.authorize=()=>true;s.options.onDelivery=()=>{throw Error('mutated_observer');};
 s.options.business.scope.store='foreign';s.options.business.employees[0]!.accountId='foreign';
 await s.activate();await s.send('select','岗位 内容营销');await s.send('demand','合成请求');
 const id=hash(['corp','bot','member','demand']);await s.complete(id);expect(s.deliveries.at(-1).result.deliveries[0].state).toBe('accepted');
 expect(s.authorize({actor,role:'marketing'})).toBe(true);
 s.grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:false,expectedVersion:1,requestKey:'revoke'});
 expect(s.authorize({actor,role:'marketing'})).toBe(false);const sent=s.offline.sent.length;
 await s.send('denied','岗位 内容营销');await expect(s.completed([id])).rejects.toThrow('access_denied');expect(s.offline.sent).toHaveLength(sent);expect(s.outcomes.at(-1)).toMatchObject({state:'rejected'});
 expect(s.deliveries.at(-1).result).toMatchObject({deferred:true,detail:'delivery_failed'});
 expect(s.results.get(id)?.content).toBe('同一条需求的冻结答案');
});

it('fences close immediately and reports cleanup_unknown while owned Native reads remain physically pending',async()=>{
 const s=setup({timeoutMs:30}),pilot=s.create();await s.activate();await s.send('select','岗位 内容营销');await s.send('demand','合成请求');
 const id=hash(['corp','bot','member','demand']);let release=()=>{},started=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;});
 s.hook(async()=>{started();await new Promise<void>(resolve=>{release=resolve;});});
 const completing=expect(s.complete(id)).rejects.toThrow('authority_timeout');await entered;const closing=pilot.close();
 expect(pilot.activate()).toBe(false);await expect(pilot.recover(s.request(),id)).rejects.toThrow('pilot_not_active');
 await closing;expect(pilot.status()).toBe('cleanup_unknown');expect(s.offline.sent.filter(frame=>frame.cmd==='aibot_send_msg')).toEqual([]);
 expect(s.tickets()).toBeGreaterThan(0);release();await completing;await pilot.idle();
 expect(s.tickets()).toBe(0);expect(s.results.get(id)?.content).toBe('同一条需求的冻结答案');expect(s.execution.queue.close).not.toHaveBeenCalled();
});

it('preserves the initializer error and cleans partial assembly SDK/context resources',async()=>{
 const init=setup({initializeFailure:true});expect(init.create).toThrow('initialize_failed');expect(init.offline.client.eventNames()).toEqual([]);
 const assembly=setup({assemblyFailure:true});expect(assembly.create).toThrow('invalid_bot_assembly');await Promise.resolve();await Promise.resolve();
 expect(assembly.offline.client.listenerCount('authenticated')).toBe(0);expect(assembly.offline.client.listenerCount('message')).toBe(0);expect(assembly.offline.client.listenerCount('error')).toBe(1);
 expect(assembly.grants.get('a')?.active).toBe(true);expect(assembly.execution.queue.close).not.toHaveBeenCalled();
 await expect(assembly.completed(['e'.repeat(64)])).resolves.toBeUndefined();expect(assembly.offline.sent).toEqual([]);
});

it('keeps disconnect failure observable and rejects input before activation without business effects',async()=>{
 const failed=setup({disconnectFailure:true}),pilot=failed.create();await failed.activate();await pilot.close();expect(pilot.status()).toBe('cleanup_unknown');
 const early=setup(),unactivated=early.create();const preparing=unactivated.prepare();early.offline.authenticate();await preparing;early.ready();
 await early.send('not-active','岗位 内容营销');await unactivated.close();expect(early.arrivals()).toBe(1);expect(early.offline.sent).toEqual([]);expect(early.queued).toEqual([]);expect(early.tasks.currentConversation(actor)).toBeUndefined();
});

it.each(['subject','binding','native'] as const)('retains each recovery ticket until its own late %s authority read settles',async kind=>{
 const s=setup({timeoutMs:30});let hold=false,started=()=>{},release=()=>{};
 const entered=new Promise<void>(resolve=>{started=resolve;}),late=new Promise<void>(resolve=>{release=resolve;});
 const wait=async()=>{if(hold){started();await late;}};
 if(kind==='subject'){const read=s.options.readSubject;s.options.readSubject=async()=>{await wait();return read();};}
 if(kind==='binding'){const read=s.options.identity.readBinding;s.options.identity.readBinding=async()=>{await wait();return read();};}
 if(kind==='native'){const read=s.options.identity.readNative;s.options.identity.readNative=async()=>{await wait();return read();};}
 const pilot=s.create();await s.activate();await s.send('select','岗位 内容营销');await s.send('demand','合成请求');
 const id=hash(['corp','bot','member','demand']);await s.complete(id);const sent=s.offline.sent.length;
 hold=true;
 const recovering=expect(pilot.recover({...s.request(),deadline:performance.now()+30},id)).rejects.toThrow('authority_timeout');
 await entered;await recovering;
 try{
  expect(s.tickets()).toBe(1);expect(s.offline.sent).toHaveLength(sent);
  // A distinct recovery must finish its own ticket without waiting for this read.
  hold=false;await pilot.recover(s.request(),id);expect(s.tickets()).toBe(1);
  await pilot.close();expect(pilot.status()).toBe('cleanup_unknown');expect(s.tickets()).toBe(1);
 }finally{release();await pilot.idle();}
 expect(s.tickets()).toBe(0);expect(s.offline.sent).toHaveLength(sent);expect(s.queued).toEqual([id]);
});
