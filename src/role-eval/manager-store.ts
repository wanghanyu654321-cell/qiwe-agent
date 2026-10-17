import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parseStaffReport,reportPeriod,validDate,type ReportItem} from './manager-report.js';
import type {BotReplyPlan} from './wecom-bot-transport.js';
export interface StaffContext {tenant:string;store:string;workspace:string;employeeId:string;employeeName:string;}
export interface ConfirmedEntry extends ReportItem {id:string;employeeId:string;employeeName:string;messageId:string;}
export interface StaffReportSource {kind:'wecom-employee';corpId:string;agentId:number;memberId:string;messageId:string;createTime:number;accountId:string;workspaceJid:string;storeId:string;bindingVersion:number;}
export interface BotReportSource {kind:'wecom-bot';corpId:string;botId:string;memberId:string;messageId:string;accountId:string;workspaceJid:string;storeId:string;bindingVersion:number;createTime?:number;}
export interface ReportDelivery {id:string;confirmationHash:string;state:'prepared'|'attempting'|'accepted'|'rejected'|'unknown'|'blocked';attempt:number;apiErrorCode:number|null;msgid:string|null;detail:string;ackReqId?:string;}
export type DeliveryOutcome=Pick<ReportDelivery,'state'|'apiErrorCode'|'msgid'|'detail'>&{ackReqId?:string};
export interface BotReplyTarget {corpId:string;botId:string;memberId:string;accountId:string;workspaceJid:string;storeId:string;bindingVersion:number;}
export interface BotReplyReservation {id:string;fingerprint:string;target:BotReplyTarget;reqId:string;}
export interface BotReplySeed {id:string;fingerprint:string;target:BotReplyTarget;reply:BotReplyPlan;reportId?:string;confirmation?:{reportId:string;deliveryId:string};}
export interface BotReplyIntent extends BotReplySeed {actor:StaffContext;delivery:ReportDelivery;reportAttempt?:number;}
interface ReservedBotReply {phase:'reserved';id:string;fingerprint:string;target:BotReplyTarget;actor:StaffContext;reply:{reqId:string};}
type StoredBotReply=BotReplyIntent|ReservedBotReply;
const reserved=(row:StoredBotReply):row is ReservedBotReply=>'phase' in row&&row.phase==='reserved';
export interface StaffReport {id:string;actor:StaffContext;messageId:string;text:string;date:string;hash:string;state:'pending'|'confirmed';proposed:ReturnType<typeof parseStaffReport>;entries:ConfirmedEntry[];createdAt:string;confirmationHash?:string;source?:StaffReportSource;botSource?:BotReportSource;delivery?:ReportDelivery;}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const onlyKeys=(v:unknown,keys:string[]):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
function validReplyTarget(target:BotReplyTarget){
 if(!onlyKeys(target,['corpId','botId','memberId','accountId','workspaceJid','storeId','bindingVersion'])||![target.corpId,target.botId,target.memberId,target.accountId,target.storeId].every(v=>bounded(v,120))||!bounded(target.workspaceJid,200)||!Number.isSafeInteger(target.bindingVersion)||target.bindingVersion<1)throw Error('invalid_bot_reply');
}
function replyReservation(raw:BotReplyReservation):BotReplyReservation {
 let input:BotReplyReservation;try{input=structuredClone(raw);}catch{throw Error('invalid_bot_reply');}
 if(!onlyKeys(input,['id','fingerprint','target','reqId'])||!digest(input.id)||!digest(input.fingerprint)||!bounded(input.reqId,200))throw Error('invalid_bot_reply');
 validReplyTarget(input.target);return input;
}
function replySeed(raw:BotReplySeed):BotReplySeed {
 let input:BotReplySeed;try{input=structuredClone(raw);}catch{throw Error('invalid_bot_reply');}
 if(!onlyKeys(input,['id','fingerprint','target','reply','reportId','confirmation'])||!digest(input.id)||!digest(input.fingerprint)||input.reportId!==undefined&&!digest(input.reportId))throw Error('invalid_bot_reply');
 const target=input.target,reply=input.reply;
 validReplyTarget(target);
 if(!onlyKeys(reply,['reqId','body'])||!bounded(reply.reqId,200)||!onlyKeys(reply.body,['msgtype','stream','template_card']))throw Error('invalid_bot_reply');
 const body=reply.body,stream=body.stream,card=body.template_card;
 if(!['stream','stream_with_template_card'].includes(body.msgtype)||!onlyKeys(stream,['id','finish','content'])||!bounded(stream.id,200)||stream.finish!==true||typeof stream.content!=='string'||!stream.content.trim()||stream.content.length>32000)throw Error('invalid_bot_reply');
 if(body.msgtype==='stream_with_template_card'){
  if(!onlyKeys(card,['card_type','main_title','task_id','button_list'])||card.card_type!=='button_interaction'||!onlyKeys(card.main_title,['title'])||!bounded(card.main_title.title,200)||!bounded(card.task_id,200)||!Array.isArray(card.button_list)||card.button_list.length<1||card.button_list.length>6||card.button_list.some(b=>!onlyKeys(b,['text','key','style'])||!bounded(b.text,200)||!bounded(b.key,200)||b.style!==1))throw Error('invalid_bot_reply');
 }else if(card!==undefined)throw Error('invalid_bot_reply');
 if(input.confirmation!==undefined&&(!onlyKeys(input.confirmation,['reportId','deliveryId'])||!digest(input.confirmation.reportId)||!digest(input.confirmation.deliveryId)||input.confirmation.reportId!==input.reportId))throw Error('delivery_conflict');
 return input;
}
function deliveryOutcome(raw:DeliveryOutcome):DeliveryOutcome {
 let result:DeliveryOutcome;try{result=structuredClone(raw);}catch{throw Error('delivery_conflict');}
 if(!onlyKeys(result,['state','apiErrorCode','msgid','detail','ackReqId'])||!['accepted','rejected','unknown','blocked'].includes(result.state)||result.apiErrorCode!==null&&!Number.isSafeInteger(result.apiErrorCode)||result.msgid!==null&&!bounded(result.msgid,1024)||!bounded(result.detail,2048)||result.ackReqId!==undefined&&!bounded(result.ackReqId,200))throw Error('delivery_conflict');
 return result;
}
function nextAttempt(delivery:ReportDelivery):ReportDelivery {
 if(!Number.isSafeInteger(delivery.attempt)||delivery.attempt<0||delivery.attempt===Number.MAX_SAFE_INTEGER)throw Error('delivery_conflict');
 return {...delivery,state:'attempting',attempt:delivery.attempt+1,detail:'attempt_started'};
}
function scope(a:StaffContext){for(const value of [a.tenant,a.store,a.workspace,a.employeeId,a.employeeName])if(typeof value!=='string'||!value.trim()||value.length>120)throw Error('invalid_staff_context');return JSON.stringify([a.tenant,a.store,a.workspace]);}
function validItems(input:unknown):ReportItem[]{
 if(!Array.isArray(input)||input.length<1||input.length>10)throw Error('invalid_report_item');
 return input.map((v:ReportItem)=>{
  if(!v||Object.keys(v).some(k=>!['kind','start','end','amountCents','mode','supersedes'].includes(k))||!['target','sales'].includes(v.kind)||!['snapshot','increment'].includes(v.mode)||v.kind==='target'&&v.mode!=='snapshot'||!validDate(v.start)||!validDate(v.end)||v.start>v.end||!Number.isSafeInteger(v.amountCents)||v.amountCents<0||v.supersedes!==undefined&&(typeof v.supersedes!=='string'||!/^[a-f0-9]{64}:\d$/.test(v.supersedes)))throw Error('invalid_report_item');
  return {kind:v.kind,start:v.start,end:v.end,amountCents:v.amountCents,mode:v.mode,...(v.supersedes?{supersedes:v.supersedes}:{})};
 });
}
const overlap=(a:ReportItem,b:ReportItem)=>a.start<=b.end&&b.start<=a.end;
function sum(values:number[]){const n=values.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(n))throw Error('sales_amount_overflow');return n;}
function fullCoverage(items:ReportItem[],start:string,end:string){
 let cursor=start;for(const i of [...items].sort((a,b)=>a.start.localeCompare(b.start))){if(i.start>cursor)return false;if(i.end>=cursor)cursor=new Date(Date.parse(i.end+'T00:00:00Z')+86400000).toISOString().slice(0,10);}return cursor>end;
}
export class ManagerStore {
 private db:DatabaseSync;
 constructor(file:string){this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS employee_reports (id TEXT PRIMARY KEY, scope TEXT NOT NULL, employee TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bot_reply_intents (id TEXT PRIMARY KEY, scope TEXT NOT NULL, employee TEXT NOT NULL, body TEXT NOT NULL);');}
 close(){this.db.close();}
 receive(actor:StaffContext,messageId:string,text:string,date:string,source?:StaffReportSource,checkActive?:()=>void):StaffReport {
  return this.receiveInternal(actor,messageId,text,date,source,checkActive);
 }
 receiveBot(actor:StaffContext,messageId:string,text:string,date:string,source:BotReportSource,checkActive?:()=>void):StaffReport {
  const keys=['kind','corpId','botId','memberId','messageId','accountId','workspaceJid','storeId','bindingVersion','createTime'];
  if(!source||source.kind!=='wecom-bot'||Object.keys(source).some(k=>!keys.includes(k))||[source.corpId,source.botId,source.memberId,source.messageId,source.accountId,source.workspaceJid,source.storeId].some(v=>typeof v!=='string'||!v.trim())||!Number.isSafeInteger(source.bindingVersion)||source.bindingVersion<1||source.createTime!==undefined&&(!Number.isSafeInteger(source.createTime)||source.createTime<0))throw Error('invalid_bot_source');
  return this.receiveInternal(actor,messageId,text,date,undefined,checkActive,{...source});
 }
 private receiveInternal(actor:StaffContext,messageId:string,text:string,date:string,source?:StaffReportSource,checkActive?:()=>void,botSource?:BotReportSource):StaffReport {
  const s=scope(actor);if(!/^[A-Za-z0-9_-]{1,100}$/.test(messageId))throw Error('invalid_message_id');
  const id=hash(s+'|'+actor.employeeId+'|'+messageId);
  checkActive?.();this.db.exec('BEGIN IMMEDIATE');try{
   checkActive?.();
   // Original channel identity survives employee remapping. The existing write
   // transaction serializes this lookup with insertion without another ledger.
   const originals=botSource?this.db.prepare("SELECT body FROM employee_reports WHERE json_extract(body,'$.botSource.kind')=? AND json_extract(body,'$.botSource.corpId')=? AND json_extract(body,'$.botSource.botId')=? AND json_extract(body,'$.botSource.memberId')=? AND json_extract(body,'$.botSource.messageId')=?").all(botSource.kind,botSource.corpId,botSource.botId,botSource.memberId,botSource.messageId) as {body:string}[]:source?this.db.prepare("SELECT body FROM employee_reports WHERE scope=? AND json_extract(body,'$.source.kind')=? AND json_extract(body,'$.source.corpId')=? AND json_extract(body,'$.source.agentId')=? AND json_extract(body,'$.source.memberId')=? AND json_extract(body,'$.source.messageId')=?").all(s,source.kind,source.corpId,source.agentId,source.memberId,source.messageId) as {body:string}[]:[];
   if(originals.length>1)throw Error('message_conflict');
   const original=originals[0],existing=original?JSON.parse(original.body) as StaffReport:this.get(actor,id);
   if(existing){if(existing.actor.employeeId!==actor.employeeId||existing.messageId!==messageId||existing.text!==text||!isDeepStrictEqual(existing.source,source)||botSource&&(scope(existing.actor)!==s||!existing.botSource||!isDeepStrictEqual({...existing.botSource,bindingVersion:0},{...botSource,bindingVersion:0}))||!botSource&&existing.botSource!==undefined)throw Error('message_conflict');checkActive?.();this.db.exec('COMMIT');return existing;}
   const proposed=parseStaffReport(text,date),digest=hash(JSON.stringify({text,date}));
   const r:StaffReport={id,actor:{...actor},messageId,text,date,hash:digest,state:'pending',proposed,entries:[],createdAt:new Date().toISOString(),...(source?{source:{...source}}:{}),...(botSource?{botSource:{...botSource}}:{})};
   this.db.prepare('INSERT INTO employee_reports VALUES (?,?,?,?)').run(id,s,actor.employeeId,JSON.stringify(r));checkActive?.();this.db.exec('COMMIT');return r;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 getReport(actor:StaffContext,id:string):StaffReport|undefined {return this.get(actor,id);}
 private get(actor:StaffContext,id:string):StaffReport|undefined {const row=this.db.prepare('SELECT body FROM employee_reports WHERE id=? AND scope=? AND employee=?').get(id,scope(actor),actor.employeeId) as {body:string}|undefined;return row?JSON.parse(row.body):undefined;}
 list(actor:StaffContext):StaffReport[]{return (this.db.prepare('SELECT body FROM employee_reports WHERE scope=? ORDER BY rowid DESC').all(scope(actor)) as {body:string}[]).map(r=>JSON.parse(r.body) as StaffReport);}
 private active(actor:StaffContext):ConfirmedEntry[]{const all=this.list(actor).filter(r=>r.state==='confirmed').flatMap(r=>r.entries);const old=new Set(all.flatMap(e=>e.supersedes?[e.supersedes]:[]));return all.filter(e=>!old.has(e.id));}
 confirm(actor:StaffContext,id:string,expectedHash:string,input:ReportItem[],checkActive?:()=>void):StaffReport {
  const items=validItems(input),digest=hash(JSON.stringify(items));
  this.db.exec('BEGIN IMMEDIATE');try{
   checkActive?.();
   const r=this.get(actor,id);if(!r)throw Error('report_not_found');if(r.hash!==expectedHash)throw Error('report_version_conflict');
   if(r.state==='confirmed'){if(r.confirmationHash!==digest)throw Error('confirmation_conflict');checkActive?.();this.db.exec('COMMIT');return r;}
   let active=this.active(actor);
   const entries:ConfirmedEntry[]=[];
   for(const [index,item] of items.entries()){
    if(item.supersedes){const original=active.find(e=>e.id===item.supersedes);if(!original||original.employeeId!==actor.employeeId||original.kind!==item.kind)throw Error('correction_conflict');active=active.filter(e=>e.id!==item.supersedes);}
    if(active.some(e=>e.employeeId===actor.employeeId&&e.kind===item.kind&&overlap(e,item)&&(e.mode!=='increment'||item.mode!=='increment')))throw Error('overlapping_report');
    const entry={...item,id:id+':'+index,employeeId:actor.employeeId,employeeName:actor.employeeName,messageId:r.messageId};entries.push(entry);active.push(entry);
   }
   const next:StaffReport={...r,state:'confirmed',entries,confirmationHash:digest,...(r.source||r.botSource?{delivery:{id:hash('manager-return|'+id+'|'+digest),confirmationHash:digest,state:'prepared' as const,attempt:0,apiErrorCode:null,msgid:null,detail:'awaiting_dispatch'}}:{})};this.db.prepare('UPDATE employee_reports SET body=? WHERE id=?').run(JSON.stringify(next),id);checkActive?.();this.db.exec('COMMIT');return next;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 private changeReturn(actor:StaffContext,id:string,change:(r:StaffReport)=>StaffReport|undefined,checkActive?:()=>void):StaffReport|undefined{
  this.db.exec('BEGIN IMMEDIATE');try{
   checkActive?.();
   const r=this.get(actor,id);if(!r)throw Error('report_not_found');
   if(r.state!=='confirmed'||!r.source&&!r.botSource||!r.delivery||r.delivery.confirmationHash!==r.confirmationHash)throw Error('delivery_conflict');
   const next=change(r);if(next)this.db.prepare('UPDATE employee_reports SET body=? WHERE id=?').run(JSON.stringify(next),id);
   checkActive?.();this.db.exec('COMMIT');return next;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 claimReturn(actor:StaffContext,id:string,checkActive?:()=>void):StaffReport|undefined{
  return this.changeReturn(actor,id,r=>['prepared','blocked'].includes(r.delivery!.state)?{...r,delivery:nextAttempt(r.delivery!)}:undefined,checkActive);
 }
 finishReturn(actor:StaffContext,id:string,deliveryId:string,attempt:number,result:DeliveryOutcome):StaffReport|undefined{
  const receipt=deliveryOutcome(result);
  return this.changeReturn(actor,id,r=>{
   if(r.delivery!.id!==deliveryId||r.delivery!.attempt!==attempt||r.delivery!.state!=='attempting')throw Error('delivery_conflict');
   return {...r,delivery:{...r.delivery!,...receipt}};
  });
 }
 getBotReply(actor:StaffContext,id:string):BotReplyIntent|undefined {
  const row=this.db.prepare('SELECT body FROM bot_reply_intents WHERE id=? AND scope=? AND employee=?').get(id,scope(actor),actor.employeeId) as {body:string}|undefined;
  const record=row?JSON.parse(row.body) as StoredBotReply:undefined;
  return record&&!reserved(record)?record:undefined;
 }
 private linkedReport(actor:StaffContext,seed:BotReplySeed):StaffReport {
  const report=seed.confirmation&&this.get(actor,seed.confirmation.reportId),src=report?.botSource;
  if(!report||report.state!=='confirmed'||!src||!report.delivery||report.delivery.confirmationHash!==report.confirmationHash||seed.confirmation!.reportId!==seed.reportId||report.delivery.id!==seed.confirmation!.deliveryId||!isDeepStrictEqual({corpId:src.corpId,botId:src.botId,memberId:src.memberId,accountId:src.accountId,workspaceJid:src.workspaceJid,storeId:src.storeId,bindingVersion:src.bindingVersion},seed.target))throw Error('delivery_conflict');
  return report;
 }
 private saveBotReply(intent:StoredBotReply){this.db.prepare('UPDATE bot_reply_intents SET body=? WHERE id=?').run(JSON.stringify(intent),intent.id);}
 reserveBotReply(actor:StaffContext,input:BotReplyReservation,checkActive?:()=>void):void {
  const owner={...actor},s=scope(owner),reservation=replyReservation(input);
  this.db.exec('BEGIN IMMEDIATE');try{
   checkActive?.();
   const row=this.db.prepare('SELECT body FROM bot_reply_intents WHERE id=?').get(reservation.id) as {body:string}|undefined;
   const existing=row?JSON.parse(row.body) as StoredBotReply:undefined;
   if(existing&&(scope(existing.actor)!==s||existing.actor.employeeId!==owner.employeeId||existing.fingerprint!==reservation.fingerprint||!isDeepStrictEqual(existing.target,reservation.target)))throw Error('bot_reply_conflict');
   if(this.db.prepare("SELECT id FROM bot_reply_intents WHERE id<>? AND json_extract(body,'$.reply.reqId')=? LIMIT 1").get(reservation.id,reservation.reqId))throw Error('bot_reply_conflict');
   // An unfinished reservation deliberately has neither a body nor a delivery.
   // It fixes provenance before business work and cannot be dispatched.
   if(!existing){const next:ReservedBotReply={phase:'reserved',id:reservation.id,fingerprint:reservation.fingerprint,target:reservation.target,actor:owner,reply:{reqId:reservation.reqId}};this.db.prepare('INSERT INTO bot_reply_intents VALUES (?,?,?,?)').run(next.id,s,owner.employeeId,JSON.stringify(next));}
   else if(reserved(existing)&&existing.reply.reqId!==reservation.reqId)this.saveBotReply({...existing,reply:{reqId:reservation.reqId}});
   checkActive?.();this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 prepareBotReply(actor:StaffContext,input:BotReplySeed,checkActive?:()=>void):BotReplyIntent {
  const owner={...actor},s=scope(owner),seed=replySeed(input);
  this.db.exec('BEGIN IMMEDIATE');try{
   checkActive?.();
   // Global event ownership and req_id checks share the write lock, including
   // across employees/scopes and route refreshes on another connection.
   const row=this.db.prepare('SELECT body FROM bot_reply_intents WHERE id=?').get(seed.id) as {body:string}|undefined;
   const record=row?JSON.parse(row.body) as StoredBotReply:undefined;
   if(record&&(scope(record.actor)!==s||record.actor.employeeId!==owner.employeeId||record.fingerprint!==seed.fingerprint||!isDeepStrictEqual(record.target,seed.target)))throw Error('bot_reply_conflict');
   const existing=record&&!reserved(record)?record:undefined;
   if(existing&&(existing.reportId!==seed.reportId||!isDeepStrictEqual(existing.confirmation,seed.confirmation)))throw Error('bot_reply_conflict');
   if(seed.confirmation)this.linkedReport(owner,seed);
   const refresh=!existing||['prepared','blocked'].includes(existing.delivery.state);
   if(refresh&&this.db.prepare("SELECT id FROM bot_reply_intents WHERE id<>? AND json_extract(body,'$.reply.reqId')=? LIMIT 1").get(seed.id,seed.reply.reqId))throw Error('bot_reply_conflict');
   const next:BotReplyIntent=existing?(refresh?{...existing,reply:seed.reply}:existing):{...seed,actor:record?.actor??owner,delivery:{id:hash('bot-reply|'+seed.id),confirmationHash:seed.fingerprint,state:'prepared',attempt:0,apiErrorCode:null,msgid:null,detail:'awaiting_dispatch'}};
   if(record){if(refresh)this.saveBotReply(next);}else this.db.prepare('INSERT INTO bot_reply_intents VALUES (?,?,?,?)').run(seed.id,s,owner.employeeId,JSON.stringify(next));
   checkActive?.();this.db.exec('COMMIT');return next;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 claimBotReply(actor:StaffContext,id:string,checkActive?:()=>void):BotReplyIntent|undefined {
  this.db.exec('BEGIN IMMEDIATE');try{
   checkActive?.();const current=this.getBotReply(actor,id);let next:BotReplyIntent|undefined;
   if(current&&['prepared','blocked'].includes(current.delivery.state)){
    const report=current.confirmation?this.linkedReport(actor,current):undefined;
    if(!report||['prepared','blocked'].includes(report.delivery!.state)){
     let reportAttempt:number|undefined;
     if(report){const delivery=nextAttempt(report.delivery!);reportAttempt=delivery.attempt;this.db.prepare('UPDATE employee_reports SET body=? WHERE id=?').run(JSON.stringify({...report,delivery}),report.id);}
     next={...current,delivery:nextAttempt(current.delivery),...(reportAttempt!==undefined?{reportAttempt}:{})};this.saveBotReply(next);
    }
   }
   checkActive?.();this.db.exec('COMMIT');return next;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 finishBotReply(actor:StaffContext,id:string,deliveryId:string,attempt:number,result:DeliveryOutcome):BotReplyIntent|undefined {
  const receipt=deliveryOutcome(result);
  this.db.exec('BEGIN IMMEDIATE');try{
   const current=this.getBotReply(actor,id);
   if(!current||current.delivery.id!==deliveryId||current.delivery.attempt!==attempt||current.delivery.state!=='attempting')throw Error('delivery_conflict');
   if(current.confirmation){
    const report=this.linkedReport(actor,current);
    if(report.delivery!.state!=='attempting'||report.delivery!.attempt!==current.reportAttempt)throw Error('delivery_conflict');
    this.db.prepare('UPDATE employee_reports SET body=? WHERE id=?').run(JSON.stringify({...report,delivery:{...report.delivery!,...receipt}}),report.id);
   }
   const next={...current,delivery:{...current.delivery,...receipt}};this.saveBotReply(next);
   this.db.exec('COMMIT');return next;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 summary(actor:StaffContext,date:string,kind:string,roster:StaffContext[]=[]){
  const period=reportPeriod(date,kind),all=this.active(actor).filter(i=>overlap(i,{...period,kind:'sales',amountCents:0,mode:'snapshot'}));
  const incompatible=all.filter(i=>i.start<period.start||i.end>period.end);
  const entries=all.filter(i=>i.start>=period.start&&i.end<=period.end);
  for(const member of roster)if(scope(member)!==scope(actor))throw Error('invalid_staff_roster');
  const employeeIds=[...new Set([...roster.map(e=>e.employeeId),...all.map(e=>e.employeeId)])];
  const rows=employeeIds.map(employeeId=>{const selected=entries.filter(e=>e.employeeId===employeeId),sales=selected.filter(e=>e.kind==='sales'),targets=selected.filter(e=>e.kind==='target');const source=roster.find(e=>e.employeeId===employeeId)??all.find(e=>e.employeeId===employeeId)!;
   const salesCents=incompatible.some(e=>e.employeeId===employeeId&&e.kind==='sales')||!sales.length?null:sum(sales.map(e=>e.amountCents));
   const targetCents=incompatible.some(e=>e.employeeId===employeeId&&e.kind==='target')||!fullCoverage(targets,period.start,period.end)?null:sum(targets.map(e=>e.amountCents));
   return {employeeId,employeeName:source.employeeName,salesCents,targetCents,rate:salesCents!==null&&targetCents!==null&&targetCents>0?salesCents/targetCents:null,coverage:fullCoverage(sales,period.start,period.end)?'complete':'partial'};
  });
  const salesCents=rows.some(r=>r.salesCents!==null)?sum(rows.flatMap(r=>r.salesCents===null?[]:[r.salesCents])):null;
  const targetCents=rows.length&&rows.every(r=>r.targetCents!==null)?sum(rows.map(r=>r.targetCents!)):null;
  const comparable=salesCents!==null&&rows.every(r=>r.salesCents!==null)&&targetCents!==null;
  const snapshotHash=hash(JSON.stringify({scope:scope(actor),period,entries,rows}));
  return {scope:{tenant:actor.tenant,store:actor.store,workspace:actor.workspace},metric:'sales-turnover/v1' as const,period,kind,salesCents,targetCents,rate:comparable&&targetCents!>0?salesCents!/targetCents!:null,varianceCents:comparable?salesCents!-targetCents!:null,coverage:rows.length&&rows.every(r=>r.coverage==='complete')?'complete':'partial',rows,entries,incompatible,snapshotHash,observedAt:new Date().toISOString()};
 }
}
