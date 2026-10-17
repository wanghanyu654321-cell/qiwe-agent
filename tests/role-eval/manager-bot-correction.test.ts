import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {ManagerStore,type BotReportSource,type BotReplyIntent,type BotReplyTarget,type StaffContext,type StaffReport} from '../../src/role-eval/manager-store.js';

const actor:StaffContext={tenant:'synthetic',store:'store',workspace:'workspace',employeeId:'employee',employeeName:'Employee'};
const target={corpId:'corp',botId:'bot',memberId:'member',accountId:'account',workspaceJid:'workspace',storeId:'store',bindingVersion:1};
const source:BotReportSource={kind:'wecom-bot',...target,messageId:'platform-original'};
const dirs:string[]=[],stores:ManagerStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function open(file?:string){if(!file){const dir=mkdtempSync(join(tmpdir(),'bot-correction-'));dirs.push(dir);file=join(dir,'ledger.sqlite');}const s=new ManagerStore(file);stores.push(s);return {s,file};}
function original(s:ManagerStore,who=actor){const r=s.receiveBot(who,'original','今天销售成交1.23元','2026-10-17',source);return s.confirm(who,r.id,r.hash,r.proposed.items);}
// Before the seam exists, exercise the existing receive path so RED reports
// the missing business behavior rather than a missing-function TypeError.
function correct(s:ManagerStore,id:string,index=0,cents=234,who=actor,key='correction',src:BotReportSource={...source,messageId:'platform-'+key},guard?:()=>void):StaffReport{
 const method:unknown=Reflect.get(s,'receiveBotCorrection');
 return typeof method==='function'?method.call(s,who,key,'更正原报数','2026-10-18',src,id,index,cents,guard):s.receiveBot(who,key,'更正原报数','2026-10-18',src,guard);
}
function superseded(s:ManagerStore,who:StaffContext,id:string):string[]{const method:unknown=Reflect.get(s,'supersededEntryIds');return typeof method==='function'?method.call(s,who,id):[];}

describe('bot corrections in the original ledger',()=>{
 it('keeps the original immutable and only counts a replacement after the existing confirmation transaction',()=>{
  const {s,file}=open(),old=original(s),r=correct(s,old.id);
  expect(r).toMatchObject({state:'pending',entries:[],correction:{reportId:old.id,entryId:old.entries[0]!.id,previousAmountCents:123},botSource:{messageId:'platform-correction'},proposed:{parser:'offline-rules',missing:[],items:[{kind:'sales',start:'2026-10-17',end:'2026-10-17',mode:'snapshot',amountCents:234,supersedes:old.entries[0]!.id}]}});
  expect(s.summary(actor,'2026-10-17','month').salesCents).toBe(123);
  const next=open(file).s,done=next.confirm(actor,r.id,r.hash,r.proposed.items);
  expect(done).toMatchObject({state:'confirmed',delivery:{state:'prepared'}});
  expect(next.summary(actor,'2026-10-17','month').salesCents).toBe(234);
  expect(next.getReport(actor,old.id)).toEqual(old);
  expect(correct(next,old.id,0,234,{...actor,employeeName:'Renamed'},'correction',{...source,messageId:'platform-correction',bindingVersion:2})).toEqual(done);
 });
 it('copies only the selected entry including its kind, mode and period',()=>{
  const {s}=open(),r=s.receive(actor,'web','原Web两条明细','2026-10-17'),old=s.confirm(actor,r.id,r.hash,[{kind:'target',start:'2026-10-01',end:'2026-10-31',amountCents:500,mode:'snapshot'},{kind:'sales',start:'2026-10-16',end:'2026-10-17',amountCents:123,mode:'increment'}]);
  const change=correct(s,old.id,1,0);expect(change.proposed.items).toEqual([{kind:'sales',start:'2026-10-16',end:'2026-10-17',amountCents:0,mode:'increment',supersedes:old.entries[1]!.id}]);
  expect(Reflect.get(change,'correction')).toEqual({reportId:old.id,entryId:old.entries[1]!.id,previousAmountCents:123});
  expect(s.confirm(actor,change.id,change.hash,change.proposed.items).entries).toHaveLength(1);
 });
 it.each([{tenant:'other'},{store:'other'},{workspace:'other'},{employeeId:'other'}])('rejects an original outside employee ownership %j',patch=>{
  const {s}=open(),old=original(s);expect(()=>correct(s,old.id,0,234,{...actor,...patch})).toThrow('correction_conflict');expect(s.list(actor)).toHaveLength(1);
 });
 it('rejects account replacement, missing/pending originals and missing entries without writing a new row',()=>{
  const {s}=open(),old=original(s),pending=s.receive(actor,'pending','今天销售成交1元','2026-10-18');
  for(const id of ['a'.repeat(64),pending.id])expect(()=>correct(s,id)).toThrow('correction_conflict');
  expect(()=>correct(s,old.id,1)).toThrow('correction_conflict');
  expect(()=>correct(s,old.id,0,234,actor,'correction',{...source,messageId:'platform-correction',accountId:'other'})).toThrow('correction_conflict');
  expect(s.list(actor)).toHaveLength(2);
 });
 it.each([['bad',0,1],['A'.repeat(64),0,1],['a'.repeat(64),-1,1],['a'.repeat(64),10,1],['a'.repeat(64),0.5,1],['a'.repeat(64),0,-1],['a'.repeat(64),0,NaN],['a'.repeat(64),0,Number.MAX_SAFE_INTEGER+1]] as const)('rejects malformed references and cents (%s,%s,%s)',(id,index,cents)=>{
  const {s}=open();expect(()=>correct(s,id,index,cents)).toThrow('invalid_correction_reference');expect(s.list(actor)).toEqual([]);
 });
 it('applies the existing source validation to correction requests',()=>{
  const {s}=open(),old=original(s);expect(()=>correct(s,old.id,0,234,actor,'correction',{...source,bindingVersion:0})).toThrow('invalid_bot_source');expect(s.list(actor)).toHaveLength(1);
 });
 it('binds replay to original, entry and new amount independently of identical text',()=>{
  const {s}=open(),old=original(s),change=correct(s,old.id);
  for(const [id,index,cents] of [['b'.repeat(64),0,234],[old.id,1,234],[old.id,0,235]] as const)expect(()=>correct(s,id,index,cents)).toThrow('message_conflict');
  expect(()=>s.receiveBot(actor,'correction',change.text,change.date,{...source,messageId:'platform-correction'})).toThrow('message_conflict');
  expect(s.list(actor)).toHaveLength(2);expect(s.getReport(actor,change.id)).toEqual(change);
 });
 it('rejects stale targets but lets a new correction target the latest confirmed replacement',()=>{
  const {s}=open(),old=original(s),first=correct(s,old.id);s.confirm(actor,first.id,first.hash,first.proposed.items);
  expect(()=>correct(s,old.id,0,345,actor,'stale')).toThrow('correction_conflict');
  const second=correct(s,first.id,0,345,actor,'next');s.confirm(actor,second.id,second.hash,second.proposed.items);expect(s.summary(actor,'2026-10-17','month').salesCents).toBe(345);
 });
 it('finds own historical corrected entries with direct JSON SQL without whole-ledger reads',()=>{
  const {s,file}=open(),old=original(s),first=correct(s,old.id),second=open(file).s;
  expect(superseded(second,actor,old.id)).toEqual([]);s.confirm(actor,first.id,first.hash,first.proposed.items);
  second.list=()=>{throw Error('single_report_lookup_must_not_list');};second.summary=()=>{throw Error('single_report_lookup_must_not_summarize');};
  expect(superseded(second,actor,old.id)).toEqual([old.entries[0]!.id]);
  for(const patch of [{employeeId:'other'},{store:'other'},{tenant:'other'},{workspace:'other'}])expect(superseded(second,{...actor,...patch},old.id)).toEqual([]);
  expect(()=>superseded(second,actor,"' OR 1=1 --")).toThrow('invalid_correction_reference');
 });
 it('supports same-account legacy XML and source-free Web original records',()=>{
  const {s}=open(),xml=s.receive(actor,'xml','今天销售成交1元','2026-10-16',{kind:'wecom-employee',corpId:'corp',agentId:1,memberId:'member',messageId:'xml-platform',createTime:1,accountId:'account',workspaceJid:'workspace',storeId:'store',bindingVersion:1});
  const old=s.confirm(actor,xml.id,xml.hash,xml.proposed.items),change=correct(s,old.id);expect(change.proposed.items[0]?.supersedes).toBe(old.entries[0]!.id);expect(change.source).toBeUndefined();
  expect(s.getReport(actor,old.id)?.source).toEqual(xml.source);
 });
 it('rolls back preparation when the final authority guard expires',()=>{
  const {s}=open(),old=original(s);let calls=0;
  expect(()=>correct(s,old.id,0,234,actor,'correction',undefined,()=>{if(++calls===3)throw Error('expired');})).toThrow('expired');
  expect(s.list(actor)).toHaveLength(1);expect(s.getReport(actor,old.id)).toEqual(old);
 });
 it('binds correction hashes to the replacement while preserving the legacy report hash',()=>{
  const {s}=open(),old=original(s),first=correct(s,old.id),otherAmount=correct(s,old.id,0,345,actor,'other-amount');
  expect(old.hash).toBe(createHash('sha256').update(JSON.stringify({text:'今天销售成交1.23元',date:'2026-10-17'})).digest('hex'));
  expect(first.hash).not.toBe(otherAmount.hash);
  expect(()=>s.confirm(actor,first.id,otherAmount.hash,first.proposed.items)).toThrow('report_version_conflict');
  expect(s.getReport(actor,first.id)?.state).toBe('pending');
 });
 it('captures trusted actor and bot provenance before later authority checks can mutate the inputs',()=>{
  const {s}=open(),old=original(s),who={...actor},src={...source,messageId:'platform-correction'};
  const r=correct(s,old.id,0,234,who,'correction',src,()=>{who.employeeId='changed';src.accountId='changed';});
  expect(r.actor).toEqual(actor);expect(r.botSource?.accountId).toBe('account');
  expect(s.getReport(actor,r.id)).toEqual(r);expect(s.getReport(who,r.id)).toBeUndefined();
 });
 it('lets only one of two independently prepared corrections commit under simultaneous SQLite writers',async()=>{
  const {s,file}=open(),old=original(s),one=correct(s,old.id),two=correct(open(file).s,old.id,0,345,actor,'second');
  // Compile current source so this verifies the working tree, not stale dist.
  const compile=(text:string)=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
  const report=compile(readFileSync(fileURLToPath(new URL('../../src/role-eval/manager-report.ts',import.meta.url)),'utf8'));
  const moduleUrl=compile(readFileSync(fileURLToPath(new URL('../../src/role-eval/manager-store.ts',import.meta.url)),'utf8').replace("'./manager-report.js'",JSON.stringify(report))),gate=new SharedArrayBuffer(4);
  const workers=[one,two].map(r=>new Worker(`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {ManagerStore}=await import(workerData.moduleUrl);const s=new ManagerStore(workerData.file);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.gate),0,0);try{const r=workerData.report;parentPort.postMessage({state:s.confirm(workerData.actor,r.id,r.hash,r.proposed.items).state});}catch(e){parentPort.postMessage({error:e.message});}finally{s.close();}})();`,{eval:true,workerData:{moduleUrl,file,actor,report:r,gate}}));
  try{
   await Promise.all(workers.map(w=>new Promise<void>((resolve,reject)=>{w.once('message',()=>resolve());w.once('error',reject);})));
   const results=workers.map(w=>new Promise<{state?:string;error?:string}>((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);}));Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
   const outcomes=await Promise.all(results);expect(outcomes.filter(x=>x.state==='confirmed')).toHaveLength(1);expect(outcomes.filter(x=>x.error==='correction_conflict')).toHaveLength(1);
   expect(s.list(actor).filter(x=>x.state==='pending')).toHaveLength(1);expect([234,345]).toContain(s.summary(actor,'2026-10-17','month').salesCents);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
 });
});

const attachment={snapshotHash:'a'.repeat(64),sha256:'b'.repeat(64),filename:'sales-'+ 'a'.repeat(64)+'.xlsx',byteLength:5};
function fileSeed(){return {id:'c'.repeat(64),fingerprint:'d'.repeat(64),target:{...target},attachment:{...attachment},reply:{reqId:'req-file',body:{msgtype:'stream' as const,stream:{id:'file-stream',finish:true as const,content:'销售Excel文件'}}}};}
function latestFile(s:ManagerStore,who=actor,snapshot=attachment.snapshotHash,route:BotReplyTarget=target):BotReplyIntent|undefined {
 const method:unknown=Reflect.get(s,'getBotFileReply');return typeof method==='function'?method.call(s,who,snapshot,route):undefined;
}
describe('current-owner file delivery status lookup',()=>{
 it.each(['prepared','attempting','accepted','unknown','blocked','rejected'] as const)('returns the most recent prepared file event and its current %s state after SQLite reopen',state=>{
  const {s,file}=open(),first=fileSeed();s.prepareBotReply(actor,first);
  const later={...fileSeed(),id:'e'.repeat(64),reply:{...first.reply,reqId:'later-file'}};s.prepareBotReply(actor,later);
  if(state!=='prepared'){const claim=s.claimBotReply(actor,later.id)!;if(state!=='attempting')s.finishBotReply(actor,later.id,claim.delivery.id,1,{state,apiErrorCode:null,msgid:null,detail:'synthetic-'+state});}
  const next=open(file).s;expect(latestFile(next)).toMatchObject({id:later.id,attachment,delivery:{state}});
  // Refreshing an older event must not reorder file attempts by update time.
  s.prepareBotReply(actor,{...first,reply:{...first.reply,reqId:'older-refreshed'}});expect(latestFile(next)?.id).toBe(later.id);
 });
 it.each([{tenant:'other'},{store:'other'},{workspace:'other'},{employeeId:'other'}])('does not disclose a file outside current actor scope %j',patch=>{
  const {s}=open();s.prepareBotReply(actor,fileSeed());expect(latestFile(s)).toBeDefined();expect(latestFile(s,{...actor,...patch})).toBeUndefined();
 });
 it.each([{corpId:'other'},{botId:'other'},{memberId:'other'},{accountId:'other'},{workspaceJid:'other'},{storeId:'other'},{bindingVersion:2}])('requires the complete current target identity %j and skips newer foreign-target events',patch=>{
  const {s}=open(),first=fileSeed();s.prepareBotReply(actor,first);
  expect(latestFile(s,actor,attachment.snapshotHash,{...target,...patch})).toBeUndefined();
  s.prepareBotReply(actor,{...first,id:'e'.repeat(64),target:{...target,...patch},reply:{...first.reply,reqId:'foreign-target'}});
  expect(latestFile(s)?.id).toBe(first.id);expect(latestFile(s,actor,attachment.snapshotHash,{...target,...patch})?.id).toBe('e'.repeat(64));
 });
 it('ignores reservations, non-file replies and unrelated snapshots without a whole-report lookup',()=>{
  const {s}=open(),first=fileSeed();s.prepareBotReply(actor,first);
  const {attachment:omitted,...plain}=first;s.prepareBotReply(actor,{...plain,id:'e'.repeat(64),reply:{...plain.reply,reqId:'non-file'}});
  s.reserveBotReply(actor,{id:'f'.repeat(64),fingerprint:'d'.repeat(64),target,reqId:'reserved-only'});
  const otherHash='1'.repeat(64);s.prepareBotReply(actor,{...first,id:'2'.repeat(64),attachment:{...attachment,snapshotHash:otherHash,filename:'sales-'+otherHash+'.xlsx'},reply:{...first.reply,reqId:'other-snapshot'}});
  s.list=()=>{throw Error('file_lookup_must_not_list_reports');};
  expect(latestFile(s)?.id).toBe(first.id);expect(latestFile(s,actor,'3'.repeat(64))).toBeUndefined();
 });
 it.each([{hash:'invalid',route:target},{hash:'A'.repeat(64),route:target},{hash:attachment.snapshotHash,route:{...target,bindingVersion:0}},{hash:attachment.snapshotHash,route:{...target,memberId:''}},{hash:attachment.snapshotHash,route:{...target,unexpected:'value'}}])('validates snapshot hash and target before reading %j',({hash,route})=>{
  const {s}=open();expect(()=>latestFile(s,actor,hash,route)).toThrow('invalid_bot_reply');
 });
 it('returns independent JSON copies and snapshots target getters once',()=>{
  const {s}=open();s.prepareBotReply(actor,fileSeed());const route={...target};let reads=0;
  Object.defineProperty(route,'accountId',{enumerable:true,get:()=>++reads===1?'account':'other'});
  const record=latestFile(s,actor,attachment.snapshotHash,route)!;expect(record).toMatchObject({target,attachment});record.delivery.state='unknown';record.target.accountId='mutated';record.attachment!.sha256='mutated';
  expect(latestFile(s)).toMatchObject({target,attachment,delivery:{state:'prepared'}});
 });
});
describe('attachment metadata in the original event outbox',()=>{
 it('upgrades the original event reservation and refreshes its route without changing the file',()=>{
  const {s}=open(),input=fileSeed();s.reserveBotReply(actor,{id:input.id,fingerprint:input.fingerprint,target:input.target,reqId:input.reply.reqId});
  expect(s.getBotReply(actor,input.id)).toBeUndefined();s.prepareBotReply(actor,input);
  expect(s.prepareBotReply(actor,{...input,reply:{...input.reply,reqId:'refreshed-req'}})).toMatchObject({attachment,reply:{reqId:'refreshed-req'},delivery:{attempt:0,state:'prepared'}});
 });
 it('accepts the conservative decimal 20MB upper boundary',()=>{
  const {s}=open(),input=fileSeed();expect(s.prepareBotReply(actor,{...input,attachment:{...input.attachment,byteLength:20_000_000}})).toMatchObject({attachment:{byteLength:20_000_000}});
 });
 it('persists immutable metadata through reopen, claim and terminal state',()=>{
  const {s,file}=open(),input=fileSeed(),saved=s.prepareBotReply(actor,input);input.attachment.sha256='e'.repeat(64);
  expect(saved).toMatchObject({attachment});const next=open(file).s,claim=next.claimBotReply(actor,saved.id)!;expect(claim).toMatchObject({attachment});
  next.finishBotReply(actor,saved.id,claim.delivery.id,1,{state:'accepted',apiErrorCode:0,msgid:null,detail:'synthetic_ack'});expect(s.getBotReply(actor,saved.id)).toMatchObject({attachment,delivery:{state:'accepted'}});
 });
 it.each([{snapshotHash:'x'},{sha256:'A'.repeat(64)},{filename:'../sales.xlsx'},{filename:'sales-'+ 'e'.repeat(64)+'.xlsx'},{byteLength:4},{byteLength:20_000_001},{byteLength:5.5},{media_id:'unsafe'},{path:'local.xlsx'}])('rejects invalid file metadata %j without persistence',patch=>{
  const {s}=open(),input=fileSeed();expect(()=>s.prepareBotReply(actor,{...input,attachment:{...input.attachment,...patch}})).toThrow('invalid_bot_reply');expect(s.getBotReply(actor,input.id)).toBeUndefined();
 });
 it('captures metadata getters once before validation and retains the validated value',()=>{
  const {s}=open(),input=fileSeed();let reads=0;Object.defineProperty(input.attachment,'sha256',{enumerable:true,get:()=>++reads===1?'b'.repeat(64):'invalid'});
  expect(s.prepareBotReply(actor,input)).toMatchObject({attachment});expect(s.getBotReply(actor,input.id)).toMatchObject({attachment});
 });
 it.each(['prepared','blocked','accepted'] as const)('rejects metadata replacement or deletion on %s retries',state=>{
  const {s,file}=open(),input=fileSeed();s.prepareBotReply(actor,input);
  if(state!=='prepared'){const claim=s.claimBotReply(actor,input.id)!;s.finishBotReply(actor,input.id,claim.delivery.id,1,{state,apiErrorCode:null,msgid:null,detail:'synthetic'});}
  const next=open(file).s;
  for(const patch of [{sha256:'e'.repeat(64)},{byteLength:6},{snapshotHash:'f'.repeat(64),filename:'sales-'+ 'f'.repeat(64)+'.xlsx'}])expect(()=>next.prepareBotReply(actor,{...input,attachment:{...input.attachment,...patch}})).toThrow('bot_reply_conflict');
  const {attachment:omitted,...without}=input;expect(()=>next.prepareBotReply(actor,without)).toThrow('bot_reply_conflict');expect(next.getBotReply(actor,input.id)).toMatchObject({attachment});
 });
 it('does not let legacy outbox retries acquire attachment metadata',()=>{
  const {s}=open(),input=fileSeed(),{attachment:omitted,...legacy}=input;s.prepareBotReply(actor,legacy);expect(()=>s.prepareBotReply(actor,input)).toThrow('bot_reply_conflict');expect(s.getBotReply(actor,input.id)).not.toHaveProperty('attachment');
 });
});
