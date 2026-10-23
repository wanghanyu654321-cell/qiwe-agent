import {afterEach, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ManagerArtifactStore} from '../../src/role-eval/manager-artifacts.js';
import {createWecomBotAssembly, type WecomBotAssemblyOutcome, type WecomBotExecutionBoundary} from '../../src/role-eval/wecom-bot-assembly.js';
import {ManagerStore, type StaffContext} from '../../src/role-eval/manager-store.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
import {createNativeBotTasks} from '../../src/role-eval/native-bot-tasks.js';
import {offlineBotSdk} from '../fixtures/offline-bot-sdk.js';
import {createBotSdkAdapter} from '../../src/role-eval/wecom-bot-sdk.js';
import {createWecomBotPreparation} from '../../src/role-eval/wecom-bot-preparation.js';

const cleanup: (() => void)[] = [];
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close();});
const people = ['a', 'b', 'c'].map(id => ({accountId: id, memberId: 'member-' + id, employeeId: 'employee-' + id, employeeName: '合成' + id, store: id === 'c' ? 'store-c' : 'store-b'}));
function text(member: string, id: string, content = '本月销售100元') {
  return {cmd: 'aibot_msg_callback', headers: {req_id: 'req-' + id}, body: {msgid: id, aibotid: 'bot', msgtype: 'text', chattype: 'single', create_time: 1792458000, from: {userid: member, corpid: 'corp'}, text: {content}}};
}
function setup(extra: {maxInFlight?: number; requestTimeoutMs?: number} = {},controlled=false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-'));
  cleanup.push(() => fs.rmSync(dir, {recursive: true, force: true}));
  const grants = new WorkbenchAccessStore(path.join(dir, 'grants.sqlite'));
  const factFile = path.join(dir, 'existing.sqlite');
  const ledger = new ManagerStore(factFile);
  const tasks = new BotTaskStore(factFile);
  const artifacts = new ManagerArtifactStore({mode: 'isolated-synthetic', directory: path.join(dir, 'original-artifacts')});
  cleanup.push(() => grants.close(), () => ledger.close(), () => tasks.close());
  for (const p of people) grants.change('admin', {accountId: p.accountId, storeId: p.store, roles: ['manager', 'marketing'], active: true, expectedVersion: 0, requestKey: 'grant-' + p.accountId});
  const offline = offlineBotSdk(), outcomes: WecomBotAssemblyOutcome[] = [];
  const outgoing=controlled?createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client}):undefined;
  if(outgoing)cleanup.push(()=>outgoing.close());
  const readBinding = vi.fn(async (subject: {memberId: string}) => {
    const p = people.find(p => p.memberId === subject.memberId);
    if (!p) throw Error('secret_binding_error');
    return {botId: 'bot', corpId: 'corp', memberId: p.memberId, accountId: p.accountId, active: true, version: 1};
  });
  const readNative = vi.fn(async (accountId: string) => ({user: {id: accountId, role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-' + accountId}));
  const businesses = ['store-b', 'store-c'].map(store => ({scope: {tenant: 'tenant', store, workspace: 'web:original'}, employees: people.filter(p => p.store === store), ledger, artifacts, tasks: {store: tasks, catalog: []}}));
  const options = {mode: 'isolated-synthetic' as const, botId: 'bot', corpId: 'corp', client: offline.client,
    identity: {tenantId: 'tenant', stores: [{id: 'store-b'}, {id: 'store-c'}], roles: ['manager', 'marketing'] as const, store: grants, readBinding, readNative},
    businesses, sender: {sdk: outgoing??offline.sdk, fileSdk: outgoing??offline.fileSdk}, onOutcome: (outcome: WecomBotAssemblyOutcome) => {outcomes.push(outcome);}, ...extra};
  const app = createWecomBotAssembly(options); cleanup.push(() => app.close());
  const actor = (id: string): StaffContext => {const p = people.find(p => p.accountId === id)!; return {tenant: 'tenant', store: p.store, workspace: 'web:original', employeeId: p.employeeId, employeeName: p.employeeName};};
  const dispatch = async (frame: unknown) => {offline.frame(frame); await app.idle(); return outcomes.at(-1)!;};
  const counts = () => {const db = new DatabaseSync(factFile, {readOnly: true}); try {return {reports: db.prepare('SELECT COUNT(*) AS n FROM employee_reports').get()!.n, replies: db.prepare('SELECT COUNT(*) AS n FROM bot_reply_intents').get()!.n};} finally {db.close();}};
  return {app, offline, options, outcomes, dispatch, ledger, grants, tasks, actor, readBinding, readNative, counts, artifacts};
}
it('assembles the controlled SDK adapter with original ledger, nested card update, export and live revocation',async()=>{
 const s=setup({},true);s.offline.authenticate();
 const pending=(await s.dispatch(text('member-a','controlled-report'))).result!.result,card=pending.reply.body.template_card!;
 const event={cmd:'aibot_event_callback',headers:{req_id:'controlled-confirm'},body:{msgid:'controlled-confirm',aibotid:'bot',msgtype:'event',chattype:'single',from:{userid:'member-a',corpid:'corp'},event:{eventtype:'template_card_event',template_card_event:{card_type:'button_interaction',task_id:card.task_id,event_key:card.button_list[0]!.key}}}};
 expect((await s.dispatch(event)).result?.reportDelivery?.state).toBe('accepted');
 expect(s.offline.sent.at(-1)).toMatchObject({cmd:'aibot_respond_update_msg',headers:{req_id:'controlled-confirm'},body:{userids:['member-a'],template_card:{task_id:card.task_id}}});
 const before=s.offline.sent.length;expect((await s.dispatch(event)).result?.suppressed).toBe(true);expect(s.offline.sent).toHaveLength(before);
 const summary=(await s.dispatch(text('member-a','controlled-summary','经营汇总 2026-10-20 本月'))).result!.result;
 expect((await s.dispatch(text('member-a','controlled-file','导出Excel '+summary.snapshotId))).result?.delivery?.state).toBe('accepted');
 expect(s.offline.sent.at(-1)).toMatchObject({cmd:'aibot_send_msg',body:{chatid:'member-a',chat_type:1,msgtype:'file'}});
 expect(new Set(s.offline.sent.map(f=>f.headers.req_id)).size).toBe(s.offline.sent.length);
 const sent=s.offline.sent.length;s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['manager','marketing'],active:false,expectedVersion:1,requestKey:'controlled-revoke'});
 expect((await s.dispatch(text('member-a','controlled-denied','查询 '+pending.reportId))).state).toBe('rejected');
 expect(s.offline.sent).toHaveLength(sent);expect(s.ledger.getReport(s.actor('a'),pending.reportId!)?.entries[0]?.amountCents).toBe(10000);
});

it('selects a permitted marketing conversation and gives an honest D1 reply without writing a report',async()=>{
 const s=setup();s.app.close();
 s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing'],active:true,expectedVersion:1,requestKey:'marketing-only'});
 const prepared:string[]=[];
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){return {state:'missing' as const,detail:'not prepared'};},
  async prepareRoleWorkspace(input:{actor:{accountId:string;role:string}}){prepared.push(input.actor.accountId+':'+input.actor.role);return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 const before=s.counts().reports;
 s.offline.frame(text('member-a','choose-marketing','岗位 内容营销'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('内容营销');
 s.offline.frame(text('member-a','draft-copy','写三条朋友圈文案'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('对话执行尚未接通');
 expect(s.counts().reports).toBe(before);
 expect(prepared).toEqual(['a:marketing']);
 s.offline.frame(text('member-a','mode-status','岗位查询'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('内容营销');
 s.offline.frame(text('member-a','bad-role','岗位 不存在'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('已开通岗位');
 expect(s.counts().reports).toBe(before);
 s.offline.frame(text('member-a','exit-mode','退出岗位对话'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('已退出');
 s.offline.frame(text('member-a','choose-marketing','岗位 内容营销'));await app.idle();
 expect(prepared).toEqual(['a:marketing']);
});
it('routes selected natural text to a fixed Native receipt and resolves it after exit without report writes',async()=>{
 const s=setup();s.app.close();s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing'],active:true,expectedVersion:1,requestKey:'receipt-marketing-only'});const receipts=new Map<string,any>();let submits=0;
 const intake={async readReceipt(input:any){return receipts.get(input.receiptId);},async submitMessage(input:any){submits++;const receipt={receiptId:input.receiptId,messageId:'native-input-uuid',acceptedAt:'2026-10-22T00:00:00.000Z',state:'accepted' as const,role:input.target.role,workspaceJid:input.target.workspaceJid,profileId:input.target.profileId,selectionId:input.target.selectionId,fingerprint:input.fingerprint};receipts.set(input.receiptId,receipt);return receipt;}};
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},async prepareRoleWorkspace(){throw Error('unexpected_create');}},intake}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','select-receipt','岗位 内容营销'));await app.idle();
 const before=s.counts().reports;s.offline.frame(text('member-a','d2-natural','写三条朋友圈文案'));await app.idle();
 const reply=JSON.stringify(s.offline.sent.at(-1)?.body),receiptId=createHash('sha256').update(JSON.stringify(['corp','bot','member-a','d2-natural'])).digest('hex');
 expect(reply).toContain(receiptId);expect(reply).toContain('已保存需求');expect(reply).toContain('本次未生成答案');
 expect(receipts.get(receiptId)).toMatchObject({role:'marketing',workspaceJid:'web:marketing-a',profileId:'profile-a'});expect(submits).toBe(1);expect(s.counts().reports).toBe(before);
 s.offline.frame(text('member-a','d2-natural','报数 本月销售100元'));await app.idle();
 expect(s.outcomes.at(-1)?.detail).toBe('bot_reply_conflict');expect(submits).toBe(1);expect(s.counts().reports).toBe(before);
 s.offline.frame(text('member-a','exit-receipt','退出岗位对话'));await app.idle();
 s.offline.frame(text('member-a','query-receipt','查询对话 '+receiptId));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain(receiptId);expect(s.counts().reports).toBe(before);
 s.offline.frame(text('member-a','missing-receipt','查询对话 '+ 'f'.repeat(64)));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('未找到你有权访问');expect(s.counts().reports).toBe(before);
 s.offline.frame(text('member-a','d2-natural','写三条朋友圈文案'));await app.idle();
 expect(submits).toBe(1);expect(s.counts().reports).toBe(before);
});
function conversationExecutionSetup(execution: any, cancel?: (input:any)=>Promise<any>, extra:{executionBoundary?:WecomBotExecutionBoundary;requestTimeoutMs?:number}={}){
 const s=setup();s.app.close();
 const receipt={receiptId:'d'.repeat(64),messageId:'original-input',acceptedAt:'2026-10-22T00:00:00.000Z',state:'accepted' as const,role:'marketing' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',selectionId:'selection',fingerprint:'a'.repeat(64),execution};
 const intake={readReceipt:vi.fn(async()=>receipt),submitMessage:vi.fn(async()=>{throw Error('query_must_not_submit');}),...(cancel?{cancelReceipt:vi.fn(cancel)}:{})};
 const app=createWecomBotAssembly({...s.options,...extra,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){throw Error('query_must_not_prepare');},async prepareRoleWorkspace(){throw Error('query_must_not_prepare');}},intake}}))});
 cleanup.push(()=>app.close());s.offline.authenticate();
 const dispatch=async(id:string,command:string)=>{s.offline.frame(text('member-a',id,command));await app.idle();return JSON.stringify(s.offline.sent.at(-1)?.body);};
 return {...s,app,intake,receipt,dispatch};
}
it('shows preserved legacy work as manual review without cancelling or resubmitting it',async()=>{
 const cancel=vi.fn(async()=>{throw Error('preserved_work_must_not_cancel');});
 const s=conversationExecutionSetup({state:'running',queryId:'old-query',manualReviewRequired:true},cancel);
 for(const command of ['查询对话','取消对话']){
  const reply=await s.dispatch('preserved-'+command,command+' '+s.receipt.receiptId);
  expect(reply).toContain('待人工核对');expect(reply).toContain('暂停自动续跑');
  expect(reply).not.toContain('执行中');expect(reply).not.toContain('已取消');
 }
 expect(cancel).not.toHaveBeenCalled();expect(s.intake.submitMessage).not.toHaveBeenCalled();
 expect(s.receipt.execution.state).toBe('running');
});
it.each([
 ['queued','排队中'],['running','执行中'],['cancelling','取消处理中'],['cancelled','已取消'],['completed','执行已结束'],['failed','执行失败'],['unknown','执行结果待核实'],
])('D3 query shows persisted %s without inventing an answer',async(state,label)=>{
 const s=conversationExecutionSetup({state,queryId:'original-query',turnId:'original-turn',sessionId:'original-session'});
 const reply=await s.dispatch('d3-state-'+state,'查询对话 '+s.receipt.receiptId);
 expect(reply).toContain(label);expect(reply).toContain(s.receipt.receiptId);expect(reply).not.toContain('执行尚未接通');
 expect(s.intake.submitMessage).not.toHaveBeenCalled();expect(s.counts().reports).toBe(0);
});
it('D3 cancels only the addressed receipt and reports shared execution as cancelling until terminal',async()=>{
 let s:ReturnType<typeof conversationExecutionSetup>;
 const cancel=vi.fn(async(input:any)=>({...s.receipt,execution:{state:'cancelling',queryId:'original-query',turnId:'original-turn',batchSize:2}}));
 s=conversationExecutionSetup({state:'running',queryId:'original-query',turnId:'original-turn',batchSize:2},cancel);
 const substituted=vi.fn(async()=>{throw Error('late_callback_must_not_run');});s.intake.cancelReceipt=substituted;
 const reply=await s.dispatch('d3-cancel','取消对话 '+s.receipt.receiptId);
 expect(cancel).toHaveBeenCalledTimes(1);expect(substituted).not.toHaveBeenCalled();
 expect(cancel.mock.calls[0]?.[0]).toMatchObject({receiptId:s.receipt.receiptId,actor:{accountId:'a',storeId:'store-b'}});
 expect(reply).toContain('取消处理中');expect(reply).toContain('同批');expect(reply).not.toContain('已取消');
 s.receipt.execution={state:'cancelled'};
 expect(await s.dispatch('d3-cancel-query','查询对话 '+s.receipt.receiptId)).toContain('已取消');
 expect(s.counts().reports).toBe(0);expect(s.intake.submitMessage).not.toHaveBeenCalled();
});
it('D3 uncertain cancellation gives lookup instructions and does not repeat the side effect on redelivery',async()=>{
 const cancel=vi.fn(async()=>{throw Error('synthetic_lost_cancel_response');});
 const s=conversationExecutionSetup({state:'running',queryId:'original-query',turnId:'original-turn'},cancel);
 const reply=await s.dispatch('d3-cancel-unknown','取消对话 '+s.receipt.receiptId);
 expect(reply).toContain('取消结果待核实');expect(reply).toContain('查询对话 '+s.receipt.receiptId);
 await s.dispatch('d3-cancel-unknown','取消对话 '+s.receipt.receiptId);
 expect(cancel).toHaveBeenCalledTimes(1);expect(s.counts().reports).toBe(0);
});
it('D3 checks receipt role before cancellation and rejects malformed execution state',async()=>{
 const cancel=vi.fn(async()=>{throw Error('not_authorized');});const s=conversationExecutionSetup({state:'running'},cancel);
 s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['manager'],active:true,expectedVersion:1,requestKey:'d3-role-revoke'});
 await s.dispatch('d3-denied-cancel','取消对话 '+s.receipt.receiptId);
 expect(cancel).not.toHaveBeenCalled();expect(s.outcomes.at(-1)?.state).toBe('rejected');
 s.receipt.role='manager' as any;s.receipt.execution={state:'fabricated-success'};
 await s.dispatch('d3-invalid-state','查询对话 '+s.receipt.receiptId);
 expect(s.outcomes.at(-1)?.state).toBe('rejected');expect(s.counts().reports).toBe(0);
});
it('D3 cancellation is unavailable on a D2-only port without falling back to reporting',async()=>{
 const s=conversationExecutionSetup(undefined);
 const substituted=vi.fn(async()=>s.receipt);s.intake.cancelReceipt=substituted;
 expect(await s.dispatch('d3-no-cancel-port','取消对话 '+s.receipt.receiptId)).toContain('取消尚未接通');
 expect(substituted).not.toHaveBeenCalled();expect(s.intake.submitMessage).not.toHaveBeenCalled();expect(s.counts().reports).toBe(0);
});
it('D3 holds the write ticket until a timed-out cancellation physically settles',async()=>{
 let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
 let s:ReturnType<typeof conversationExecutionSetup>;
 const cancel=vi.fn(async()=>{await waiting;return {...s.receipt,execution:{state:'cancelled'}};});
 const finish=vi.fn(),boundary:WecomBotExecutionBoundary={admit:()=>true,enter:()=>({id:'d3-ticket'}),check:()=>true,close:finish};
 s=conversationExecutionSetup({state:'running'},cancel,{executionBoundary:boundary,requestTimeoutMs:100});
 s.offline.frame(text('member-a','d3-cancel-timeout','取消对话 '+s.receipt.receiptId));
 await vi.waitFor(()=>expect(cancel).toHaveBeenCalledTimes(1));
 await vi.waitFor(()=>expect(s.outcomes.at(-1)?.state).toBe('rejected'));
 expect(finish).not.toHaveBeenCalled();expect(s.offline.sent).toHaveLength(0);
 release();await s.app.idle();expect(finish).toHaveBeenCalledTimes(1);expect(s.offline.sent).toHaveLength(0);
});
it('D3 rejects a cancellation response that mutates the prior receipt identity',async()=>{
 let s:ReturnType<typeof conversationExecutionSetup>;
 s=conversationExecutionSetup({state:'running'},async()=>{s.receipt.workspaceJid='web:different';return {...s.receipt,execution:{state:'cancelled'}};});
 const reply=await s.dispatch('d3-cancel-mutated','取消对话 '+s.receipt.receiptId);
 expect(reply).toContain('取消结果待核实');expect(reply).not.toContain('已取消');expect(s.counts().reports).toBe(0);
});
it('gives a deterministic lookup hint for an unconfirmed Native submit without retrying it',async()=>{
 const s=setup();s.app.close();let submits=0;
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},async prepareRoleWorkspace(){throw Error('unexpected_create');}},intake:{async readReceipt(){return undefined;},async submitMessage(input){submits++;return {...input.target,receiptId:input.receiptId,messageId:input.originMessageId,fingerprint:input.fingerprint,state:'accepted' as const,acceptedAt:''};}}}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','uncertain-select','岗位 内容营销'));await app.idle();
 const before=s.counts().reports;s.offline.frame(text('member-a','uncertain-submit','写文案'));await app.idle();
 const id=createHash('sha256').update(JSON.stringify(['corp','bot','member-a','uncertain-submit'])).digest('hex');
 expect(s.outcomes.at(-1)?.state).toBe('handled');expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('受理结果待核实');expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain(id);
 expect(submits).toBe(1);expect(s.counts().reports).toBe(before);
 s.offline.frame(text('member-a','bad-query','查询对话 bad'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('完整编号');expect(submits).toBe(1);expect(s.counts().reports).toBe(before);
});
it('keeps a completed unknown conversation reply out of original reporting on replay',async()=>{
 const s=setup();s.app.close();let submissions=0;
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},async prepareRoleWorkspace(){throw Error('unexpected_create');}},intake:{async readReceipt(){return undefined;},async submitMessage(){submissions++;throw Error('synthetic_unknown');}}}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','unknown-conversation-select','岗位 内容营销'));await app.idle();
 const source=text('member-a','unknown-conversation','本月销售100元');s.offline.frame(source);await app.idle();
 expect(s.counts().reports).toBe(0);expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('受理结果待核实');
 s.offline.frame(source);await app.idle();
 expect(submissions).toBe(1);expect(s.counts().reports).toBe(0);expect(s.outcomes.at(-1)?.state).toBe('handled');
});
it('does not submit a cached original report replay after a later role selection',async()=>{
 const s=setup();s.app.close();let submissions=0;
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},async prepareRoleWorkspace(){throw Error('unexpected_create');}},intake:{async readReceipt(){return undefined;},async submitMessage(){submissions++;throw Error('unexpected_submit');}}}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 const old=text('member-a','old-report','本月销售100元');s.offline.frame(old);await app.idle();expect(s.counts().reports).toBe(1);
 s.offline.frame(text('member-a','later-select','岗位 内容营销'));await app.idle();
 s.offline.frame(old);await app.idle();
 expect(s.outcomes.at(-1)).toMatchObject({state:'handled',detail:'event_handled'});expect(submissions).toBe(0);expect(s.counts().reports).toBe(1);
});
it('reconciles a reserved delivery against Native before deciding whether to submit',async()=>{
 const s=setup();s.app.close();let submissions=0,receipt:any;
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},async prepareRoleWorkspace(){throw Error('unexpected_create');}},intake:{async readReceipt(){return receipt;},async submitMessage(){submissions++;throw Error('unexpected_submit');}}}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','reserved-select','岗位 内容营销'));await app.idle();
 const source=text('member-a','reserved-native','写文案'),id=createHash('sha256').update(JSON.stringify(['corp','bot','member-a','reserved-native'])).digest('hex'),fingerprint=createHash('sha256').update(JSON.stringify(['bot','member-a','reserved-native',1792458000,{kind:'text',text:'写文案'}])).digest('hex');
 s.ledger.reserveBotReply(s.actor('a'),{id,fingerprint,reqId:'req-reserved-native',target:{corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,accountId:'a',workspaceJid:'web:home-a',storeId:'store-b'}});
 const selected=s.tasks.currentConversation({tenantId:'tenant',storeId:'store-b',accountId:'a',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,grantVersion:1})!;
 receipt={receiptId:id,messageId:'native-input-uuid',acceptedAt:'2026-10-22T00:00:00.000Z',state:'accepted',role:'marketing',workspaceJid:'web:marketing-a',profileId:'profile-a',selectionId:selected.eventId,fingerprint};
 s.offline.frame(source);await app.idle();
 expect(s.outcomes.at(-1)?.state).toBe('handled');expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('已保存需求');expect(submissions).toBe(0);expect(s.counts().reports).toBe(0);
});
it('retains the original gate ticket until a timed-out Native intake physically settles',async()=>{
 const s=setup();s.app.close();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let started=false,entered=0,closed=0;
 const boundary:WecomBotExecutionBoundary={admit:()=>true,enter:()=>++entered,check:()=>true,close:()=>{closed++;}};
 const app=createWecomBotAssembly({...s.options,executionBoundary:boundary,requestTimeoutMs:200,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},async prepareRoleWorkspace(){throw Error('unexpected_create');}},intake:{async readReceipt(){return undefined;},async submitMessage(input){started=true;await wait;return {receiptId:input.receiptId,messageId:'native-input-uuid',acceptedAt:'2026-10-22T00:00:00.000Z',state:'accepted' as const,role:input.target.role,workspaceJid:input.target.workspaceJid,profileId:input.target.profileId,selectionId:input.target.selectionId,fingerprint:input.fingerprint};}}}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','gate-select','岗位 内容营销'));await app.idle();const before=s.counts().reports,baseline=closed;
 s.offline.frame(text('member-a','gate-intake','写文案'));await vi.waitFor(()=>expect(started).toBe(true));
 await vi.waitFor(()=>expect(s.outcomes.at(-1)?.detail).toBe('request_timeout'));
 expect(entered).toBe(2);expect(closed).toBe(baseline);expect(s.counts().reports).toBe(before);expect(s.offline.sent).toHaveLength(1);
 release();await app.idle();expect(closed).toBe(baseline+1);expect(s.counts().reports).toBe(before);
});
it('allows explicit reselection after a grant version change while stale ordinary text cannot reach reporting',async()=>{
 const s=setup();s.app.close();
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},
  async prepareRoleWorkspace(){throw Error('unexpected_create');}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','first-select','岗位 内容营销'));await app.idle();
 s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing'],active:true,expectedVersion:1,requestKey:'remove-manager'});
 const before=s.counts().reports;s.offline.frame(text('member-a','stale-draft','本月销售100元'));await app.idle();
 expect(s.outcomes.at(-1)?.state).toBe('rejected');expect(s.counts().reports).toBe(before);
 s.offline.frame(text('member-a','fresh-select','岗位 内容营销'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('已选择');
 s.offline.frame(text('member-a','fresh-draft','写三条朋友圈文案'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('对话执行尚未接通');
 expect(s.counts().reports).toBe(before);
});
it('rejects a Native preparation result whose owner was changed through the input reference',async()=>{
 const s=setup();s.app.close();
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(input:{actor:{accountId:string}}){input.actor.accountId='b';return {state:'ready' as const,workspaceJid:'web:marketing-b',profileId:'profile-b',ownerAccountId:'b',storeId:'store-b',role:'marketing' as const};},
  async prepareRoleWorkspace(){throw Error('unexpected_create');}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','mutated-owner','岗位 内容营销'));await app.idle();
 expect(s.outcomes.at(-1)?.state).toBe('rejected');
 expect(s.offline.sent).toEqual([]);
 expect(s.tasks.currentConversation({tenantId:'tenant',storeId:'store-b',accountId:'a',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,grantVersion:1})?.state).toBe('preparing');
});
it('keeps explicit task and reporting commands available while role preparation is unknown',async()=>{
 const s=setup();s.app.close();
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){return {state:'unknown' as const,detail:'native result pending'};},
  async prepareRoleWorkspace(){throw Error('must_reconcile');}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','unknown-select','岗位 内容营销'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('无法核实');
 s.offline.frame(text('member-a','unknown-status','岗位查询'));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('重新发送选岗命令可核实准备结果');
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('不会重复创建');
 s.offline.frame(text('member-a','original-task-query','查询任务 内容营销 '+ 'a'.repeat(64)));await app.idle();
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).toContain('任务');
 expect(JSON.stringify(s.offline.sent.at(-1)?.body)).not.toContain('岗位空间正在准备');
 s.offline.frame(text('member-a','explicit-report','报数 本月销售100元'));await app.idle();
 expect(s.outcomes.at(-1)?.result?.result.status).toBe('pending');
 expect(s.counts().reports).toBe(1);
});
it('rechecks an unknown resource result without calling prepare again on the same selection event',async()=>{
 const s=setup();s.app.close();let prepares=0;
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){return {state:'missing' as const,detail:'not found'};},
  async prepareRoleWorkspace(){prepares++;return {state:'unknown' as const,detail:'create result lost'};}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 const frame=text('member-a','unknown-create','岗位 内容营销');s.offline.frame(frame);await app.idle();
 expect(prepares).toBe(1);
 s.offline.frame(frame);await app.idle();
 expect(prepares).toBe(1);
 expect(s.tasks.currentConversation({tenantId:'tenant',storeId:'store-b',accountId:'a',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,grantVersion:1})?.state).toBe('unknown');
});
it('rejects a reused report message ID before a different role selection can prepare resources',async()=>{
 const s=setup();s.app.close();let prepares=0;
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){prepares++;return {state:'missing' as const,detail:'missing'};},
  async prepareRoleWorkspace(){prepares++;return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','same-message','本月销售100元'));await app.idle();
 expect(s.outcomes.at(-1)?.result?.result.status).toBe('pending');
 s.offline.frame(text('member-a','same-message','岗位 内容营销'));await app.idle();
 expect(s.outcomes.at(-1)?.detail).toBe('bot_reply_conflict');
 expect(prepares).toBe(0);
 expect(s.tasks.currentConversation({tenantId:'tenant',storeId:'store-b',accountId:'a',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,grantVersion:1})).toBeUndefined();
});
it('rejects a reused selection message ID before it can write a report',async()=>{
 const s=setup();s.app.close();
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},
  async prepareRoleWorkspace(){throw Error('unexpected_create');}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','select-then-report','岗位 内容营销'));await app.idle();
 const before=s.counts().reports;
 s.offline.frame(text('member-a','select-then-report','报数 本月销售100元'));await app.idle();
 expect(s.outcomes.at(-1)?.detail).toBe('bot_reply_conflict');
 expect(s.counts().reports).toBe(before);
});
it('captures Native preparation callbacks at assembly construction',async()=>{
 const s=setup();s.app.close();let original=0,replacement=0;
 const native={async readRoleWorkspace(){original++;return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};},async prepareRoleWorkspace(){throw Error('unexpected_create');}};
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native}}))});cleanup.push(()=>app.close());
 native.readRoleWorkspace=async()=>{replacement++;return {state:'ready' as const,workspaceJid:'web:marketing-b',profileId:'profile-b',ownerAccountId:'b',storeId:'store-b',role:'marketing' as const};};
 s.offline.authenticate();s.offline.frame(text('member-a','callback-snapshot','岗位 内容营销'));await app.idle();
 expect(s.outcomes.at(-1)?.state).toBe('handled');expect(original).toBe(1);expect(replacement).toBe(0);
});
it('does not send a cached manager file after manager permission is removed',async()=>{
 const s=setup();s.app.close();
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{async readRoleWorkspace(){return {state:'unknown' as const,detail:'unused'};},async prepareRoleWorkspace(){throw Error('unused');}}}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','sales-for-file'));await app.idle();
 const pending=s.outcomes.at(-1)!.result!.result,card=pending.reply.body.template_card!;
 s.offline.frame({cmd:'aibot_event_callback',headers:{req_id:'confirm-for-file'},body:{msgid:'confirm-for-file',aibotid:'bot',msgtype:'event',chattype:'single',from:{userid:'member-a',corpid:'corp'},event:{eventtype:'template_card_event',template_card_event:{card_type:'button_interaction',task_id:card.task_id,event_key:card.button_list[0]!.key}}}});await app.idle();
 s.offline.frame(text('member-a','summary-for-file','经营汇总 2026-10-20 本月'));await app.idle();
 const id=s.outcomes.at(-1)!.result!.result.snapshotId!;
 const frame=text('member-a','file-before-revoke','导出Excel '+id);
 s.offline.frame(frame);await app.idle();
 expect(s.outcomes.at(-1)?.result?.result.status).toBe('file');
 const sent=s.offline.sent.length;
 s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing'],active:true,expectedVersion:1,requestKey:'manager-revoked-file'});
 s.offline.frame(frame);await app.idle();
 expect(s.outcomes.at(-1)?.state).toBe('rejected');expect(s.offline.sent).toHaveLength(sent);
});
it('reports a timed-out Native workspace read promptly while retaining its write ticket until physical settlement',async()=>{
 const s=setup();s.app.close();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let readStarted=false;
 let entered=0,closed=0;const boundary:WecomBotExecutionBoundary={admit:()=>true,enter:()=>++entered,check:()=>true,close:()=>{closed++;}};
 const app=createWecomBotAssembly({...s.options,executionBoundary:boundary,requestTimeoutMs:200,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){readStarted=true;await wait;return {state:'missing' as const,detail:'late'};},
  async prepareRoleWorkspace(){throw Error('must_not_create_after_timeout');}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','hung-workspace-read','岗位 内容营销'));
 await vi.waitFor(()=>expect(readStarted).toBe(true));
 await vi.waitFor(()=>expect(s.outcomes.at(-1)?.detail).toBe('request_timeout'));
 expect(entered).toBe(1);expect(closed).toBe(0);
 release();await app.idle();expect(closed).toBe(1);
 expect(s.offline.sent).toEqual([]);
});
it('keeps the write ticket through a late Native prepare and never saves its result after timeout',async()=>{
 const s=setup();s.app.close();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let prepareStarted=false;
 let entered=0,closed=0;const boundary:WecomBotExecutionBoundary={admit:()=>true,enter:()=>++entered,check:()=>true,close:()=>{closed++;}};
 const app=createWecomBotAssembly({...s.options,executionBoundary:boundary,requestTimeoutMs:200,businesses:s.options.businesses.map(b=>({...b,conversations:{store:s.tasks,native:{
  async readRoleWorkspace(){return {state:'missing' as const,detail:'unprepared'};},
  async prepareRoleWorkspace(){prepareStarted=true;await wait;return {state:'ready' as const,workspaceJid:'web:marketing-a',profileId:'profile-a',ownerAccountId:'a',storeId:'store-b',role:'marketing' as const};}
 }}}))});cleanup.push(()=>app.close());s.offline.authenticate();
 s.offline.frame(text('member-a','hung-native-prepare','岗位 内容营销'));
 await vi.waitFor(()=>expect(prepareStarted).toBe(true));
 await vi.waitFor(()=>expect(s.outcomes.at(-1)?.detail).toBe('request_timeout'));
 expect(entered).toBe(1);expect(closed).toBe(0);
 expect(s.offline.sent).toEqual([]);
 const actor={tenantId:'tenant',storeId:'store-b',accountId:'a',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,grantVersion:1};
 expect(s.tasks.currentConversation(actor)).toMatchObject({state:'attempting'});
 release();await app.idle();
 expect(closed).toBe(1);
 expect(s.tasks.currentConversation(actor)).toMatchObject({state:'attempting'});
 expect(s.offline.sent).toEqual([]);
});

it('runs installed SDK events with separate A/B/C authority on one ledger, card confirmation, query and replay', async () => {
  const s = setup(); s.offline.authenticate();
  for (const p of people) s.offline.frame(text(p.memberId, 'report-' + p.accountId));
  await s.app.idle();
  expect(s.outcomes.map(o => o.result?.result.status)).toEqual(['pending', 'pending', 'pending']);
  const ids = s.outcomes.map(o => o.result!.result.reportId!);
  expect(new Set(ids).size).toBe(3);
  for (let i = 0; i < people.length; i++) {
    const p = people[i]!, card = s.outcomes[i]!.result!.result.reply.body.template_card!;
    const frame = {cmd: 'aibot_event_callback', headers: {req_id: 'confirm-' + p.accountId}, body: {msgid: 'confirm-' + p.accountId, aibotid: 'bot', msgtype: 'event', chattype: 'single', from: {userid: p.memberId, corpid: 'corp'}, event: {eventtype: 'template_card_event', task_id: card.task_id, event_key: card.button_list[0]!.key}}};
    expect((await s.dispatch(frame)).result?.result.status).toBe('confirmed');
    expect(s.offline.sent.at(-1)).toMatchObject({cmd:'aibot_respond_update_msg',headers:{req_id:'confirm-'+p.accountId},body:{response_type:'update_template_card',userids:[p.memberId],template_card:{task_id:card.task_id,main_title:{title:'已入账，可查回'}}}});
    const count = s.offline.sent.length;
    expect((await s.dispatch(frame)).result?.suppressed).toBe(true);
    expect(s.offline.sent.length).toBe(count);
    expect(s.ledger.getReport(s.actor(p.accountId), ids[i]!)?.entries[0]?.amountCents).toBe(10000);
    expect((await s.dispatch(text(p.memberId, 'query-' + p.accountId, '查询 ' + ids[i]))).result?.result.status).toBe('confirmed');
  }
  expect((await s.dispatch(text('member-b', 'foreign', '查询 ' + ids[0]))).result?.result.status).toBe('not-found');
  expect((await s.dispatch(text('member-c', 'task', '查询任务 marketing ' + 'a'.repeat(64)))).result?.result.taskStatus).toBe('not-found');
  for (const p of people) {
    const summary = await s.dispatch(text(p.memberId, 'summary-' + p.accountId, '经营汇总 2026-10-20 本月'));
    expect(summary.result?.result.status).toBe('summary');
    const id = summary.result!.result.snapshotId!;
    const owner = {accountId: p.accountId, actor: s.actor(p.accountId)};
    expect(s.artifacts.read(owner, id)?.salesCents).toBe(p.accountId === 'c' ? 10000 : 20000);
    const file = await s.dispatch(text(p.memberId, 'export-' + p.accountId, '导出Excel ' + id));
    expect(file.result?.delivery?.state).toBe('accepted');
    expect(Buffer.from(s.artifacts.artifact(owner, id)!.bytes.subarray(0, 2)).toString()).toBe('PK');
    expect(s.offline.sent.at(-1)?.body).toMatchObject({chatid: p.memberId, msgtype: 'file', chat_type: 1, file: {media_id: 'synthetic-media'}});
    const count = s.offline.sent.length;
    expect((await s.dispatch(text(p.memberId, 'summary-query-' + p.accountId, '查询汇总 ' + id))).result?.result.status).toBe('summary');
    expect(s.offline.sent.length).toBe(count + 1);
    expect(s.offline.sent.at(-1)?.body.msgtype).toBe('stream');
  }
  expect(s.offline.sent[0]).toMatchObject({cmd: 'aibot_respond_msg', headers: {req_id: 'req-report-a'}, body: {msgtype: 'stream_with_template_card'}});
  expect(s.offline.connect).not.toHaveBeenCalled();
});

it('requires a fresh authentication and rejects malformed, mismatched and unmapped events without business writes', async () => {
  const s = setup();
  expect((await s.dispatch(text('member-a', 'initial'))).detail).toBe('not_authenticated');
  s.offline.authenticate();
  const invalid = [text('unknown', 'unknown'), text('member-a', 'wrong-bot'), text('member-a', 'wrong-corp'), text('member-a', 'group'), text('member-a', 'missing-single')];
  invalid[1]!.body.aibotid = 'foreign'; invalid[2]!.body.from.corpid = 'foreign'; invalid[3]!.body.chattype = 'group'; Reflect.deleteProperty(invalid[4]!.body, 'chattype');
  for (const frame of invalid) expect((await s.dispatch(frame)).state).toBe('rejected');
  expect(s.offline.sent).toEqual([]);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(s.ledger.summary(s.actor('a'), '2026-10-20', 'month').salesCents).toBeNull();
  s.grants.change('admin', {accountId: 'a', storeId: 'store-c', roles: ['manager'], active: true, expectedVersion: 1, requestKey: 'move'});
  expect((await s.dispatch(text('member-a', 'cross-store'))).state).toBe('rejected');
  expect(s.offline.sent).toEqual([]);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(JSON.stringify(s.outcomes)).not.toContain('secret_binding_error');
});

it.each(['connected', 'disconnected', 'reconnecting', 'error', 'kicked'] as const)('invalidates an in-flight reader on %s; old epoch cannot send or write after reauthentication', async kind => {
  const s = setup(); s.offline.authenticate();
  let release!: () => void;
  const wait = new Promise<void>(resolve => {release = resolve;});
  s.readNative.mockImplementationOnce(async accountId => {await wait; return {user: {id: accountId, role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-' + accountId};});
  s.offline.frame(text('member-a', 'late')); await vi.waitFor(() => expect(s.readNative).toHaveBeenCalled());
  if (kind === 'kicked') s.offline.frame({cmd: 'aibot_event_callback', headers: {req_id: 'kick'}, body: {msgtype: 'event', event: {eventtype: 'disconnected_event'}}});
  else s.offline.lifecycle(kind);
  s.offline.authenticate(); release(); await s.app.idle();
  expect(s.offline.sent).toEqual([]);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(s.outcomes.at(-1)?.state).toBe('rejected');
  expect((await s.dispatch(text('member-b', 'new-session'))).result?.result.status).toBe('pending');
});

it('bounds concurrency, snapshots frames, contains observer errors and only closes owned resources', async () => {
  const s = setup({maxInFlight: 1}); s.offline.authenticate();
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  s.readBinding.mockImplementationOnce(async subject => {await wait; return {botId: 'bot', corpId: 'corp', memberId: subject.memberId, accountId: 'a', active: true, version: 1};});
  const frame = text('member-a', 'snap'); s.offline.frame(frame); frame.body.from.userid = 'member-b'; frame.body.text.content = '本月销售999元';
  s.offline.frame(text('member-c', 'over-capacity'));
  expect(s.outcomes.at(-1)?.detail).toBe('capacity_exceeded');
  release(); await s.app.idle();
  expect(s.outcomes.at(-1)?.result?.result.status).toBe('pending');
  const id = s.outcomes.at(-1)!.result!.result.reportId!;
  expect(s.ledger.getReport(s.actor('a'), id)?.proposed.items[0]?.amountCents).toBe(10000);
  expect(s.ledger.getReport(s.actor('b'), id)).toBeUndefined();
  expect(() => createWecomBotAssembly(s.options)).toThrow('assembly_already_attached');
  const external = vi.fn(); s.offline.client.on('message.text', external);
  s.app.close(); s.app.close();
  s.offline.frame(text('member-a', 'closed')); await s.app.idle();
  expect(external).toHaveBeenCalledTimes(1);
  expect(s.offline.disconnect).not.toHaveBeenCalled();
  expect(s.grants.get('a')?.active).toBe(true);
  expect(s.tasks.get({tenantId: 'tenant', storeId: 'store-b', accountId: 'a', workspaceJid: 'web:home-a', corpId: 'corp', botId: 'bot', memberId: 'member-a', bindingVersion: 1, role: 'marketing'}, 'f'.repeat(64))).toBeUndefined();
  const other = createWecomBotAssembly({...s.options, onOutcome: () => {throw Error('observer_failure');}}); cleanup.push(() => other.close());
  s.offline.authenticate(); s.offline.frame(text('member-b', 'observer')); await other.idle();
  expect(s.offline.sent.at(-1)?.headers.req_id).toBe('req-observer');
});

it('aborts private work at close and request timeout and ignores late reader results', async () => {
  for (const close of [true, false]) {
    const s = setup({requestTimeoutMs: 20}); s.offline.authenticate();
    let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
    s.readBinding.mockImplementationOnce(async subject => {await wait; return {botId: 'bot', corpId: 'corp', memberId: subject.memberId, accountId: 'a', active: true, version: 1};});
    s.offline.frame(text('member-a', 'aborted')); if (close) s.app.close();
    await s.app.idle(); release(); await Promise.resolve();
    expect(s.offline.sent).toEqual([]);
    expect(s.outcomes.at(-1)?.state).toBe('rejected');
  }
});

it('runs actual SDK proactive serialization and media fragmentation only over replaced transport', async () => {
  const s = offlineBotSdk();
  await s.sdk.sendMessage('synthetic-member', {msgtype: 'markdown', markdown: {content: '合成通知'}});
  const media = await s.fileSdk.uploadMedia(Buffer.alloc(512 * 1024 + 1, 7), {type: 'file', filename: 'synthetic.xlsx'});
  expect(media).toMatchObject({type: 'file', media_id: 'synthetic-media'});
  await s.fileSdk.sendMessage('synthetic-member', {msgtype: 'file', chat_type: 1, file: {media_id: 'synthetic-media'}});
  expect(s.sent.map(f => f.cmd)).toEqual(['aibot_send_msg', 'aibot_upload_media_init', 'aibot_upload_media_chunk', 'aibot_upload_media_chunk', 'aibot_upload_media_finish', 'aibot_send_msg']);
  expect(s.sent[0]!.body).toMatchObject({chatid: 'synthetic-member', msgtype: 'markdown'});
  expect(s.sent.at(-1)!.body).toMatchObject({chatid: 'synthetic-member', msgtype: 'file', chat_type: 1});
  expect(s.connect).not.toHaveBeenCalled();
});

it('retains committed business and records an interrupted attempted send as unknown without replaying or accepting its late ACK', async () => {
  const s = setup(); s.offline.authenticate();
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  s.offline.setAcknowledge(async frame => {await wait; return {headers: frame.headers, errcode: 0};});
  const frame = text('member-a', 'send-started'); s.offline.frame(frame);
  await vi.waitFor(() => expect(s.offline.sent).toHaveLength(1));
  const replyId = createHash('sha256').update(JSON.stringify(['corp', 'bot', 'member-a', 'send-started'])).digest('hex');
  const before = s.ledger.getBotReply(s.actor('a'), replyId)!;
  expect(before.delivery.state).toBe('attempting');
  expect(s.ledger.getReport(s.actor('a'), before.reportId!)?.state).toBe('pending');
  s.offline.lifecycle('disconnected'); await s.app.idle();
  expect(s.ledger.getBotReply(s.actor('a'), replyId)?.delivery.state).toBe('unknown');
  release(); await Promise.resolve(); s.offline.authenticate();
  expect((await s.dispatch(frame)).result?.suppressed).toBe(true);
  expect(s.offline.sent).toHaveLength(1);
  expect(s.ledger.getBotReply(s.actor('a'), replyId)?.delivery.state).toBe('unknown');
});

it('uses the task command role while preserving manager-role denial and rejects revocation before reserving business', async () => {
  const s = setup(); s.offline.authenticate();
  s.grants.change('admin', {accountId: 'a', storeId: 'store-b', roles: ['marketing'], active: true, expectedVersion: 1, requestKey: 'marketing-only'});
  expect((await s.dispatch(text('member-a', 'role-query', '查询任务 marketing ' + 'c'.repeat(64)))).result?.result.taskStatus).toBe('not-found');
  const before = s.counts();
  expect((await s.dispatch(text('member-a', 'role-denied'))).state).toBe('rejected');
  expect(s.counts()).toEqual(before);
  let reads = 0;
  s.readNative.mockImplementation(async accountId => {
    if (++reads === 3) s.grants.change('admin', {accountId: 'b', storeId: 'store-b', roles: ['manager'], active: false, expectedVersion: 1, requestKey: 'revoke-b'});
    return {user: {id: accountId, role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-' + accountId};
  });
  expect((await s.dispatch(text('member-b', 'revoked'))).state).toBe('rejected');
  expect(s.counts()).toEqual(before);
});

it.each([
  {requestTimeoutMs: 0}, {requestTimeoutMs: 4001}, {requestTimeoutMs: 1.5},
  {maxInFlight: 0}, {maxInFlight: 1.5}, {maxInFlight: 1025},
])('rejects invalid bounded configuration %j without taking over the SDK', config => {
  const s = setup(); s.app.close();
  expect(() => createWecomBotAssembly({...s.options, ...config})).toThrow('invalid_bot_assembly');
  expect(s.offline.client.listenerCount('message.text')).toBe(0);
  expect(s.offline.connect).not.toHaveBeenCalled();
});

it('does not route unsupported SDK message types and refuses missing single attribution on card events', async () => {
  const s = setup(); s.offline.authenticate();
  s.offline.frame({cmd: 'aibot_msg_callback', headers: {req_id: 'image'}, body: {msgtype: 'image', aibotid: 'bot', msgid: 'image', chattype: 'single', from: {userid: 'member-a'}, image: {url: 'https://example.invalid/synthetic'}}});
  await s.app.idle();
  expect(s.outcomes).toEqual([]);
  const result = (await s.dispatch(text('member-a', 'card-source'))).result!.result;
  const card = result.reply.body.template_card!;
  const count = s.counts(), sends = s.offline.sent.length;
  expect((await s.dispatch({cmd: 'aibot_event_callback', headers: {req_id: 'missing-chat'}, body: {aibotid: 'bot', msgid: 'missing-chat', msgtype: 'event', from: {userid: 'member-a'}, event: {eventtype: 'template_card_event', task_id: card.task_id, event_key: card.button_list[0]!.key}}})).detail).toBe('unsupported_event');
  expect(s.counts()).toEqual(count);
  expect(s.offline.sent.length).toBe(sends);
  expect(s.ledger.getReport(s.actor('a'), result.reportId!)?.state).toBe('pending');
});

it.each([false, true])('captures training enablement (%s) and resolver at assembly creation despite later options mutation', async initiallyEnabled => {
  const s = setup(); s.app.close();
  // Explicit training permission makes this a capability configuration test, not a grant denial.
  s.grants.change('admin', {accountId: 'a', storeId: 'store-b', roles: ['manager', 'marketing', 'training'], active: true, expectedVersion: 1, requestKey: 'training-grant'});
  const originalResolve = vi.fn(() => {throw Error('synthetic_original_service_unavailable');});
  const substitutedResolve = vi.fn(() => {throw Error('late_unapproved_service');});
  const training = {enabled: initiallyEnabled, resolve: originalResolve};
  const app = createWecomBotAssembly({...s.options,
    identity: {...s.options.identity, roles: ['manager', 'marketing', 'training']},
    businesses: s.options.businesses.map(b => ({...b, tasks: {...b.tasks, training}})),
  });
  cleanup.push(() => app.close());
  training.enabled = true; training.resolve = substitutedResolve;
  s.offline.authenticate(); s.offline.frame(text('member-a', 'training-config', '培训问答 指导员 合成问题')); await app.idle();
  expect(s.outcomes.at(-1)?.result?.result.taskStatus).toBe('blocked');
  expect(substitutedResolve).not.toHaveBeenCalled();
  expect(originalResolve).toHaveBeenCalledTimes(initiallyEnabled ? 1 : 0);
});

it('captures Native methods at assembly creation while keeping the shared service lifecycle with its caller', async () => {
  const s = setup(); s.app.close();
  const native = createNativeBotTasks(); cleanup.push(() => native.close());
  const originalStart = vi.fn(async () => ({state: 'linked' as const, referenceId: 'existing-run', detail: 'synthetic_occurrence'}));
  const originalQuery = vi.fn(async () => ({status: 'running', output: null, detail: 'synthetic_query'}));
  const originalCancel = vi.fn(async () => ({state: 'requested' as const, detail: 'synthetic_cancel'}));
  native.start = originalStart; native.query = originalQuery; native.cancel = originalCancel;
  const sharedClose = vi.spyOn(native, 'close');
  const catalog = [{tenantId: 'tenant', storeId: 'store-b', accountId: 'a', homeJid: 'web:home-a', role: 'marketing' as const, alias: 'weekly', taskId: 'existing-task', profileId: 'existing-profile', workspaceJid: 'web:existing-role'}];
  const app = createWecomBotAssembly({...s.options, businesses: s.options.businesses.map(b => ({...b, tasks: {...b.tasks, catalog, native}}))});
  cleanup.push(() => app.close());
  const substitutedStart = vi.fn(async () => ({state: 'blocked' as const, detail: 'late_unapproved_start'}));
  const substitutedQuery = vi.fn(async () => ({status: 'unknown', output: null, detail: 'late_unapproved_query'}));
  const substitutedCancel = vi.fn(async () => ({state: 'blocked' as const, detail: 'late_unapproved_cancel'}));
  native.start = substitutedStart; native.query = substitutedQuery; native.cancel = substitutedCancel;
  s.offline.authenticate();
  s.offline.frame(text('member-a', 'native-start', '执行任务 marketing weekly')); await app.idle();
  const result = s.outcomes.at(-1)!.result!.result;
  expect(result.taskStatus).toBe('running');
  s.offline.frame(text('member-a', 'native-query', '查询任务 marketing ' + result.taskId)); await app.idle();
  s.offline.frame(text('member-a', 'native-cancel', '取消任务 marketing ' + result.taskId)); await app.idle();
  expect(s.outcomes.at(-1)?.result?.result.reply.body.stream.content).toContain('取消请求：已受理');
  expect(originalStart).toHaveBeenCalledTimes(1); expect(originalQuery).toHaveBeenCalledTimes(3); expect(originalCancel).toHaveBeenCalledTimes(1);
  expect(substitutedStart).not.toHaveBeenCalled(); expect(substitutedQuery).not.toHaveBeenCalled(); expect(substitutedCancel).not.toHaveBeenCalled();
  app.close(); expect(sharedClose).not.toHaveBeenCalled();
});

it('registers the original write ticket before async authority and rechecks inside the original grant transaction', async () => {
  const s = setup(); s.app.close();
  let phase: 'ready' | 'paused' = 'ready', entered = 0;
  const finished = vi.fn();
  const boundary: WecomBotExecutionBoundary = {
    admit: () => phase === 'ready',
    enter: () => ({id: String(++entered)}),
    check: () => phase === 'ready',
    close: finished,
  };
  const originalWithCurrent = s.grants.withCurrent.bind(s.grants);
  vi.spyOn(s.grants, 'withCurrent').mockImplementation((grant, work) => {
    phase = 'paused';
    return originalWithCurrent(grant, work);
  });
  const app = createWecomBotAssembly({...s.options, executionBoundary: boundary}); cleanup.push(() => app.close());
  s.offline.authenticate();
  s.offline.frame(text('member-a', 'gate-revoked-before-write'));
  await app.idle();
  expect(entered).toBe(1);
  expect(finished).toHaveBeenCalledTimes(1);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(s.offline.sent).toEqual([]);
  expect(s.outcomes.at(-1)).toMatchObject({state: 'rejected', detail: 'input_not_accepted'});
});

it.each(['timeout', 'close'] as const)('retains the gate write ticket until a late original binding read physically settles after %s', async kind => {
  const s = setup(); s.app.close(); s.offline.lifecycle('disconnected');
  let release!: () => void;
  const suspended = new Promise<void>(resolve => {release = resolve;});
  s.readBinding.mockImplementationOnce(async subject => {
    await suspended;
    return {botId: 'bot', corpId: 'corp', memberId: subject.memberId, accountId: 'a', active: true, version: 1};
  });
  let phase: 'paused' | 'ready' = 'ready', issued = 0;
  const finishWrite = vi.fn();
  const gate = {phase: () => phase, noteArrival: vi.fn(),
    beginWrite: () => phase === 'ready' ? {id: String(++issued)} : null,
    finishWrite};
  let currentApp: ReturnType<typeof createWecomBotAssembly> | undefined;
  const preparation = createWecomBotPreparation({mode: 'isolated-synthetic', createClient: () => s.offline.client,
    connect: () => {s.offline.authenticate();},
    disconnect: () => {s.offline.lifecycle('disconnected');},
    assemble: (client, executionBoundary) => {
      currentApp = createWecomBotAssembly({...s.options, client, executionBoundary, requestTimeoutMs: kind === 'timeout' ? 15 : 200});
      return currentApp;
    },
    gate, readFingerprint: () => ({botId: 'bot', corpId: 'corp', ownerId: 'owner', configVersion: '1', credentialFingerprint: 'synthetic', workspaceFingerprint: 'synthetic'}), timeoutMs: 40});
  cleanup.push(() => {void preparation.close();});
  await preparation.prepare(); expect(preparation.activate()).toBe(true);
  s.offline.frame(text('member-a', 'physically-pending-' + kind));
  await vi.waitFor(() => expect(s.readBinding).toHaveBeenCalled());
  if (kind === 'timeout') await vi.waitFor(() => expect(s.outcomes.at(-1)?.state).toBe('rejected'));
  else phase = 'paused';
  const closing = preparation.close();
  await closing;
  expect(preparation.status()).toBe('cleanup_unknown');
  expect(issued).toBe(1);
  expect(finishWrite).not.toHaveBeenCalled();
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(s.offline.sent).toEqual([]);
  release();
  await currentApp!.idle();
  expect(finishWrite).toHaveBeenCalledTimes(1);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(s.offline.sent).toEqual([]);
});
