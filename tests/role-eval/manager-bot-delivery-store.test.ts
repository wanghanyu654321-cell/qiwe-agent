import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {ManagerStore,type BotReplyReservation,type BotReplySeed,type DeliveryOutcome,type StaffContext} from '../../src/role-eval/manager-store.js';

const actor:StaffContext={tenant:'synthetic',store:'store',workspace:'workspace',employeeId:'employee',employeeName:'Employee'};
const target={corpId:'corp',botId:'bot',memberId:'member',accountId:'account',workspaceJid:'workspace',storeId:'store',bindingVersion:1};
const source={kind:'wecom-bot' as const,...target,messageId:'platform-message'};
const dirs:string[]=[],stores:ManagerStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function open(file?:string){if(!file){const dir=mkdtempSync(join(tmpdir(),'bot-delivery-'));dirs.push(dir);file=join(dir,'reports.sqlite');}const s=new ManagerStore(file);stores.push(s);return {s,file};}
function seed(key='a',reqId='req-1'):BotReplySeed{return {id:key.repeat(64),fingerprint:'f'.repeat(64),target:{...target},reply:{reqId,body:{msgtype:'stream',stream:{id:'stream-id',finish:true,content:'Synthetic reply'}}}};}
function confirmed(s:ManagerStore){const report=s.receiveBot(actor,'original','今天销售成交1.23元','2026-10-17',source);return s.confirm(actor,report.id,report.hash,report.proposed.items);}
function linked(s:ManagerStore){const report=confirmed(s),input={...seed(),reportId:report.id,confirmation:{reportId:report.id,deliveryId:report.delivery!.id}};return {report,input};}
const outcome=(state:DeliveryOutcome['state']='accepted'):DeliveryOutcome=>({state,apiErrorCode:state==='accepted'?0:null,msgid:null,detail:'synthetic_result',...(state==='accepted'?{ackReqId:'req-1'}:{})});
const reservation=(input=seed()):BotReplyReservation=>({id:input.id,fingerprint:input.fingerprint,target:{...input.target},reqId:input.reply.reqId});
it('persists a private dedicated card update without widening its target or replacing the report text',()=>{
 const {s,file}=open(),input=seed();
 input.reply.update={memberId:target.memberId,card:{card_type:'button_interaction',task_id:'report-'+'a'.repeat(64)+'-'+'b'.repeat(32),main_title:{title:'已入账，可查回',desc:'请查询原报告'},button_list:[{text:'核对结果',key:'confirm:'+'c'.repeat(64),style:1}]}};
 const wrong=structuredClone(input);wrong.reply.update!.memberId='foreign';expect(()=>s.prepareBotReply(actor,wrong)).toThrow('invalid_bot_reply');
 const extra=structuredClone(input);Object.assign(extra.reply.update!,{userids:[]});expect(()=>s.prepareBotReply(actor,extra)).toThrow('invalid_bot_reply');
 s.prepareBotReply(actor,input);input.reply.update.card.task_id='mutated';const saved=open(file).s.getBotReply(actor,input.id)!;
 expect(saved.reply.update?.memberId).toBe(target.memberId);expect(saved.reply.update?.card.task_id).toMatch(/^report-a{64}-b{32}$/);expect(saved.reply.body.stream.content).toBe('Synthetic reply');
 const claim=s.claimBotReply(actor,input.id)!;s.finishBotReply(actor,claim.id,claim.delivery.id,claim.delivery.attempt,outcome('unknown'));
 expect(open(file).s.claimBotReply(actor,input.id)).toBeUndefined();
});
// Workers execute the current source, independently of a previous dist build.
function storeModule(){
 const compile=(source:string)=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
 const report=compile(readFileSync(fileURLToPath(new URL('../../src/role-eval/manager-report.ts',import.meta.url)),'utf8'));
 return compile(readFileSync(fileURLToPath(new URL('../../src/role-eval/manager-store.ts',import.meta.url)),'utf8').replace("'./manager-report.js'",JSON.stringify(report)));
}
async function race(file:string,operations:({kind:'event';id:string}|{kind:'return';id:string}|{kind:'prepare';seed:BotReplySeed}|{kind:'reserve';reservation:BotReplyReservation})[]){
 const gate=new SharedArrayBuffer(4),moduleUrl=storeModule();
 const workers=operations.map(op=>new Worker(`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {ManagerStore}=await import(workerData.moduleUrl);const s=new ManagerStore(workerData.file);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.gate),0,0);try{const o=workerData.op;const value=o.kind==='reserve'?(s.reserveBotReply(workerData.actor,o.reservation),true):o.kind==='event'?s.claimBotReply(workerData.actor,o.id):o.kind==='return'?s.claimReturn(workerData.actor,o.id):s.prepareBotReply(workerData.actor,o.seed);parentPort.postMessage({claimed:!!value});}catch(e){parentPort.postMessage({error:e.message});}finally{s.close();}})().catch(e=>{throw e;});`,{eval:true,workerData:{file,actor,op,gate,moduleUrl}}));
 try{
  await Promise.all(workers.map(w=>new Promise<void>((resolve,reject)=>{w.once('message',()=>resolve());w.once('error',reject);})));
  const results=workers.map(w=>new Promise<{claimed?:boolean;error?:string}>((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);}));
  Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
  return await Promise.all(results);
 }finally{await Promise.all(workers.map(w=>w.terminate()));}
}

describe('business-before-reply event reservation',()=>{
 it('fixes the first fingerprint without exposing or claiming an unfinished plan',()=>{
  const {s,file}=open(),input=reservation();expect(s.reserveBotReply(actor,input)).toBe(false);
  expect(s.getBotReply(actor,input.id)).toBeUndefined();expect(s.claimBotReply(actor,input.id)).toBeUndefined();
  const second=open(file).s;
  expect(second.reserveBotReply(actor,input)).toBe(true);
  expect(()=>second.reserveBotReply(actor,{...input,fingerprint:'b'.repeat(64)})).toThrow('bot_reply_conflict');
  expect(()=>second.prepareBotReply(actor,{...seed(),fingerprint:'b'.repeat(64)})).toThrow('bot_reply_conflict');
  expect(s.getBotReply(actor,input.id)).toBeUndefined();expect(s.list(actor)).toEqual([]);
 });
 it('reopens an unfinished reservation and upgrades only its matching owner into the first complete intent',()=>{
  const {s,file}=open(),input=reservation();s.reserveBotReply(actor,input);input.target.memberId='mutated';
  const second=open(file).s;s.close();stores.splice(stores.indexOf(s),1);
  for(const patch of [{tenant:'other'},{store:'other'},{workspace:'other'},{employeeId:'other'}])expect(()=>second.reserveBotReply({...actor,...patch},reservation())).toThrow('bot_reply_conflict');
  expect(()=>second.reserveBotReply(actor,{...reservation(),target:{...target,accountId:'other'}})).toThrow('bot_reply_conflict');
  second.reserveBotReply({...actor,employeeName:'Renamed'},reservation(seed('a','req-reopened')));
  const {input:linkedInput}=linked(second),completed=second.prepareBotReply(actor,{...linkedInput,reply:{...linkedInput.reply,reqId:'req-reopened'}});
  expect(completed).toMatchObject({actor,confirmation:linkedInput.confirmation,reportId:linkedInput.reportId,reply:{reqId:'req-reopened'},delivery:{state:'prepared',attempt:0}});
  const claim=second.claimBotReply(actor,completed.id)!;expect(claim.reportAttempt).toBe(1);
  expect(second.finishBotReply(actor,completed.id,claim.delivery.id,1,outcome())?.delivery.state).toBe('accepted');
 });
 it('includes unfinished reservations in req_id conflicts and never resets a complete delivery',()=>{
  const {s,file}=open(),second=open(file).s;s.reserveBotReply(actor,reservation());
  expect(()=>second.reserveBotReply(actor,reservation(seed('b')))).toThrow('bot_reply_conflict');
  expect(()=>second.prepareBotReply(actor,seed('b'))).toThrow('bot_reply_conflict');
  s.prepareBotReply(actor,seed());const claim=s.claimBotReply(actor,seed().id)!;s.finishBotReply(actor,seed().id,claim.delivery.id,1,outcome());
  const before=s.getBotReply(actor,seed().id);second.reserveBotReply(actor,reservation(seed('a','fresh-route')));
  expect(s.getBotReply(actor,seed().id)).toEqual(before);
  expect(()=>second.reserveBotReply(actor,{...reservation(),fingerprint:'b'.repeat(64)})).toThrow('bot_reply_conflict');
 });
 it('atomically fixes one fingerprint when independent SQLite writers reserve the same event',async()=>{
  const {s,file}=open(),first=reservation(),second={...first,fingerprint:'b'.repeat(64)},results=await race(file,[{kind:'reserve',reservation:first},{kind:'reserve',reservation:second}]);
  expect(results.filter(r=>r.claimed)).toHaveLength(1);expect(results.filter(r=>r.error==='bot_reply_conflict')).toHaveLength(1);
  const winner=results[0]?.claimed?first:second,loser=results[0]?.claimed?second:first;
  expect(()=>s.prepareBotReply(actor,{...seed(),fingerprint:loser.fingerprint})).toThrow('bot_reply_conflict');
  expect(s.prepareBotReply(actor,{...seed(),fingerprint:winner.fingerprint}).delivery.state).toBe('prepared');
 });
 it('rolls back reservations and checks existing no-op reservations before commit',()=>{
  const {s}=open(),input=reservation();let calls=0;const guard=()=>{if(++calls===2)throw Error('expired');};
  expect(()=>s.reserveBotReply(actor,input,guard)).toThrow('expired');
  s.reserveBotReply(actor,{...input,fingerprint:'b'.repeat(64)});calls=0;
  expect(()=>s.reserveBotReply(actor,{...input,fingerprint:'b'.repeat(64)},guard)).toThrow('expired');
  expect(s.getBotReply(actor,input.id)).toBeUndefined();expect(()=>s.reserveBotReply(actor,input)).toThrow('bot_reply_conflict');
 });
 it('accepts the existing Native Home workspaceJid contract up to 200 characters',()=>{
  const {s}=open(),input={...seed(),target:{...target,workspaceJid:'w'.repeat(200)}};
  expect(s.prepareBotReply(actor,input).target.workspaceJid).toHaveLength(200);
  const reserved={...reservation(seed('b','req-2')),target:{...target,workspaceJid:'w'.repeat(200)}};s.reserveBotReply(actor,reserved);
  expect(s.prepareBotReply(actor,{...seed('b','req-2'),target:reserved.target}).target.workspaceJid).toHaveLength(200);
  expect(()=>s.reserveBotReply(actor,{...reservation(seed('c','req-3')),target:{...target,workspaceJid:'w'.repeat(201)}})).toThrow('invalid_bot_reply');
 });
});

it('rolls back a legacy return claim when authority expires before commit, including a no-op claim',()=>{
 const {s}=open(),report=confirmed(s);let calls=0;
 expect(()=>s.claimReturn(actor,report.id,()=>{if(++calls===2)throw Error('expired');})).toThrow('expired');
 expect(s.getReport(actor,report.id)?.delivery).toMatchObject({state:'prepared',attempt:0});
 s.claimReturn(actor,report.id);calls=0;
 expect(()=>s.claimReturn(actor,report.id,()=>{if(++calls===2)throw Error('expired');})).toThrow('expired');
 expect(s.getReport(actor,report.id)?.delivery).toMatchObject({state:'attempting',attempt:1});
});
it('preserves an accepted legacy HTTP receipt with a 1024-character msgid',()=>{
 const {s}=open(),input=s.receive(actor,'xml-receipt','今天销售成交1.23元','2026-10-17',{kind:'wecom-employee',corpId:'corp',agentId:1,memberId:'member',messageId:'xml-receipt',createTime:1,accountId:'account',workspaceJid:'workspace',storeId:'store',bindingVersion:1});
 const report=s.confirm(actor,input.id,input.hash,input.proposed.items),claim=s.claimReturn(actor,report.id)!;
 expect(s.finishReturn(actor,report.id,claim.delivery!.id,1,{state:'accepted',apiErrorCode:0,msgid:'m'.repeat(1024),detail:'api_accepted'})?.delivery?.msgid).toHaveLength(1024);
});
it('validates and saves the same receipt snapshot when a caller getter changes later',()=>{
 const {s}=open(),input=seed();s.prepareBotReply(actor,input);const claim=s.claimBotReply(actor,input.id)!;let reads=0;
 const result=outcome();Object.defineProperty(result,'state',{enumerable:true,get:()=>++reads===1?'accepted':'attempting'});
 expect(s.finishBotReply(actor,input.id,claim.delivery.id,1,result)?.delivery.state).toBe('accepted');
 expect(s.getBotReply(actor,input.id)?.delivery.state).toBe('accepted');
});

describe('durable bot reply intents in the existing SQLite file',()=>{
 it('snapshots trusted plans and actor data, and reopens them without changing ledger entries',()=>{
  const {s,file}=open(),input=seed(),who={...actor},saved=s.prepareBotReply(who,input);
  expect(saved.delivery).toMatchObject({state:'prepared',attempt:0,apiErrorCode:null,msgid:null,detail:'awaiting_dispatch'});
  expect(saved.delivery.id).toMatch(/^[a-f0-9]{64}$/);expect(s.list(actor)).toEqual([]);
  input.reply.body.stream.content='Caller changed';input.target.memberId='changed';who.employeeId='changed';saved.reply.reqId='changed';
  const next=open(file).s.getBotReply(actor,input.id)!;
  expect(next.reply).toMatchObject({reqId:'req-1',body:{stream:{content:'Synthetic reply'}}});expect(next.target.memberId).toBe('member');expect(next.actor.employeeId).toBe('employee');
  expect(open(file).s.getBotReply({...actor,employeeId:'other'},input.id)).toBeUndefined();
  const raw=new DatabaseSync(file);try{expect((raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name)).toEqual(expect.arrayContaining(['employee_reports','bot_reply_intents']));}finally{raw.close();}
 });
 it('globally rejects duplicate event remapping and preserves the first employee name',()=>{
  const {s,file}=open(),input=seed(),first=s.prepareBotReply(actor,input),second=open(file).s;
  expect(second.prepareBotReply({...actor,employeeName:'Renamed'},input).actor).toEqual(first.actor);
  for(const patch of [{tenant:'other'},{store:'other'},{workspace:'other'},{employeeId:'other'}])expect(()=>second.prepareBotReply({...actor,...patch},input)).toThrow('bot_reply_conflict');
  for(const key of Object.keys(target) as (keyof typeof target)[]){const changed={...input,target:{...target,[key]:key==='bindingVersion'?2:'other'}};expect(()=>second.prepareBotReply(actor,changed)).toThrow('bot_reply_conflict');}
  expect(()=>second.prepareBotReply(actor,{...input,fingerprint:'b'.repeat(64)})).toThrow('bot_reply_conflict');
  expect(second.getBotReply(actor,input.id)?.delivery).toEqual(first.delivery);
 });
 it('keeps req_id unique across events and across route updates on another connection',()=>{
  const {s,file}=open(),second=open(file).s;
  s.prepareBotReply(actor,seed());expect(()=>second.prepareBotReply(actor,seed('b'))).toThrow('bot_reply_conflict');
  second.prepareBotReply(actor,seed('b','req-2'));
  expect(()=>s.prepareBotReply(actor,seed('a','req-2'))).toThrow('bot_reply_conflict');
  expect(s.getBotReply(actor,seed().id)?.reply.reqId).toBe('req-1');
 });
 it('refreshes only prepared and blocked routes while retaining attempts, identity and links',()=>{
  const {s}=open(),{input}=linked(s),first=s.prepareBotReply(actor,input);
  const refreshed={...input,reply:{...input.reply,reqId:'req-fresh',body:{...input.reply.body,stream:{...input.reply.body.stream,content:'Fresh body'}}}};
  expect(s.prepareBotReply(actor,refreshed)).toMatchObject({reply:refreshed.reply,delivery:first.delivery,confirmation:input.confirmation});
  const claim=s.claimBotReply(actor,input.id)!;s.finishBotReply(actor,input.id,claim.delivery.id,1,outcome('blocked'));
  expect(s.prepareBotReply(actor,{...input,reply:{...input.reply,reqId:'req-retry'}})).toMatchObject({reply:{reqId:'req-retry'},delivery:{state:'blocked',attempt:1}});
  expect(()=>s.prepareBotReply(actor,{...input,reportId:'b'.repeat(64),confirmation:{...input.confirmation,reportId:'b'.repeat(64)}})).toThrow('bot_reply_conflict');
  expect(()=>s.prepareBotReply(actor,{...input,confirmation:{...input.confirmation,deliveryId:'b'.repeat(64)}})).toThrow('bot_reply_conflict');
 });
 it.each(['accepted','unknown','rejected','attempting'] as const)('does not reclaim or change the route of a %s event after reopen',state=>{
  const {s,file}=open(),input=seed();s.prepareBotReply(actor,input);const claim=s.claimBotReply(actor,input.id)!;
  if(state!=='attempting')s.finishBotReply(actor,input.id,claim.delivery.id,1,outcome(state));
  const second=open(file).s;expect(second.claimBotReply(actor,input.id)).toBeUndefined();
  expect(second.prepareBotReply(actor,{...input,reply:{...input.reply,reqId:'late-route'}})).toMatchObject({reply:{reqId:'req-1'},delivery:{state,attempt:1}});
 });
 it('retries only an explicit blocked event and rejects stale finish and malformed outcomes',()=>{
  const {s,file}=open(),input=seed();s.prepareBotReply(actor,input);const first=s.claimBotReply(actor,input.id)!;
  s.finishBotReply(actor,input.id,first.delivery.id,1,outcome('blocked'));const second=open(file).s.claimBotReply(actor,input.id)!;
  expect(second.delivery).toMatchObject({state:'attempting',attempt:2});
  for(const [id,attempt,result] of [[first.delivery.id,1,outcome()],['wrong',2,outcome()],[first.delivery.id,2,{...outcome(),apiErrorCode:NaN}],[first.delivery.id,2,{...outcome(),ackReqId:''}],[first.delivery.id,2,{...outcome(),state:'prepared'}]] as const)expect(()=>s.finishBotReply(actor,input.id,id,attempt,result as DeliveryOutcome)).toThrow('delivery_conflict');
  expect(s.getBotReply(actor,input.id)?.delivery).toMatchObject({state:'attempting',attempt:2});
  expect(s.finishBotReply(actor,input.id,second.delivery.id,2,outcome())).toMatchObject({delivery:{state:'accepted',ackReqId:'req-1',msgid:null}});
 });
 it('rejects invalid seeds before persisting anything',()=>{
  const {s}=open(),input=seed();
  for(const bad of [{...input,id:'A'.repeat(64)},{...input,fingerprint:'x'},{...input,target:{...target,bindingVersion:0}},{...input,reply:{...input.reply,reqId:''}},{...input,reply:{...input.reply,body:{...input.reply.body,stream:{...input.reply.body.stream,finish:false}}}}])expect(()=>s.prepareBotReply(actor,bad as BotReplySeed)).toThrow();
  expect(s.getBotReply(actor,input.id)).toBeUndefined();
 });
 it('validates the persisted snapshot even when caller getters change on later reads',()=>{
  const {s}=open(),input=seed();let reads=0;
  Object.defineProperty(input.reply,'reqId',{enumerable:true,get:()=>++reads===1?'req-1':''});
  // A single captured value is valid; a later getter value must never replace
  // that validated req_id in the stored snapshot.
  s.prepareBotReply(actor,input);
  expect(s.getBotReply(actor,input.id)?.reply.reqId).toBe('req-1');
 });
 it('rolls back new preparations and route refreshes on the final guard',()=>{
  const {s}=open(),input=seed();let calls=0;
  const guard=()=>{if(++calls===2)throw Error('expired');};
  expect(()=>s.prepareBotReply(actor,input,guard)).toThrow('expired');expect(s.getBotReply(actor,input.id)).toBeUndefined();
  s.prepareBotReply(actor,input);calls=0;
  expect(()=>s.prepareBotReply(actor,{...input,reply:{...input.reply,reqId:'req-new'}},guard)).toThrow('expired');expect(s.getBotReply(actor,input.id)?.reply.reqId).toBe('req-1');
 });
 it('serializes simultaneous req_id reservations on two independent SQLite writers',async()=>{
  const {s,file}=open(),results=await race(file,[{kind:'prepare',seed:seed()},{kind:'prepare',seed:seed('b')}]);
  expect(results.filter(r=>r.claimed)).toHaveLength(1);expect(results.filter(r=>r.error==='bot_reply_conflict')).toHaveLength(1);
  expect([s.getBotReply(actor,seed().id),s.getBotReply(actor,seed('b').id)].filter(Boolean)).toHaveLength(1);
 });
});

describe('atomic event and original confirmation delivery',()=>{
 it('claims both records once across SQLite connections and stores the same ACK without a fake msgid',()=>{
  const {s,file}=open(),{report,input}=linked(s),second=open(file).s;s.prepareBotReply(actor,input);
  const claim=second.claimBotReply(actor,input.id)!;expect(claim).toMatchObject({reportAttempt:1,delivery:{state:'attempting',attempt:1}});
  expect(s.claimReturn(actor,report.id)).toBeUndefined();expect(s.claimBotReply(actor,input.id)).toBeUndefined();
  expect(s.getReport(actor,report.id)?.delivery).toMatchObject({state:'attempting',attempt:1});
  expect(second.finishBotReply(actor,input.id,claim.delivery.id,1,outcome())).toMatchObject({delivery:{state:'accepted',ackReqId:'req-1',msgid:null}});
  expect(s.getReport(actor,report.id)?.delivery).toMatchObject({state:'accepted',ackReqId:'req-1',msgid:null});
  expect(s.summary(actor,'2026-10-17','half').salesCents).toBe(123);
 });
 it.each(['accepted','unknown','rejected','attempting'] as const)('does not claim an event when original confirmation is already %s',state=>{
  const {s}=open(),{report,input}=linked(s);s.prepareBotReply(actor,input);const original=s.claimReturn(actor,report.id)!;
  if(state!=='attempting')s.finishReturn(actor,report.id,original.delivery!.id,1,outcome(state));
  expect(s.claimBotReply(actor,input.id)).toBeUndefined();expect(s.getBotReply(actor,input.id)?.delivery).toMatchObject({state:'prepared',attempt:0});
  expect(s.getReport(actor,report.id)?.delivery?.state).toBe(state);
 });
 it('rolls back the event result if original receipt CAS has been superseded',()=>{
  const {s,file}=open(),{report,input}=linked(s);s.prepareBotReply(actor,input);const claim=s.claimBotReply(actor,input.id)!;
  const second=open(file).s;second.finishReturn(actor,report.id,report.delivery!.id,1,outcome('blocked'));second.claimReturn(actor,report.id);
  expect(()=>s.finishBotReply(actor,input.id,claim.delivery.id,1,outcome())).toThrow('delivery_conflict');
  expect(s.getBotReply(actor,input.id)?.delivery).toMatchObject({state:'attempting',attempt:1});expect(s.getReport(actor,report.id)?.delivery).toMatchObject({state:'attempting',attempt:2});
 });
 it('rejects confirmation links to pending, foreign, XML, mismatched or stale original reports',()=>{
  const {s}=open(),{report,input}=linked(s);
  for(const bad of [{...input,reportId:'b'.repeat(64)},{...input,confirmation:{reportId:report.id,deliveryId:'b'.repeat(64)}},{...input,target:{...target,memberId:'other'}},{...input,target:{...target,bindingVersion:2}}])expect(()=>s.prepareBotReply(actor,bad)).toThrow('delivery_conflict');
  const pending=s.receiveBot(actor,'pending','今天销售成交2元','2026-10-18',{...source,messageId:'other'});
  expect(()=>s.prepareBotReply(actor,{...input,reportId:pending.id,confirmation:{reportId:pending.id,deliveryId:'a'.repeat(64)}})).toThrow('delivery_conflict');
  expect(()=>s.prepareBotReply({...actor,employeeId:'other'},input)).toThrow('delivery_conflict');
  const legacy=s.receive(actor,'xml','今天销售成交3元','2026-10-19',{kind:'wecom-employee',corpId:'corp',agentId:1,memberId:'member',messageId:'xml',createTime:1,accountId:'account',workspaceJid:'workspace',storeId:'store',bindingVersion:1});const xml=s.confirm(actor,legacy.id,legacy.hash,legacy.proposed.items);
  expect(()=>s.prepareBotReply(actor,{...input,reportId:xml.id,confirmation:{reportId:xml.id,deliveryId:xml.delivery!.id}})).toThrow('delivery_conflict');
  expect(s.getBotReply(actor,input.id)).toBeUndefined();
 });
 it('rolls back both claims if the guard expires before commit and checks no-op branches',()=>{
  const {s}=open(),{report,input}=linked(s);s.prepareBotReply(actor,input);let calls=0;
  expect(()=>s.claimBotReply(actor,input.id,()=>{if(++calls===2)throw Error('expired');})).toThrow('expired');
  expect(s.getBotReply(actor,input.id)?.delivery.state).toBe('prepared');expect(s.getReport(actor,report.id)?.delivery?.state).toBe('prepared');
  const claim=s.claimBotReply(actor,input.id)!;calls=0;
  expect(()=>s.claimBotReply(actor,input.id,()=>{if(++calls===2)throw Error('expired');})).toThrow('expired');
  expect(s.finishBotReply(actor,input.id,claim.delivery.id,1,outcome())?.delivery.state).toBe('accepted');
 });
 it('allows only one sender when event and recovery claims race on independent SQLite writers',async()=>{
  const {s,file}=open(),{report,input}=linked(s);s.prepareBotReply(actor,input);
  const results=await race(file,[{kind:'event',id:input.id},{kind:'return',id:report.id}]);
  expect(results.every(r=>r.error===undefined)).toBe(true);expect(results.filter(r=>r.claimed)).toHaveLength(1);
  expect(s.getReport(actor,report.id)?.delivery).toMatchObject({state:'attempting',attempt:1});
  expect(s.getBotReply(actor,input.id)?.delivery).toMatchObject({state:results[0]?.claimed?'attempting':'prepared',attempt:results[0]?.claimed?1:0});
 });
});

it.each(['prepare','claim','legacy-claim','reserve'] as const)('checks authority after a real writer lock is released during %s',async kind=>{
 const {s,file}=open(),{report,input}=linked(s);if(kind!=='prepare')s.prepareBotReply(actor,input);
 const worker=new Worker(`const {DatabaseSync}=require('node:sqlite');const {parentPort,workerData}=require('node:worker_threads');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');setTimeout(()=>{db.exec('COMMIT');db.close();},200);`,{eval:true,workerData:file});
 await new Promise<void>((resolve,reject)=>{worker.once('message',()=>resolve());worker.once('error',reject);});const deadline=Date.now()+40;
 const guard=()=>{if(Date.now()>deadline)throw Error('expired');};
 try{expect(()=>kind==='prepare'?s.prepareBotReply(actor,input,guard):kind==='claim'?s.claimBotReply(actor,input.id,guard):kind==='reserve'?s.reserveBotReply(actor,reservation(input),guard):s.claimReturn(actor,report.id,guard)).toThrow('expired');
  expect(s.getReport(actor,report.id)?.delivery).toMatchObject({state:'prepared',attempt:0});expect(s.getBotReply(actor,input.id)?.delivery.state).toBe(kind==='prepare'?undefined:'prepared');
 }finally{await worker.terminate();}
});
it('freezes conversation version payload even before attempt, and retries rejected only by explicit claim',()=>{
 const {s}=open(),input={...seed(),conversation:{receiptId:'b'.repeat(64),revision:1,digest:'c'.repeat(64),page:1,pages:1}};
 expect(()=>s.prepareBotReply(actor,input)).not.toThrow();
 const changed=structuredClone(input);changed.reply.body.stream.content='newer source';
 expect(()=>s.prepareBotReply(actor,changed)).toThrow('bot_reply_conflict');
 const claim=s.claimBotReply(actor,input.id)!;s.finishBotReply(actor,claim.id,claim.delivery.id,claim.delivery.attempt,outcome('rejected'));
 expect(s.claimBotReply(actor,input.id)).toBeUndefined();
 expect(s.claimBotReply(actor,input.id,undefined,true)?.delivery).toMatchObject({state:'attempting',attempt:2});
});
