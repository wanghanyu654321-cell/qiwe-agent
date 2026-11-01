import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBotConversationDelivery} from '../../src/role-eval/wecom-bot-delivery.js';
import {conversationResultPages,type BotConversationResult} from '../../src/role-eval/wecom-bot-conversations.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotSender} from '../../src/role-eval/wecom-bot-sender.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();});
function setup(content='完整合成答案'){
 const dir=mkdtempSync(join(tmpdir(),'d5-result-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 const ledger=new ManagerStore(join(dir,'facts.sqlite')),grants=new WorkbenchAccessStore(join(dir,'grants.sqlite'));cleanups.push(()=>ledger.close(),()=>grants.close());
 grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:true,expectedVersion:0,requestKey:'grant'});
 const authority=createWecomBotContext({mode:'isolated-synthetic',tenantId:'t',stores:[{id:'s'}],roles:['marketing'],store:grants,botId:'bot',corpId:'corp',readSubject:async()=>({botId:'bot',memberId:'member'}),readBinding:async()=>({botId:'bot',corpId:'corp',memberId:'member',accountId:'a',version:1,active:true}),readNative:async()=>({user:{id:'a',role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-a'})});cleanups.push(()=>authority.close());
 const result:BotConversationResult={receiptId:'a'.repeat(64),revision:1,digest:'b'.repeat(64),queryId:'query',turnId:'turn',sourceOutputIds:['output'],content};
 const receipt={receiptId:result.receiptId,messageId:'input',acceptedAt:'2026-10-22',state:'accepted' as const,role:'marketing' as const,workspaceJid:'web:marketing',profileId:'profile',selectionId:'selection',fingerprint:'c'.repeat(64),execution:{state:'completed' as const}};
 let paused=false,reads=0,code=0,tickets=0,readHook:((input:any)=>unknown)=()=>{},notifyHook=()=>{},resolveAck:((v:unknown)=>void)|undefined;const sent:{member:string;content:string}[]=[];
 const sender=createBotSender({timeoutMs:30,sdk:{mode:'isolated-synthetic',ready:()=>true,reply:async()=>{throw Error('OLD_REQUEST_FORBIDDEN');},sendMessage:async(member,body)=>{sent.push({member,content:body.markdown.content});notifyHook();if(code===-1)return new Promise(r=>{resolveAck=r;});return {headers:{req_id:'fresh-notify'},errcode:code};}}});cleanups.push(()=>sender.close());
 const gate={isPaused:()=>paused,beginWrite:()=>{if(paused)return null;tickets++;return Symbol('ticket');},finishWrite:()=>{tickets--;}};
 const intake={readReceipt:async(input:any)=>{reads++;await readHook(input);return structuredClone(receipt);},submitMessage:async()=>{throw Error('NO_EXECUTION');},readResults:async(input:any)=>input.revision&&input.revision!==result.revision?[]:[structuredClone(result)]};
 const service=createBotConversationDelivery({authority,ledger,sender,intake,gate,scope:{tenant:'t',store:'s',workspace:'web:ledger'},employees:[{accountId:'a',employeeId:'employee',employeeName:'员工'}]});
 const request=()=>({correlationId:'fresh',signal:new AbortController().signal,deadline:performance.now()+1000});
 return {service,ledger,result,receipt,sent,request,grants,gate,reads:()=>reads,pause:()=>{paused=true;},code:(n:number)=>{code=n;},tickets:()=>tickets,hook:(fn:(input:any)=>unknown)=>{readHook=fn;},notifyHook:(fn:()=>void)=>{notifyHook=fn;},late:()=>resolveAck?.({headers:{req_id:'fresh-notify'},errcode:0})};
}
it('recovers durable frozen answer via existing intent/notify for marketing-only employee and suppresses repeats',async()=>{
 const s=setup();const delivered=await s.service.recover(s.request(),s.result.receiptId);expect(delivered.deliveries[0]?.state).toBe('accepted');expect(s.sent).toEqual([{member:'member',content:conversationResultPages(s.result)[0]}]);
 await s.service.recover(s.request(),s.result.receiptId);expect(s.sent).toHaveLength(1);
});
it('retries known rejected only explicitly; suppresses unknown and late ACK without rerunning',async()=>{
 const s=setup();s.code(40001);expect((await s.service.recover(s.request(),s.result.receiptId)).deliveries[0]?.state).toBe('rejected');
 await s.service.recover(s.request(),s.result.receiptId);expect(s.sent).toHaveLength(1);s.code(0);await s.service.recover(s.request(),s.result.receiptId,{retryRejected:true});expect(s.sent).toHaveLength(2);
 const u=setup();u.code(-1);expect((await u.service.recover(u.request(),u.result.receiptId)).deliveries[0]?.state).toBe('unknown');u.late();await u.service.recover(u.request(),u.result.receiptId,{retryRejected:true});expect(u.sent).toHaveLength(1);
});
it('rechecks grant and maintenance after reads and immediately before sending',async()=>{
 const s=setup();s.pause();await expect(s.service.recover(s.request(),s.result.receiptId)).rejects.toThrow();expect(s.reads()).toBe(0);expect(s.sent).toEqual([]);
 const t=setup();t.hook(()=>{t.grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:false,expectedVersion:1,requestKey:'revoke'});});await expect(t.service.recover(t.request(),t.result.receiptId)).rejects.toThrow('access_changed');expect(t.sent).toEqual([]);
});
it('preserves all UTF-8 content across bounded pages, exposes revision and leaves source immutable',()=>{
 const s=setup('甲😀乙'.repeat(7000)),pages=conversationResultPages(s.result);
 expect(pages.length).toBeGreaterThan(1);for(const page of pages){expect(Buffer.byteLength(page)).toBeLessThanOrEqual(16384);expect(page).not.toContain('�');expect(page).toContain('版本1');}
 expect(pages.map(p=>p.slice(p.indexOf('\n',p.indexOf('\n')+1)+1,p.lastIndexOf('\n查回：'))).join('')).toBe(s.result.content);
});

it('keeps private authority input and owns the gate ticket until late preflight actually settles',async()=>{
 const s=setup();let release:()=>void=()=>{},captured:any;
 s.hook(input=>{captured=input;try{input.actor.memberId='foreign';input.roles.push('manager');}catch{}if(s.reads()===2)return new Promise<void>(resolve=>{release=resolve;});});
 const outcome=await s.service.recover(s.request(),s.result.receiptId);expect(outcome.deliveries[0]?.state).toBe('blocked');expect(s.sent).toEqual([]);expect(s.tickets()).toBe(1);expect(captured.actor.memberId).toBe('member');
 release();for(let n=0;n<20&&s.tickets();n++)await new Promise(resolve=>setTimeout(resolve,2));expect(s.tickets()).toBe(0);
});
it('serializes re-entrant recovery and keeps an unknown prior revision when a later frozen result appears',async()=>{
 const s=setup();s.code(-1);await s.service.recover(s.request(),s.result.receiptId);s.late();
 s.result.revision=2;s.result.digest='d'.repeat(64);s.result.content='第二版本完整答案';s.code(0);
 await Promise.all([s.service.recover(s.request(),s.result.receiptId),s.service.recover(s.request(),s.result.receiptId)]);
 expect(s.sent).toHaveLength(2);expect(s.sent[0]?.content).toContain('版本1');expect(s.sent[1]?.content).toContain('版本2');
});

const nativePortModule='../../integrations/native/conversation-overlay.mjs';
const {createBotConversationNativePort}=await import(nativePortModule);
import {createHash} from 'node:crypto';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
import {createBotConversations,type BotConversationIntakePort} from '../../src/role-eval/wecom-bot-conversations.js';
import {createBotDelivery} from '../../src/role-eval/wecom-bot-delivery.js';
function querySetup(){
 const dir=mkdtempSync(join(tmpdir(),'d5-query-preflight-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 const ledger=new ManagerStore(join(dir,'facts')),tasks=new BotTaskStore(join(dir,'tasks')),grants=new WorkbenchAccessStore(join(dir,'grants'));cleanups.push(()=>ledger.close(),()=>tasks.close(),()=>grants.close());
 const actor={tenantId:'t',accountId:'a',storeId:'s',corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1,grantVersion:1};
 const id=createHash('sha256').update(JSON.stringify(['corp','bot','member','original'])).digest('hex'),user={id:'a',role:'member',status:'active',must_change_password:false};
 const receipt={actor,originMessageId:'original',textHash:'c'.repeat(64),receiptId:id,messageId:'input',acceptedAt:'2026-10-23',state:'accepted',role:'marketing',workspaceJid:'web:marketing',profileId:'profile',selectionId:'selection',fingerprint:'c'.repeat(64)};
 const result={receiptId:id,revision:1,digest:'d'.repeat(64),queryId:'query',turnId:'turn',sourceOutputIds:['out'],content:'PRIVATE ORIGINAL ROLE ANSWER'};
 const execution:any={state:'completed',queryId:'query',turnId:'turn'};
 let archived=false,remapped=false,paused=false,hasResult=true,tickets=0,reads=0,cancels=0,command='查询对话 '+id,readyHook=()=>{},actorHook:()=>Promise<void>=async()=>{};const sent:string[]=[],readVersions:number[]=[];
 const gate={isPaused:()=>paused,beginWrite:()=>{if(paused)return null;tickets++;return Symbol('original-gate');},finishWrite:()=>{tickets--;}};
 const native={readBotConversationReceipt:()=>receipt,submitBotConversationMessage:()=>{throw Error('NO_EXECUTION');},readConversationExecution:()=>({...execution}),getUserById:()=>user,getOwnedRoleWorkspaceClaim:()=>({...actor,state:'ready',ownerId:'a',role:'marketing',workspaceJid:remapped?'web:other':'web:marketing',profileId:'profile'}),getRegisteredGroup:()=>({created_by:'a',is_home:false,executionMode:'container',folder:'role'}),getAgentProfileForUser:()=>({owner_user_id:'a',status:archived?'archived':'active'}),getWorkspaceAgentProfileId:()=> 'profile',readConversationResults:(_id:string,afterRevision:number)=>{reads++;readVersions.push(afterRevision+1);return hasResult?[result]:[];},readLatestConversationResult:()=>{reads++;return hasResult?result:undefined;}};
 const intake:BotConversationIntakePort=createBotConversationNativePort({mode:'isolated-synthetic',gate,native,readActor:async()=>{await actorHook();return actor;},execution:{enqueue:()=>{throw Error('NO_EXECUTION');},cancel:()=>{cancels++;throw Error('NO_CANCEL');}}});
 grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:true,expectedVersion:0,requestKey:'grant'});
 const authority=createWecomBotContext({mode:'isolated-synthetic',tenantId:'t',stores:[{id:'s'}],roles:['marketing'],store:grants,botId:'bot',corpId:'corp',readSubject:async()=>({botId:'bot',memberId:'member'}),readBinding:async()=>({botId:'bot',corpId:'corp',memberId:'member',accountId:'a',version:1,active:true}),readNative:async()=>({user,workspaceJid:'web:home-a'})});cleanups.push(()=>authority.close());
 const sender=createBotSender({timeoutMs:30,sdk:{mode:'isolated-synthetic',ready:()=>{readyHook();return true;},reply:async(frame,body)=>{sent.push(body.stream.content);return {headers:frame.headers,errcode:0};},sendMessage:async()=>{throw Error('NO_NOTIFY');}}});
 const conversations=createBotConversations({store:tasks,authority,intake,native:{readRoleWorkspace:async()=>{throw Error('NO_PREPARE');},prepareRoleWorkspace:async()=>{throw Error('NO_PREPARE');}}});
 const delivery=createBotDelivery({mode:'isolated-synthetic',authority,ledger,sender,conversations,scope:{tenant:'t',store:'s',workspace:'web:ledger'},employees:[{accountId:'a',employeeId:'employee',employeeName:'员工'}],readEvent:()=>({cmd:'aibot_msg_callback',headers:{req_id:'query'},body:{msgid:'query',aibotid:'bot',msgtype:'text',chattype:'single',from:{userid:'member',corpid:'corp'},text:{content:command}}})});cleanups.push(()=>delivery.close());
 return {sent,result,receipt,execution,grants,readVersions,run:(text?:string)=>{if(text)command=text;return delivery.handle({correlationId:'query',signal:new AbortController().signal,deadline:performance.now()+1000});},withoutResult:()=>{hasResult=false;},cancels:()=>cancels,readyHook:(hook:()=>void)=>{readyHook=hook;},actorHook:(hook:()=>Promise<void>)=>{actorHook=hook;},archive:()=>{archived=true;},remap:()=>{remapped=true;},pause:()=>{paused=true;},tickets:()=>tickets,reads:()=>reads};
}
it.each(['archive','remap','maintenance'] as const)('blocks the explicit query answer if original Native %s changes after lookup before reply',async kind=>{
 const s=querySetup();s.readyHook(()=>{if(kind==='archive')s.archive();else if(kind==='remap')s.remap();else s.pause();});
 const output=await s.run();expect(output.delivery?.state).toBe('blocked');expect(s.sent).toEqual([]);expect(s.tickets()).toBe(0);
});
it('rechecks the exact original query result revision and releases a late preflight gate ticket only at physical settlement',async()=>{
 const s=querySetup();let release:()=>void=()=>{},started=false;s.readyHook(()=>{s.actorHook(async()=>{started=true;await new Promise<void>(resolve=>{release=resolve;});});});
 const output=await s.run();expect(started).toBe(true);expect(output.delivery?.state).toBe('blocked');expect(s.sent).toEqual([]);expect(s.tickets()).toBe(1);
 release();for(let n=0;n<30&&s.tickets();n++)await new Promise(resolve=>setTimeout(resolve,2));expect(s.tickets()).toBe(0);expect(s.sent).toEqual([]);
});
it('blocks an altered frozen query version rather than sending the earlier lookup text',async()=>{
 const s=querySetup();s.readyHook(()=>{s.result.digest='e'.repeat(64);s.result.content='replacement';});const output=await s.run();expect(output.delivery?.state).toBe('blocked');expect(s.sent).toEqual([]);expect(s.reads()).toBeGreaterThan(1);
});

it('sends a permitted query only after re-reading its exact frozen revision through Native',async()=>{
 const s=querySetup(),output=await s.run();expect(output.delivery?.state).toBe('accepted');expect(s.readVersions).toEqual([1]);expect(s.sent).toHaveLength(1);expect(s.sent[0]).toContain(s.result.content);expect(s.tickets()).toBe(0);
});

it('queries a preserved completed result with its pending-manual-review meaning and original send preflight',async()=>{
 const s=querySetup();s.execution.manualReviewRequired=true;
 const output=await s.run();expect(output.delivery?.state).toBe('accepted');expect(s.sent).toHaveLength(1);
 expect(s.sent[0]).toContain(s.result.content);expect(s.sent[0]).toContain('待人工核对');expect(s.sent[0]).not.toContain('执行已结束');
 expect(s.readVersions).toEqual([1]);expect(s.cancels()).toBe(0);expect(s.execution).toMatchObject({state:'completed',manualReviewRequired:true});
});
it('does not cancel preserved work or claim a missing preserved answer completed',async()=>{
 const cancelling=querySetup();cancelling.execution.manualReviewRequired=true;
 const cancelled=await cancelling.run('取消对话 '+cancelling.result.receiptId);
 expect(cancelled.delivery?.state).toBe('accepted');expect(cancelling.sent[0]).toContain('待人工核对');expect(cancelling.cancels()).toBe(0);expect(cancelling.reads()).toBe(0);
 const missing=querySetup();missing.execution.manualReviewRequired=true;missing.withoutResult();
 expect((await missing.run()).delivery?.state).toBe('accepted');expect(missing.sent[0]).toContain('待人工核对');expect(missing.sent[0]).not.toContain('执行已结束');
 const running=querySetup();running.execution.manualReviewRequired=true;running.execution.state='running';
 expect((await running.run()).delivery?.state).toBe('accepted');expect(running.sent[0]).toContain('待人工核对');expect(running.sent[0]).not.toContain(running.result.content);expect(running.reads()).toBe(0);
});
it.each(['archive','grant','result','manual-flag','invalid-flag','state'] as const)('blocks a preserved result if %s changes immediately before sending',async kind=>{
 const s=querySetup();s.execution.manualReviewRequired=true;
 s.readyHook(()=>{
  if(kind==='archive')s.archive();
  if(kind==='grant')s.grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:false,expectedVersion:1,requestKey:'preserved-revoke'});
  if(kind==='result'){s.result.content='replacement';s.result.digest='e'.repeat(64);}
  if(kind==='manual-flag')s.execution.manualReviewRequired=false;
  if(kind==='invalid-flag')s.execution.manualReviewRequired='invalid';
  if(kind==='state')s.execution.state='running';
 });
 const output=await s.run();expect(output.delivery?.state).toBe('blocked');expect(s.sent).toEqual([]);expect(s.cancels()).toBe(0);
});
it('keeps preserved UTF-8 answer pages bounded and keeps every content point',async()=>{
 const s=querySetup();s.execution.manualReviewRequired=true;s.result.content='甲😀乙'.repeat(7000);
 const output=await s.run();expect(output.delivery?.state).toBe('accepted');expect(s.sent).toHaveLength(1);
 expect(s.sent[0]).toContain('甲😀乙');expect(s.sent[0]).toContain('第1/');
 expect(s.sent[0]).toContain('待人工核对');expect(Buffer.byteLength(s.sent[0]!)).toBeLessThanOrEqual(16384);expect(s.sent[0]).not.toContain('�');
 const pages=conversationResultPages(s.result,true);expect(pages.length).toBeGreaterThan(1);
 for(const page of pages){expect(Buffer.byteLength(page)).toBeLessThanOrEqual(16384);expect(page).toContain('待人工核对');expect(page).not.toContain('�');}
 expect(pages.map(page=>page.slice(page.indexOf('\n',page.indexOf('\n')+1)+1,page.lastIndexOf('\n查回：'))).join('')).toBe(s.result.content);
});
