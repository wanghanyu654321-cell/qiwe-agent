import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {ManagerStore,type StaffContext,type StaffReport} from '../../src/role-eval/manager-store.js';
const dirs:string[]=[],stores:ManagerStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const actor:StaffContext={tenant:'t',store:'s',workspace:'w',employeeId:'e',employeeName:'Employee'};
const source={kind:'wecom-bot' as const,corpId:'corp',botId:'bot',memberId:'member',messageId:'platform',accountId:'e',workspaceJid:'w',storeId:'s',bindingVersion:1};
function open(file?:string){if(!file){const d=mkdtempSync(join(tmpdir(),'bot-ledger-'));dirs.push(d);file=join(d,'ledger.sqlite');}const s=new ManagerStore(file);stores.push(s);return {s,file};}
function receive(s:ManagerStore,a=actor,text='今天销售成交1.23元',date='2026-10-17',src:object=source):StaffReport{const method:unknown=Reflect.get(s,'receiveBot');return typeof method==='function'?method.call(s,a,'bot-key',text,date,src):s.receive(a,'bot-key',text,date);}
function get(s:ManagerStore,a:StaffContext,id:string):StaffReport|undefined{const method=Reflect.get(s,'getReport');return typeof method==='function'?method.call(s,a,id):s.list(a).find(r=>r.id===id);}
it('persists bot audit metadata and prepared intent with integer cents',()=>{const {s}=open();const r=receive(s);expect(Reflect.get(r,'botSource')).toEqual(source);expect(r.source).toBeUndefined();expect(r.proposed.items[0]?.amountCents).toBe(123);expect(s.confirm(actor,r.id,r.hash,r.proposed.items).delivery?.state).toBe('prepared');});
it('reopens and retries across connections retaining first date, name and binding version',()=>{const {s,file}=open();const r=receive(s);const second=open(file).s;expect(receive(second,{...actor,employeeName:'Renamed'},undefined,'2026-10-18',{...source,bindingVersion:2})).toEqual(r);});
it.each([{store:'other'},{workspace:'other'},{tenant:'other'},{employeeId:'other'}])('rejects source remapping across actor scope %j',patch=>{const {s}=open();receive(s);expect(()=>receive(s,{...actor,...patch})).toThrow('message_conflict');expect(s.list(actor)).toHaveLength(1);});
it('rejects changed body, account, or timestamp while retaining original',()=>{const {s}=open();const r=receive(s);for(const src of [{...source,accountId:'other'},{...source,createTime:10}])expect(()=>receive(s,actor,undefined,undefined,src)).toThrow('message_conflict');expect(()=>receive(s,actor,'今天销售成交2元')).toThrow('message_conflict');expect(get(s,actor,r.id)).toEqual(r);});
it('validates bot source shape rather than accepting XML or extra fields',()=>{const {s}=open();for(const src of [{...source,kind:'wecom-employee'},{...source,agentId:1},{...source,bindingVersion:0},{...source,createTime:NaN}])expect(()=>receive(s,actor,undefined,undefined,src)).toThrow('invalid_bot_source');expect(s.list(actor)).toEqual([]);});
it('looks up only the current employee report',()=>{const {s}=open();const r=receive(s);s.list=()=>{throw Error('lookup_must_not_list');};expect(get(s,{...actor,employeeId:'other'},r.id)).toBeUndefined();expect(get(s,actor,r.id)).toEqual(r);});
it('rolls back confirmation and guards confirmed replays before commit',()=>{const {s}=open();const r=receive(s);let calls=0;const guard=()=>{if(++calls===2)throw Error('cancelled');};const confirm=Reflect.get(s,'confirm') as Function;expect(()=>confirm.call(s,actor,r.id,r.hash,r.proposed.items,guard)).toThrow('cancelled');expect(get(s,actor,r.id)?.state).toBe('pending');const confirmed=s.confirm(actor,r.id,r.hash,r.proposed.items);calls=0;expect(()=>confirm.call(s,actor,r.id,r.hash,r.proposed.items,guard)).toThrow('cancelled');expect(get(s,actor,r.id)).toEqual(confirmed);});
it('preserves legacy records and legacy prepared intent',()=>{const {s}=open();const legacy={kind:'wecom-employee' as const,corpId:'c',agentId:1,memberId:'m',messageId:'x',createTime:1,accountId:'e',workspaceJid:'w',storeId:'s',bindingVersion:1};const r=s.receive(actor,'legacy','今天销售成交1元','2026-10-17',legacy);expect(r.source).toEqual(legacy);expect(Reflect.get(r,'botSource')).toBeUndefined();expect(s.confirm(actor,r.id,r.hash,r.proposed.items).delivery?.state).toBe('prepared');});

describe('original manager-store.test.ts',()=>{
const actor={tenant:'synthetic-local',store:'b',workspace:'web:main',employeeId:'staff-1',employeeName:'合成员工一'};
const target={kind:'target' as const,start:'2026-10-01',end:'2026-10-15',amountCents:100000,mode:'snapshot' as const};
const sale={kind:'sales' as const,start:'2026-10-14',end:'2026-10-14',amountCents:40000,mode:'snapshot' as const};
const setup=()=>{const file=join(mkdtempSync(join(tmpdir(),'manager-sales-')),'reports.sqlite');return {file,s:tracked(file)};};
function add(s:ManagerStore,id:string,items:typeof target[]|typeof sale[]|any[],who=actor){const r=s.receive(who,id,'合成员工报数，仅用于离线验收','2026-10-14');return s.confirm(who,r.id,r.hash,items);}
describe('persistent employee reporting ledger',()=>{
 it('requires explicit confirmation, replays the same message and survives a new store process',()=>{
  const {s,file}=setup();const r=s.receive(actor,'m1','今天销售成交400元','2026-10-14');expect(s.summary(actor,'2026-10-14','half').salesCents).toBeNull();
  const saved=s.confirm(actor,r.id,r.hash,[sale]);expect(saved.state).toBe('confirmed');expect(s.receive(actor,'m1','今天销售成交400元','2026-10-14').id).toBe(r.id);
  expect(tracked(file).summary(actor,'2026-10-14','half')).toMatchObject({salesCents:40000,coverage:'partial',rate:null});
  expect(()=>s.receive(actor,'m1','今天销售成交800元','2026-10-14')).toThrow('message_conflict');
 });
 it('computes rate from matching totals and preserves unknown versus zero',()=>{
  const {s}=setup();add(s,'t1',[target]);add(s,'s1',[sale]);expect(s.summary(actor,'2026-10-14','half')).toMatchObject({targetCents:100000,salesCents:40000,rate:0.4,varianceCents:-60000});
  expect(s.summary(actor,'2026-10-16','half')).toMatchObject({targetCents:null,salesCents:null,rate:null});
  add(s,'t2',[{...target,start:'2026-10-16',end:'2026-10-31',amountCents:0}]);expect(s.summary(actor,'2026-10-20','half').rate).toBeNull();
 });
 it('does not double-count overlaps, cumulative snapshots or stale correction versions',()=>{
  const {s}=setup();const old=add(s,'s1',[sale]);expect(()=>add(s,'s2',[sale])).toThrow('overlapping_report');
  expect(()=>add(s,'s3',[{...sale,start:'2026-10-01',end:'2026-10-15',amountCents:60000}])).toThrow('overlapping_report');
  const corrected=add(s,'correction',[{...sale,amountCents:50000,supersedes:old.entries[0]!.id}]);expect(corrected.state).toBe('confirmed');
  expect(()=>add(s,'stale',[{...sale,amountCents:90000,supersedes:old.entries[0]!.id}])).toThrow('correction_conflict');
  expect(s.summary(actor,'2026-10-14','half').salesCents).toBe(50000);expect(s.list(actor).filter(x=>x.state==='confirmed')).toHaveLength(2);
 });
 it('rejects scope forgery, employee takeover, invalid data and confirmation payload changes',()=>{
  const {s}=setup();const r=s.receive(actor,'guard','今天销售成交400元','2026-10-14');
  expect(()=>s.confirm({...actor,store:'a'},r.id,r.hash,[sale])).toThrow('report_not_found');
  expect(()=>s.confirm({...actor,employeeId:'staff-2'},r.id,r.hash,[sale])).toThrow('report_not_found');
  expect(()=>s.confirm(actor,r.id,'wrong',[sale])).toThrow('report_version_conflict');
  expect(()=>s.confirm(actor,r.id,r.hash,[{...sale,amountCents:-1}])).toThrow('invalid_report_item');
  s.confirm(actor,r.id,r.hash,[sale]);expect(()=>s.confirm(actor,r.id,r.hash,[{...sale,amountCents:90000}])).toThrow('confirmation_conflict');
  expect(s.summary({...actor,store:'a'},'2026-10-14','half').salesCents).toBeNull();
 });
 it('sums weighted employee amounts, never averages completion percentages or double counts the same employee',()=>{
  const {s}=setup();add(s,'t1',[target]);add(s,'s1',[sale]);const two={...actor,employeeId:'staff-2',employeeName:'合成员工二'};
  add(s,'t2',[{...target,amountCents:300000}],two);add(s,'s2',[{...sale,amountCents:180000}],two);
  expect(s.summary(actor,'2026-10-14','half')).toMatchObject({targetCents:400000,salesCents:220000,rate:0.55});
  expect(s.summary(actor,'2026-10-14','month')).toMatchObject({salesCents:220000,targetCents:null,rate:null,coverage:'partial'});
 });
 it('reconciles an identical original message the next day with its original reporting date',()=>{
  const {s}=setup();const original=s.receive(actor,'midnight','今天销售成交400元','2026-10-14');
  expect(s.receive(actor,'midnight','今天销售成交400元','2026-10-15')).toEqual(original);
 });
 it('keeps a known but entirely unreported employee unknown instead of claiming complete coverage',()=>{
  const {s}=setup(),two={...actor,employeeId:'staff-2',employeeName:'合成员工二'};
  add(s,'target',[target]);add(s,'full-sales',[{...sale,start:'2026-10-01',end:'2026-10-15'}]);
  const summary=s.summary(actor,'2026-10-14','half',[actor,two]);
  expect(summary).toMatchObject({coverage:'partial',targetCents:null,rate:null,rows:expect.arrayContaining([{employeeId:'staff-2',employeeName:'合成员工二',salesCents:null,targetCents:null,rate:null,coverage:'partial'}])});
 });
});

describe('verified employee message provenance in the existing ledger',()=>{
 const source={kind:'wecom-employee' as const,corpId:'synthetic-corp',agentId:7,memberId:'staff_b',messageId:'18446744073709551615',createTime:1792080000,accountId:'mvp-staff-b',workspaceJid:'web:mvp-staff-b',storeId:'mvp-store-b',bindingVersion:2};
 it('persists the original channel identity without confirming or changing existing entries',()=>{
  const {s,file}=setup();add(s,'existing-sale',[sale]);
  const r=s.receive(actor,'wecom-stable-id','今天销售成交123.45元','2026-10-16',source);
  expect(r).toMatchObject({state:'pending',entries:[],source:{messageId:'18446744073709551615',accountId:'mvp-staff-b',bindingVersion:2}});
  expect(tracked(file).list(actor).find(x=>x.id===r.id)).toMatchObject({source});
  expect(s.summary(actor,'2026-10-14','half').salesCents).toBe(40000);
 });
 it('replays matching origin independent of object key order but rejects changed signed timestamps',()=>{
  const {s}=setup();const original=s.receive(actor,'wecom-replay','今天销售成交123.45元','2026-10-16',source);
  const {createTime,...rest}=source;
  expect(s.receive(actor,'wecom-replay',original.text,'2026-10-17',{createTime,...rest})).toEqual(original);
  expect(()=>s.receive(actor,'wecom-replay',original.text,'2026-10-16',{...source,createTime:source.createTime+1})).toThrow('message_conflict');
  expect(s.list(actor)).toHaveLength(1);
 });
});
});

describe('original manager-return-store.test.ts',()=>{
const actor:StaffContext={tenant:'synthetic-local',store:'b',workspace:'web:main',employeeId:'synthetic-staff-1',employeeName:'合成员工1'};
const source={kind:'wecom-employee' as const,corpId:'synthetic-corp',agentId:7,memberId:'staff_b',messageId:'18446744073709551615',createTime:1792079940,accountId:'mvp-staff-b',workspaceJid:'web:mvp-staff-b',storeId:'mvp-store-b',bindingVersion:2};
function setup(){const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'manager-return-')),'reports.sqlite'),s=tracked(file);return {s,file};}
it('atomically saves a single prepared return intent with confirmed entries, and replays it across reopen',()=>{
 const {s,file}=setup(),r=s.receive(actor,'wecom-original','今天销售成交123.45元','2026-10-15',source);
 expect(r).not.toHaveProperty('delivery');
 const result=s.confirm(actor,r.id,r.hash,r.proposed.items);
 expect(result).toMatchObject({state:'confirmed',delivery:{state:'prepared',confirmationHash:result.confirmationHash}});
 expect(result.delivery?.id).toMatch(/^[a-f0-9]{64}$/);
 const reopened=tracked(file);expect(reopened.confirm(actor,r.id,r.hash,r.proposed.items)).toEqual(result);
 expect(reopened.summary(actor,'2026-10-15','half').salesCents).toBe(12345);
});
it('keeps old Web reports free of channel return intents',()=>{
 const {s}=setup(),r=s.receive(actor,'web-old','今天销售成交50元','2026-10-15');
 expect(s.confirm(actor,r.id,r.hash,r.proposed.items)).not.toHaveProperty('delivery');
});
it('does not create a notification or confirm a conflicting overlap',()=>{
 const {s}=setup(),first=s.receive(actor,'first','今天销售成交50元','2026-10-15');s.confirm(actor,first.id,first.hash,first.proposed.items);
 const r=s.receive(actor,'wecom-overlap','今天销售成交123.45元','2026-10-15',source);
 expect(()=>s.confirm(actor,r.id,r.hash,r.proposed.items)).toThrow('overlapping_report');
 expect(s.list(actor).find(x=>x.id===r.id)).toMatchObject({state:'pending',entries:[]});expect(s.list(actor).find(x=>x.id===r.id)).not.toHaveProperty('delivery');
});
it('claims once across database connections and never retries an accepted, uncertain or crashed attempt',()=>{
 for(const state of ['accepted','unknown','rejected','attempting'] as const){
  const {s,file}=setup(),r=s.receive(actor,'message','今天销售成交123.45元','2026-10-15',source);s.confirm(actor,r.id,r.hash,r.proposed.items);
  const claim=s.claimReturn(actor,r.id);expect(claim?.delivery).toMatchObject({state:'attempting',attempt:1});
  expect(tracked(file).claimReturn(actor,r.id)).toBeUndefined();
  if(state!=='attempting')s.finishReturn(actor,r.id,claim!.delivery!.id,1,{state,apiErrorCode:state==='accepted'?0:null,msgid:state==='accepted'?'synthetic-msgid':null,detail:'synthetic-reply'});
  expect(tracked(file).claimReturn(actor,r.id)).toBeUndefined();expect(s.summary(actor,'2026-10-15','half').salesCents).toBe(12345);
 }
});
it('allows only a definitively unsent blocked attempt to retry and refuses stale completion or another employee',()=>{
 const {s,file}=setup(),r=s.receive(actor,'message','今天销售成交123.45元','2026-10-15',source);s.confirm(actor,r.id,r.hash,r.proposed.items);
 expect(()=>s.claimReturn({...actor,employeeId:'synthetic-staff-2'},r.id)).toThrow('report_not_found');
 const a=s.claimReturn(actor,r.id)!;s.finishReturn(actor,r.id,a.delivery!.id,1,{state:'blocked',apiErrorCode:null,msgid:null,detail:'credential_unavailable'});
 const b=tracked(file).claimReturn(actor,r.id)!;expect(b.delivery?.attempt).toBe(2);
 expect(()=>s.finishReturn(actor,r.id,a.delivery!.id,1,{state:'accepted',apiErrorCode:0,msgid:'stale',detail:'api_accepted'})).toThrow('delivery_conflict');
 expect(s.list(actor)[0]?.delivery).toMatchObject({state:'attempting',attempt:2});
});
});

function tracked(file:string){const store=new ManagerStore(file);stores.push(store);const dir=path.dirname(file);if(!dirs.includes(dir))dirs.push(dir);return store;}
it('checks cancellation after waiting for a real SQLite writer lock',async()=>{
 const {s,file}=open();const r=receive(s);
 const worker=new Worker(`const {DatabaseSync}=require('node:sqlite');const {parentPort,workerData}=require('node:worker_threads');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');setTimeout(()=>{db.exec('COMMIT');db.close();},150);`,{eval:true,workerData:file});
 await new Promise<void>((resolve,reject)=>{worker.once('message',()=>resolve());worker.once('error',reject);});
 const deadline=Date.now()+50;
 try {expect(()=>s.confirm(actor,r.id,r.hash,r.proposed.items,()=>{if(Date.now()>deadline)throw Error('expired');})).toThrow('expired');expect(get(s,actor,r.id)?.state).toBe('pending');} finally {await worker.terminate();}
});
