import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {WSClient} from '@wecom/aibot-node-sdk';
import {createControlledRealBotSdkAdapter} from '../../src/role-eval/wecom-bot-sdk.js';
import {createControlledRealWecomBotPilot} from '../../src/role-eval/wecom-bot-pilot.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
const captured=vi.hoisted(()=>({clients:[] as any[],configs:[] as any[]}));
vi.mock('@wecom/aibot-node-sdk',async load=>{
 const sdk=await load<typeof import('@wecom/aibot-node-sdk')>();
 return {...sdk,WSClient:class extends sdk.WSClient {
  online=false;sent:any[]=[];connectCalls=0;disconnectCalls=0;
  constructor(config:any){super(config);captured.clients.push(this);captured.configs.push(config);
   const manager=Reflect.get(this,'wsManager');Object.defineProperty(manager,'isConnected',{get:()=>this.online});
   manager.sendReply=async(reqId:string,body:any,cmd:string)=>{this.sent.push(structuredClone({headers:{req_id:reqId},body,cmd}));return {headers:{req_id:reqId},errcode:0};};
  }
  override connect(){this.connectCalls++;this.online=true;this.emit('connected');return this;}
  override disconnect(){this.disconnectCalls++;this.online=false;super.disconnect();}
 }};
});
const overlay='../../integrations/native/conversation-overlay.mjs';
const {createControlledRealBotConversationNativePort}=await import(overlay);
const roleOverlay='../../integrations/native/role-workspace-overlay.mjs';
const {createControlledRealRoleWorkspaceNativePort}=await import(roleOverlay);
const clean:Array<()=>unknown>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();captured.clients.length=0;captured.configs.length=0;});
const actor={tenantId:'t',accountId:'a',storeId:'s',corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1,grantVersion:1};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'real-pilot-offline-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
 const grants=new WorkbenchAccessStore(join(dir,'grants')),ledger=new ManagerStore(join(dir,'facts')),store=new BotTaskStore(join(dir,'facts'));
 clean.push(()=>grants.close(),()=>ledger.close(),()=>store.close());
 grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:true,expectedVersion:0,requestKey:'grant'});
 let ready=false;const tickets=new Set<unknown>();let sequence=0;
 const gate={phase:()=>ready?'ready' as const:'paused' as const,isPaused:()=>!ready,noteArrival:vi.fn(),beginWrite:()=>{if(!ready)return null;const t={id:String(++sequence)};tickets.add(t);return t;},finishWrite:(t:unknown)=>{tickets.delete(t);}};
 const queue={close:vi.fn()},queued:string[]=[],records=new Map<string,any>(),results=new Map<string,any>(),outcomes:any[]=[],deliveries:any[]=[];
 let complete:(ids:string[])=>Promise<void>=async()=>{},authorize:(r:any)=>boolean=()=>false;
 const execution={queue,gate,enqueue:(id:string)=>{queued.push(id);},cancel:()=>{}};
 const native={getUserById:()=>({id:'a',role:'member',status:'active',must_change_password:false}),getOwnedRoleWorkspaceClaim:()=>({...actor,state:'ready',ownerId:'a',resourceKey:hash(['t','a','s','marketing']),role:'marketing',workspaceJid:'web:marketing',profileId:'profile'}),getRegisteredGroup:()=>({created_by:'a',is_home:false,executionMode:'container',folder:'marketing'}),getAgentProfileForUser:()=>({owner_user_id:'a',status:'active'}),getWorkspaceAgentProfileId:()=> 'profile',readBotConversationReceipt:(id:string)=>records.get(id),readConversationExecution:(id:string)=>({state:results.has(id)?'completed':'queued'}),readConversationResults:(id:string)=>results.has(id)?[results.get(id)]:[],readLatestConversationResult:(id:string)=>results.get(id),submitBotConversationMessage:vi.fn((i:any)=>{const r={actor:i.actor,originMessageId:i.originMessageId,textHash:hash(i.text),receiptId:i.receiptId,messageId:'native-input',acceptedAt:'2026-10-24',state:'accepted',...i.target,fingerprint:i.fingerprint};records.set(i.receiptId,r);return r;})};
 const readBinding=vi.fn(async()=>({botId:'bot',corpId:'corp',memberId:'member',accountId:'a',version:1,active:true}));
 const prepareRoleWorkspace=vi.fn(async()=>{throw Error('unexpected_prepare');});
 const admission={mode:'controlled-real-pilot' as const,environment:'local-test' as const,runId:'offline-test',expiresAt:Date.now()+60_000,botId:'bot',corpId:'corp',memberId:'member',accountId:'a',tenantId:'t',storeId:'s',roles:['marketing'] as ['marketing'],bindingVersion:1,configVersion:'1',credentialFingerprint:'offline-only',workspaceFingerprint:'offline-only'};
 const options={mode:'controlled-real-pilot' as const,admission,secret:'synthetic-placeholder',identity:{tenantId:'t',stores:[{id:'s'}],roles:['marketing'] as const,store:grants,readBinding,readNative:async()=>({user:native.getUserById(),workspaceJid:'web:home-a'})},business:{scope:{tenant:'t',store:'s',workspace:'web:ledger'},employees:[{accountId:'a',employeeId:'employee',employeeName:'合成员工'}],ledger,store},initializeExecution:(i:any)=>{complete=i.onCompleted;authorize=i.authorize;expect(i.mode).toBe('controlled-real-pilot');return execution;},authorize:(r:any)=>!!r&&grants.get(r.actor.accountId)?.active===true,createIntake:(e:any)=>createControlledRealBotConversationNativePort({mode:'controlled-real-pilot',gate,native,readActor:async()=>({...actor}),execution:e}),createRoles:()=>{const p=createControlledRealRoleWorkspaceNativePort({mode:'controlled-real-pilot',gate,native,templates:[],prepareOwnProfiles:prepareRoleWorkspace,journalDirectory:dir,readActor:async()=>({...actor,role:'marketing'})});return p;},readFingerprint:()=>({botId:'bot',corpId:'corp',ownerId:'a',configVersion:'1',credentialFingerprint:'offline-only',workspaceFingerprint:'offline-only'}),timeoutMs:100,onOutcome:(o:any)=>{outcomes.push(o);},onDelivery:(id:string,result:any)=>{deliveries.push({id,result});}};
 let pilot:ReturnType<typeof createControlledRealWecomBotPilot>;
 const create=()=>{pilot=createControlledRealWecomBotPilot(options);clean.push(()=>pilot.close());return pilot;};
 const client=()=>captured.clients.at(-1)!;
 const send=async(id:string,text:string,member='member',extra={})=>{Reflect.get(client(),'wsManager').onMessage({cmd:'aibot_msg_callback',headers:{req_id:'req-'+id},body:{msgid:id,aibotid:'bot',msgtype:'text',chattype:'single',from:{userid:member,corpid:'corp'},text:{content:text},...extra}});await pilot.idle();};
 const activate=async()=>{const p=pilot.prepare();await vi.waitFor(()=>expect(client().connectCalls).toBe(1));client().emit('authenticated');await p;ready=true;expect(pilot.activate()).toBe(true);};
 return {options,create,client,send,activate,gate,grants,queued,records,results,outcomes,deliveries,readBinding,prepareRoleWorkspace,native,execution,store,complete:(ids:string[])=>complete(ids),authorize:(r:any)=>authorize(r),ready:()=>{ready=true;}};
}
it('rejects incomplete admission before creating SDK or binding original execution',()=>{
 const s=setup();s.options.admission.memberId='';expect(s.create).toThrow('invalid_real_pilot_admission');expect(captured.clients).toEqual([]);
});
it('owns installed SDK construction with finite retries and requires authentication, gate and activation',async()=>{
 const s=setup(),p=s.create(),c=s.client();expect(c.connectCalls).toBe(0);expect(captured.configs[0]).toMatchObject({maxReconnectAttempts:0,maxAuthFailureAttempts:0});
 const preparing=p.prepare();await vi.waitFor(()=>expect(c.connectCalls).toBe(1));expect(p.activate()).toBe(false);c.emit('authenticated');await preparing;expect(p.activate()).toBe(false);s.ready();expect(p.activate()).toBe(true);await p.close();expect(p.status()).toBe('closed');expect(c.disconnectCalls).toBe(1);expect(s.execution.queue.close).not.toHaveBeenCalled();
});
it('rejects another exact member/bot/corp before authority, resource, persistence, queue or sends',async()=>{
 const s=setup();s.create();await s.activate();s.readBinding.mockClear();for(const [member,extra] of [['other',{}],['member',{aibotid:'other'}],['member',{from:{userid:'member',corpid:'other'}}]] as const)await s.send('wrong'+member+JSON.stringify(extra),'岗位 内容营销',member,extra);
 expect(s.readBinding).not.toHaveBeenCalled();expect(s.prepareRoleWorkspace).not.toHaveBeenCalled();expect(s.native.submitBotConversationMessage).not.toHaveBeenCalled();expect(s.queued).toEqual([]);expect(s.client().sent).toEqual([]);
});
it('uses original intake and D5 frozen results, snapshots callbacks/config and honors live revocation',async()=>{
 const s=setup(),p=s.create();s.options.admission.memberId='other';s.options.admission.roles[0]='manager' as any;s.options.createRoles=()=>{throw Error('mutated');};s.options.identity.readBinding=(async()=>{throw Error('mutated');}) as any;
 await s.activate();await s.send('select','岗位 内容营销');await s.send('demand','离线合成需求');const id=hash(['corp','bot','member','demand']);expect(s.queued).toEqual([id]);
 s.results.set(id,{receiptId:id,revision:1,digest:'b'.repeat(64),queryId:'query',turnId:'turn',sourceOutputIds:['output'],content:'离线冻结答案'});await s.complete([id]);expect(s.deliveries.at(-1).result.deliveries[0].state).toBe('accepted');expect(s.client().sent.at(-1).body).toMatchObject({chatid:'member',chat_type:1});
 await s.send('query','查询对话 '+id);expect(JSON.stringify(s.client().sent.at(-1))).toContain('离线冻结答案');expect(s.queued).toEqual([id]);expect(s.authorize({actor,role:'marketing'})).toBe(true);expect(s.authorize({actor:{...actor,memberId:'other'},role:'marketing'})).toBe(false);
 const sent=s.client().sent.length;s.grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:false,expectedVersion:1,requestKey:'revoke'});expect(s.authorize({actor,role:'marketing'})).toBe(false);await s.send('denied','岗位 内容营销');await expect(s.complete([id])).resolves.toBeUndefined();expect(s.deliveries.at(-1).result).toMatchObject({deferred:true});expect(s.client().sent).toHaveLength(sent);await p.close();
});

it('refuses pre-auth inbound and paused original gate without resources or sends',async()=>{
 const s=setup(),p=s.create();const preparing=p.prepare();await vi.waitFor(()=>expect(s.client().connectCalls).toBe(1));
 const rejected=expect(preparing).rejects.toThrow('input_not_accepted');await s.send('pre-auth','岗位 内容营销');await rejected;await p.close();
 expect(s.native.submitBotConversationMessage).not.toHaveBeenCalled();expect(s.prepareRoleWorkspace).not.toHaveBeenCalled();expect(s.queued).toEqual([]);expect(s.client().sent).toEqual([]);expect(p.status()).toBe('closed');
});
it('rejects absent live binding before connection even with an admitted member',async()=>{
 const s=setup();s.readBinding.mockResolvedValue({botId:'bot',corpId:'corp',memberId:'member',accountId:'a',version:1,active:false});const p=s.create();await expect(p.prepare()).rejects.toThrow('access_denied');expect(s.client().connectCalls).toBe(0);expect(p.status()).toBe('closed');
});
it('expires the admitted run and disconnects rather than permitting further effects',async()=>{
 const s=setup();s.options.admission.expiresAt=Date.now()+500;const p=s.create();await s.activate();await vi.waitFor(()=>expect(p.status()).toBe('closed'),{timeout:1500});
 await s.send('expired','岗位 内容营销');expect(s.client().sent).toEqual([]);expect(s.queued).toEqual([]);expect(s.client().connectCalls).toBe(1);expect(s.client().disconnectCalls).toBe(1);
});
it('fences changed configuration fingerprint and never reconnects the run',async()=>{
 const s=setup();let changed=false;const read=s.options.readFingerprint;s.options.readFingerprint=()=>({...read(),configVersion:changed?'2':'1'});const p=s.create();await s.activate();changed=true;await s.send('changed','岗位 内容营销');await p.close();
 expect(s.queued).toEqual([]);expect(s.client().sent).toEqual([]);expect(p.status()).toBe('closed');expect(s.client().connectCalls).toBe(1);
});

it('checks exact proactive recipient and admitted callback req_id at the owned send boundary',async()=>{
 const client=new WSClient({botId:'bot',secret:'synthetic-placeholder'}),c=captured.clients.at(-1)!;
 const sdk=createControlledRealBotSdkAdapter({mode:'controlled-real-pilot',client,botId:'bot',corpId:'corp',memberId:'member',admit:()=>true});clean.push(()=>sdk.close());c.online=true;client.emit('authenticated');
 const scope={signal:new AbortController().signal,deadline:performance.now()+1000};
 await expect(sdk.sendMessage('Member',{msgtype:'markdown',markdown:{content:'wrong case'}},scope)).rejects.toThrow('invalid_bot_target');
 await expect(sdk.reply({headers:{req_id:'unadmitted'}},{msgtype:'stream',stream:{id:'stream',finish:true,content:'no callback'}},scope)).rejects.toThrow('sdk_request_not_admitted');expect(c.sent).toEqual([]);
 await sdk.sendMessage('member',{msgtype:'markdown',markdown:{content:'offline allowed'}},scope);expect(c.sent).toHaveLength(1);
});

it('captures the original grant version for the lifetime of the run',async()=>{
 const s=setup(),p=s.create();await s.activate();s.grants.change('admin',{accountId:'a',storeId:'s',roles:['marketing'],active:true,expectedVersion:1,requestKey:'replace-equivalent-grant'});await s.send('new-grant','岗位 内容营销');await p.close();expect(s.queued).toEqual([]);expect(s.client().sent).toEqual([]);
});
it.each(['close','disconnect','fingerprint'] as const)('fences queued host execution before activation and after %s',async reason=>{
 const s=setup();let changed=false;const read=s.options.readFingerprint;s.options.readFingerprint=()=>({...read(),configVersion:changed?'2':'1'});
 const p=s.create(),receipt={actor,role:'marketing'};expect(s.authorize(receipt)).toBe(false);
 await s.activate();expect(s.authorize(receipt)).toBe(true);
 if(reason==='close')await p.close();else if(reason==='disconnect')s.client().emit('disconnected');else changed=true;
 expect(s.authorize(receipt)).toBe(false);expect(s.execution.queue.close).not.toHaveBeenCalled();
});
