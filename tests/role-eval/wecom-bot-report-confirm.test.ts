import {afterEach, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {BotPendingReports} from '../../src/role-eval/wecom-bot-task-store.js';
import {SUMMARY_DENIED} from '../../src/role-eval/wecom-bot-report-tools.js';
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
  const safe=(f:()=>void)=>()=>{try{f();}catch{}};
  cleanup.push(safe(() => grants.close()), safe(() => ledger.close()), safe(() => tasks.close()));
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
  return {app, offline, options, outcomes, dispatch, ledger, grants, tasks, actor, readBinding, readNative, counts, artifacts, factFile};
}
void createHash;
const body=(s:ReturnType<typeof setup>)=>JSON.stringify(s.offline.sent.at(-1)?.body);
function withConversations(s:ReturnType<typeof setup>,extra:Record<string,unknown>={},noArtifacts=false){
 s.app.close();const submitted:{role:string}[]=[];
 const app=createWecomBotAssembly({...s.options,businesses:s.options.businesses.map(b=>({...b,...(noArtifacts?{artifacts:undefined}:{}),conversations:{...extra,store:s.tasks,native:{
  async readRoleWorkspace(input:{actor:{accountId:string;role:string}}){return {state:'ready' as const,workspaceJid:'web:'+input.actor.role+'-'+input.actor.accountId,profileId:'profile-'+input.actor.role,ownerAccountId:input.actor.accountId,storeId:'store-b',role:input.actor.role as 'marketing'};},
  async prepareRoleWorkspace(){throw Error('unexpected_create');}},
  intake:{async readReceipt(){return undefined;},async submitMessage(input:any){submitted.push({role:input.target.role});return {...input.target,receiptId:input.receiptId,messageId:input.originMessageId,fingerprint:input.fingerprint,state:'accepted' as const,acceptedAt:''};}}}}))});
 cleanup.push(()=>app.close());s.offline.authenticate();
 const send=async(id:string,content:string)=>{s.offline.frame(text('member-a',id,content));await app.idle();return s.outcomes.at(-1)!;};
 return {app,submitted,send};
}
it('sends ordinary text from a manager to the conversation (default marketing), not to reporting',async()=>{
 const s=setup(),c=withConversations(s);
 await c.send('plain-1','帮我写一条周末活动文案');
 expect(c.submitted.map(x=>x.role)).toEqual(['marketing']);expect(s.counts().reports).toBe(0);expect(body(s)).not.toContain('岗位 内容营销（或其他');
});
it('echoes a complete report without saving until 确认, and 改 corrects it',async()=>{
 const s=setup(),c=withConversations(s);
 const first=(await c.send('r-1','本月销售100元')).result!.result;
 expect(first.status).toBe('pending');expect(body(s)).toContain('本月销售 100 元，对吗？回「对」保存，回「改」修改');const echo=String(JSON.parse(body(s)).stream.content);for(const internal of ['期间快照','查回','报告编号',first.reportId!])expect(echo).not.toContain(internal);expect(echo).not.toMatch(/[a-f0-9]{16}/);
 expect(s.ledger.getReport(s.actor('a'),first.reportId!)?.state).toBe('pending');expect(c.submitted).toHaveLength(0);
 // Chatting about something else keeps the pending report open.
 await c.send('r-chat','帮我写一条朋友圈');expect(c.submitted).toHaveLength(1);
 const fixed=(await c.send('r-2','改 本月销售200元')).result!.result;
 expect(fixed.status).toBe('pending');expect(fixed.reportId).not.toBe(first.reportId);
 expect(s.ledger.getReport(s.actor('a'),first.reportId!)?.state).toBe('pending');
 const done=(await c.send('r-3','确认')).result!.result;
 expect(done.status).toBe('confirmed');expect(done.reportId).toBe(fixed.reportId);
 expect(s.ledger.getReport(s.actor('a'),fixed.reportId!)?.entries[0]?.amountCents).toBe(20000);
 expect(s.ledger.getReport(s.actor('a'),first.reportId!)?.state).toBe('pending');
 // 确认 with nothing pending does not save anything.
 const again=(await c.send('r-4','确认')).result!.result;expect(again.status).not.toBe('confirmed');
});
it('re-parses directly resent corrected numbers and records a post-confirmation edit as history',async()=>{
 const s=setup(),c=withConversations(s);
 await c.send('h-1','本月销售100元');await c.send('h-2','本月销售300元');
 const done=(await c.send('h-3','对')).result!.result;expect(done.status).toBe('confirmed');
 expect(s.ledger.getReport(s.actor('a'),done.reportId!)?.entries[0]?.amountCents).toBe(30000);
 await c.send('h-4','本月销售400元');expect(body(s)).toContain('会把已保存的 300 元 改成 400 元');
 const edited=(await c.send('h-5','确认')).result!.result;expect(edited.status).toBe('confirmed');
 // The earlier confirmed entry is kept as superseded history, never silently overwritten.
 expect(s.ledger.supersededEntryIds(s.actor('a'),done.reportId!).length).toBe(1);
 expect(s.ledger.getReport(s.actor('a'),edited.reportId!)?.entries[0]?.amountCents).toBe(40000);
});
it('sends an incomplete report to the conversation',async()=>{
 const s=setup(),c=withConversations(s);
 await c.send('inc-1','今天销售还行，客人不少');
 expect(c.submitted).toHaveLength(1);expect(s.counts().reports).toBe(0);
});
it('refuses a summary to a non-manager politely and allows it for a manager',async()=>{
 const s=setup();s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing'],active:true,expectedVersion:1,requestKey:'marketing-only'});
 const c=withConversations(s);
 const denied=await c.send('sum-1','经营汇总 2026-10-20 本月');expect(denied.state).toBe('handled');expect(body(s)).toContain(SUMMARY_DENIED);
 // Reporting still works for the non-manager.
 expect((await c.send('sum-2','本月销售100元')).result!.result.status).toBe('pending');
 const m=setup(),cm=withConversations(m);
 expect((await cm.send('sum-3','经营汇总 2026-10-20 本月')).result!.result.status).toBe('summary');
});
it('shows 未开始 for a zero target and hides the rate and gap',async()=>{
 const s=setup(),c=withConversations(s);
 await c.send('t-1','本月目标0元');expect(body(s)).toContain('未开始');
 expect((await c.send('t-2','确认')).result!.result.status).toBe('confirmed');
 for(const [id,content] of [['t-b1','本月目标0元'],['t-b2','确认']] as const){s.offline.frame(text('member-b',id,content));await c.app.idle();}
 expect(s.outcomes.at(-1)?.result?.result.status).toBe('confirmed');
 await c.send('t-3','经营汇总 2026-10-20 本月');
 const out=body(s);expect(out).toContain('目标：未开始');expect(out).not.toContain('达成率');expect(out).not.toContain('差额');
});
it('still refuses unbound and ungranted users',async()=>{
 const s=setup(),c=withConversations(s);
 s.offline.frame(text('member-x','unbound','本月销售100元'));await c.app.idle();expect(s.outcomes.at(-1)?.state).toBe('rejected');
 s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing'],active:false,expectedVersion:1,requestKey:'revoke'});
 expect((await c.send('ungranted','本月销售100元')).state).toBe('rejected');expect(s.counts().reports).toBe(0);
});
it('sweeps pending reports: one reminder after 30 minutes, expiry at the end of the business day',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const p=new BotPendingReports(path.join(dir,'f.sqlite'));cleanup.push(()=>p.closeStore());
 const owner={tenant:'t',store:'s',workspace:'w',employeeId:'e',corpId:'c',botId:'b',memberId:'m',accountId:'a'};
 const H=(v:string)=>createHash('sha256').update(v).digest('hex');
 const t0=new Date('2026-10-20T02:00:00Z');// 10:00 Asia/Shanghai
 p.open(owner,{id:H('r1'),hash:H('h1')},t0);
 expect(p.sweep(new Date(t0.getTime()+10*60e3))).toEqual([]);
 const remind=p.sweep(new Date(t0.getTime()+31*60e3));expect(remind.map(a=>a.kind)).toEqual(['remind']);
 expect(p.sweep(new Date(t0.getTime()+60*60e3))).toEqual([]);
 expect(p.current(owner,new Date(t0.getTime()+60*60e3))?.reportId).toBe(H('r1'));
 const expire=p.sweep(new Date('2026-10-20T16:00:00Z'));// next day 00:00 Asia/Shanghai
 expect(expire.map(a=>a.kind)).toEqual(['expire']);expect(expire[0]!.message).toContain('重新发送');
 expect(p.current(owner,new Date('2026-10-20T16:00:00Z'))).toBeUndefined();
 expect(p.history(owner).map(r=>r.state)).toContain('expired');
 // A new report replaces the previous pending pointer and keeps it in history.
 p.open(owner,{id:H('r2'),hash:H('h2')},t0);p.open(owner,{id:H('r3'),hash:H('h3')},t0);
 expect(p.current(owner,t0)?.reportId).toBe(H('r3'));expect(p.history(owner).map(r=>r.state)).toContain('replaced');
});

// ---- follow-ups: model tool calling for vague reports, read-only pilot summary, sweeper, restart ----
import {createModelReportExtractor,validateExtractedReport,readReportToolCall,REPORT_NUMBERS_TOOL,type BotReportExtractor} from '../../src/role-eval/wecom-bot-report-model.js';
import {startPendingReportSweeper} from '../../src/role-eval/wecom-bot-task-store.js';
it('extracts a vague report through the model tool, then uses the same pending echo and 确认 flow',async()=>{
 const calls:{text:string;date:string}[]=[];
 const extractor:BotReportExtractor=async input=>{calls.push({text:input.text,date:input.date});return [{kind:'sales',start:input.date,end:input.date,amountYuan:'3500'}];};
 const s=setup({requestTimeoutMs:10000}),c=withConversations(s,{reportExtractor:extractor});
 const first=(await c.send('m-1','今天卖了三千五左右吧')).result!.result;
 expect(calls).toEqual([{text:'今天卖了三千五左右吧',date:'2026-10-20'}]);// business day of the message create_time
 expect(first.status).toBe('pending');expect(body(s)).toContain('今天销售 3,500 元，对吗？回「对」保存');expect(c.submitted).toHaveLength(0);
 expect(s.ledger.getReport(s.actor('a'),first.reportId!)?.state).toBe('pending');
 const done=(await c.send('m-2','确认')).result!.result;
 expect(done.status).toBe('confirmed');expect(done.reportId).toBe(first.reportId);
 expect(s.ledger.getReport(s.actor('a'),done.reportId!)?.entries[0]?.amountCents).toBe(350000);
 // A complete report still takes the fast path without calling the model.
 await c.send('m-3','本月销售100元');expect(calls).toHaveLength(1);
});
it('rejects invalid or failed model extraction and falls back to the conversation without saving',async()=>{
 for(const extractor of [async()=>[{kind:'sales' as const,start:'2026-10-21',end:'2026-10-20',amountYuan:'10'}],async()=>[{kind:'sales' as const,start:'2026-10-20',end:'2026-10-20',amountYuan:'三千'}],async()=>undefined,async()=>{throw Error('model_down');}] as BotReportExtractor[]){
  const s=setup({requestTimeoutMs:10000}),c=withConversations(s,{reportExtractor:extractor});
  await c.send('bad-1','今天业绩还不错');
  expect(c.submitted).toHaveLength(1);expect(s.counts().reports).toBe(0);
 }
 // Non-report chat never reaches the model.
 const spy=vi.fn(async()=>undefined);const s=setup({requestTimeoutMs:10000}),c=withConversations(s,{reportExtractor:spy});
 await c.send('chat-1','帮我写一条周末活动文案');expect(spy).not.toHaveBeenCalled();
});
it('validates model fields with parseStaffReport and calls the model with a forced report_numbers tool',async()=>{
 expect(validateExtractedReport([{kind:'sales',start:'2026-10-01',end:'2026-10-31',amountYuan:'1200.5'},{kind:'target',start:'2026-10-01',end:'2026-10-31',amountYuan:'5000'}],'2026-10-20')).toBe('2026-10-01至2026-10-31销售成交1200.5元；2026-10-01至2026-10-31目标5000元');
 expect(validateExtractedReport([{kind:'sales',start:'2026-10-20',end:'2026-10-20',amountYuan:'50',increment:true}],'2026-10-20')).toContain('新增成交');
 expect(validateExtractedReport([{kind:'target',start:'2026-10-20',end:'2026-10-20',amountYuan:'50',increment:true}],'2026-10-20')).toBeUndefined();
 expect(validateExtractedReport([{kind:'sales',start:'2026-13-01',end:'2026-13-02',amountYuan:'5'}],'2026-10-20')).toBeUndefined();
 expect(validateExtractedReport([],'2026-10-20')).toBeUndefined();
 let seen:any;const key='test-key-not-real';
 const fetch=vi.fn(async(url:string,init:any)=>{seen={url,headers:init.headers,body:JSON.parse(init.body)};return new Response(JSON.stringify({content:[{type:'tool_use',name:'report_numbers',input:{items:[{kind:'sales',start:'2026-10-20',end:'2026-10-20',amount_yuan:'3500'}]}}]}),{status:200});});
 const extract=createModelReportExtractor({baseUrl:'https://example.invalid/anthropic',model:'m',readApiKey:()=>key,fetch:fetch as any});
 expect(await extract({text:'今天卖了三千五',date:'2026-10-20',signal:new AbortController().signal})).toEqual([{kind:'sales',start:'2026-10-20',end:'2026-10-20',amountYuan:'3500'}]);
 expect(seen.url).toBe('https://example.invalid/anthropic/v1/messages');expect(seen.headers['x-api-key']).toBe(key);
 expect(seen.body.tool_choice).toEqual({type:'tool',name:'report_numbers'});expect(seen.body.tools[0].name).toBe(REPORT_NUMBERS_TOOL.name);
 const failing=createModelReportExtractor({baseUrl:'https://example.invalid',model:'m',readApiKey:()=>key,fetch:(async()=>new Response('no',{status:500})) as any});
 expect(await failing({text:'今天卖了三千五',date:'2026-10-20',signal:new AbortController().signal})).toBeUndefined();
 const aborted=new AbortController();aborted.abort();
 const hanging=createModelReportExtractor({baseUrl:'https://example.invalid',model:'m',readApiKey:()=>key,fetch:((_u:string,i:any)=>new Promise((_r,j)=>{if(i.signal.aborted)j(i.signal.reason);i.signal.addEventListener('abort',()=>j(i.signal.reason));})) as any});
 expect(await hanging({text:'今天卖了三千五',date:'2026-10-20',signal:aborted.signal})).toBeUndefined();
 expect(readReportToolCall({content:[{type:'text',text:'x'}]})).toBeUndefined();
});
it('pilot mode: managers get a read-only summary of confirmed reports only; export stays disabled',async()=>{
 const s=setup(),c=withConversations(s,{summaryReadOnly:true},true);
 for(const [id,content] of [['ro-b1','本月目标0元'],['ro-b2','确认']] as const){s.offline.frame(text('member-b',id,content));await c.app.idle();}
 await c.send('ro-1','2026-10-01至2026-10-31销售100元');
 const before=(await c.send('ro-2','经营汇总 2026-10-20 本月')).result!.result;
 expect(before.status).toBe('summary');expect(before.snapshotId).toBeUndefined();
 const out1=body(s);expect(out1).toContain('只读');expect(out1).not.toContain('100.00元');expect(out1).not.toContain('导出Excel');expect(out1).not.toContain('快照编号');
 await c.send('ro-3','2026-10-01至2026-10-31销售100元');await c.send('ro-4','确认');
 await c.send('ro-5','经营汇总 2026-10-20 本月');expect(body(s)).toContain('100.00元');
 await c.send('ro-6','导出Excel '+'a'.repeat(64));expect(body(s)).toContain('暂不可用');expect(s.offline.sent.some((m:any)=>JSON.stringify(m).includes('xlsx'))).toBe(false);
 // Zero target shows 未开始.
 await c.send('ro-7','本月目标0元');await c.send('ro-8','确认');await c.send('ro-9','经营汇总 2026-10-20 本月');
 expect(body(s)).toContain('目标：未开始');
 // Non-managers are refused.
 const m=setup();m.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing'],active:true,expectedVersion:1,requestKey:'mk'});
 const cm=withConversations(m,{summaryReadOnly:true},true);await cm.send('ro-x','经营汇总 2026-10-20 本月');expect(body(m)).toContain(SUMMARY_DENIED);
});
it('sweeps with conditional updates: duplicate scans and two processes never double-remind or double-void',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-dup-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'f.sqlite'),p1=new BotPendingReports(file),p2=new BotPendingReports(file);cleanup.push(()=>p1.closeStore(),()=>p2.closeStore());
 const owner={tenant:'t',store:'s',workspace:'w',employeeId:'e',corpId:'c',botId:'b',memberId:'m',accountId:'a'};
 const H=(v:string)=>createHash('sha256').update(v).digest('hex'),t0=new Date('2026-10-20T02:00:00Z');
 p1.open(owner,{id:H('r1'),hash:H('h1')},t0);
 const at=new Date(t0.getTime()+31*60e3);
 expect([...p1.sweep(at),...p2.sweep(at),...p1.sweep(at)].map(a=>a.kind)).toEqual(['remind']);
 const end=new Date('2026-10-20T16:00:00Z');
 expect([...p2.sweep(end),...p1.sweep(end)].map(a=>a.kind)).toEqual(['expire']);
 expect(p1.history(owner).map(r=>r.state)).toEqual(['pending','pending','expired']);
 // An already closed report cannot be closed again.
 expect(p2.close(owner,H('r1'),'confirmed',end)).toBeUndefined();
});
it('runs the sweeper on an overridable interval and end hour, skipping while inactive',async()=>{
 vi.useFakeTimers();
 try{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-timer-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const p=new BotPendingReports(path.join(dir,'f.sqlite'));cleanup.push(()=>p.closeStore());
  const owner={tenant:'t',store:'s',workspace:'w',employeeId:'e',corpId:'c',botId:'b',memberId:'m',accountId:'a'};
  const H=(v:string)=>createHash('sha256').update(v).digest('hex');let clock=new Date('2026-10-20T02:00:00Z');
  p.open(owner,{id:H('r1'),hash:H('h1')},clock);p.open({...owner,botId:'other'},{id:H('r2'),hash:H('h2')},clock);
  let live=false;const delivered:string[]=[];
  const sw=startPendingReportSweeper({store:p,intervalMs:60_000,endHour:12,now:()=>clock,shouldRun:()=>live,filter:o=>o.botId==='b',deliver:a=>{delivered.push(a.kind+':'+a.record.owner.memberId);}});
  expect(sw.intervalMs).toBe(60_000);
  clock=new Date('2026-10-20T02:31:00Z');await vi.advanceTimersByTimeAsync(60_000);expect(delivered).toEqual([]);// inactive: no state change
  live=true;await vi.advanceTimersByTimeAsync(60_000);expect(delivered).toEqual(['remind:m']);
  await vi.advanceTimersByTimeAsync(120_000);expect(delivered).toEqual(['remind:m']);
  clock=new Date('2026-10-20T04:00:00Z');// 12:00 Asia/Shanghai == overridden end of business day
  await vi.advanceTimersByTimeAsync(60_000);expect(delivered).toEqual(['remind:m','expire:m']);
  await sw.stop();await vi.advanceTimersByTimeAsync(600_000);expect(delivered).toHaveLength(2);
  expect(p.current({...owner,botId:'other'},clock)?.reportId).toBe(H('r2'));// other bot untouched
  expect(()=>startPendingReportSweeper({store:p,intervalMs:0,deliver:()=>{}})).toThrow('invalid_pending_sweeper');
 }finally{vi.useRealTimers();}
});
it('keeps a pending report confirmable with history intact after a process restart on the same volume',async()=>{
 const s=setup(),c=withConversations(s);
 const first=(await c.send('rs-1','本月销售100元')).result!.result;expect(first.status).toBe('pending');
 c.app.close();s.tasks.close();s.ledger.close();
 const L2=new ManagerStore(s.factFile),T2=new BotTaskStore(s.factFile);cleanup.push(()=>{try{L2.close();}catch{}},()=>{try{T2.close();}catch{}});
 const s2={...s,ledger:L2,tasks:T2,app:{close(){}} as any,options:{...s.options,businesses:s.options.businesses.map(b=>({...b,ledger:L2,tasks:{store:T2,catalog:[]}}))}};
 const c2=withConversations(s2 as any);
 const done=(await c2.send('rs-2','确认')).result!.result;
 expect(done.status).toBe('confirmed');expect(done.reportId).toBe(first.reportId);
 expect(L2.getReport(s.actor('a'),first.reportId!)?.entries[0]?.amountCents).toBe(10000);
 const owner=T2.pendingReports!.history;expect(typeof owner).toBe('function');
 const db=new DatabaseSync(s.factFile,{readOnly:true});
 try{const states=(db.prepare('SELECT body FROM bot_pending_report_history ORDER BY id').all() as {body:string}[]).map(r=>JSON.parse(r.body).state);expect(states).toEqual(['pending','confirmed']);}finally{db.close();}
});
