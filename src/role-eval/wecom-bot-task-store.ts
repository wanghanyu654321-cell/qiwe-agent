import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual, types} from 'node:util';
import {WORKBENCH_ROLES, type WorkbenchRole} from './workbench-access.js';
import {createHash} from 'node:crypto';

export type BotConversationActor={tenantId:string;storeId:string;accountId:string;corpId:string;botId:string;memberId:string;bindingVersion:number;grantVersion:number};
export type BotConversationEvent={messageId:string;fingerprint:string;actor:BotConversationActor;role:WorkbenchRole};
export type BotConversationRecord={eventId:string;fingerprint:string;actor:BotConversationActor;role:WorkbenchRole;state:'preparing'|'attempting'|'unknown'|'ready'|'stale';workspaceJid?:string;profileId?:string};
const conversationKey=(values:unknown[])=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
function conversationActor(value:BotConversationActor){
 const a=snapshot(value) as BotConversationActor;
 shape(a,['tenantId','storeId','accountId','corpId','botId','memberId','bindingVersion','grantVersion']);
 for(const key of ['tenantId','storeId','accountId','corpId','botId','memberId'] as const)check(identifier(a[key],120));
 check(count(a.bindingVersion,1)&&count(a.grantVersion,1));return a;
}
function conversationEvent(value:BotConversationEvent){
 const e=snapshot(value) as BotConversationEvent;shape(e,['messageId','fingerprint','actor','role']);
 check(identifier(e.messageId,200)&&digest(e.fingerprint)&&WORKBENCH_ROLES.includes(e.role));
 e.actor=conversationActor(e.actor);return e;
}

export type BotTaskOwner={tenantId:string;storeId:string;accountId:string;workspaceJid:string;role:WorkbenchRole;corpId:string;botId:string;memberId:string;bindingVersion:number};
export type BotTaskInput={kind:'native';alias:string}|{kind:'training';mode:'question'|'lesson';query:string;persona:'instructor'|'executive'|'chief'};
export type BotTaskBackend={kind:'native';taskId:string;profileId:string;workspaceJid:string}|{kind:'training';requestKey:string};
export type BotTaskRecord={id:string;fingerprint:string;owner:BotTaskOwner;input:BotTaskInput;backend:BotTaskBackend;state:'reserved'|'attempting'|'linked'|'blocked'|'unknown';attempt:number;referenceId:string|null;detail:string;cancellation:{state:'none'|'attempting'|'requested'|'blocked'|'unknown';attempt:number;detail:string}};
export type BotTaskReservation=Pick<BotTaskRecord,'id'|'fingerprint'|'owner'|'input'|'backend'>;
export type BotTaskStartOutcome={state:'linked';referenceId:string;detail:string}|{state:'blocked'|'unknown';detail:string};
export type BotTaskCancelOutcome={state:'requested'|'blocked'|'unknown';detail:string};

const invalid=():never=>{throw Error('invalid_task_reference');};
function check(value:unknown):asserts value{if(!value)invalid();}

// Read data descriptors once. Accessors, proxies, symbols and hidden fields are
// rejected without invoking caller code during identity validation or SQL writes.
function snapshot(value:unknown,depth=0):unknown{
 if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;
 check(typeof value==='object'&&value!==null&&!types.isProxy(value)&&depth<6);
 check(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
 const keys=Reflect.ownKeys(value);check(keys.length<=20);
 const entries=keys.map(key=>{
  check(typeof key==='string');const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
  check(descriptor.enumerable&&'value' in descriptor);
  return [key,snapshot(descriptor.value,depth+1)];
 });
 return Object.fromEntries(entries);
}
function shape(value:unknown,keys:readonly string[]):Record<string,unknown>{
 check(typeof value==='object'&&value!==null&&!Array.isArray(value));
 const record=value as Record<string,unknown>;const actual=Object.keys(record);
 check(actual.length===keys.length&&actual.every(key=>keys.includes(key)));return record;
}
function text(value:unknown,max:number,empty=false):value is string{
 return typeof value==='string'&&value.length<=max&&(empty||value.trim().length>0)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function identifier(value:unknown,max:number):value is string{
 return text(value,max)&&!/[\s/\\]/.test(value)&&!value.includes('..');
}
function digest(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function count(value:unknown,min=0):value is number{return Number.isSafeInteger(value)&&Number(value)>=min;}
function validateOwner(value:unknown):BotTaskOwner{
 const o=shape(value,['tenantId','storeId','accountId','workspaceJid','role','corpId','botId','memberId','bindingVersion']);
 for(const key of ['tenantId','storeId','accountId','corpId','botId','memberId'])check(identifier(o[key],120));
 check(identifier(o.workspaceJid,200)&&WORKBENCH_ROLES.includes(o.role as WorkbenchRole)&&count(o.bindingVersion,1));
 return o as BotTaskOwner;
}
function validateReservation(value:unknown):BotTaskReservation{
 const r=shape(value,['id','fingerprint','owner','input','backend']);check(digest(r.id)&&digest(r.fingerprint));const owner=validateOwner(r.owner);
 const input=shape(r.input,(r.input as BotTaskInput)?.kind==='native'?['kind','alias']:['kind','mode','query','persona']);
 if(input.kind==='native')check(typeof input.alias==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(input.alias));
 else check(input.kind==='training'&&owner.role==='training'&&['question','lesson'].includes(input.mode as string)&&text(input.query,4000)&&['instructor','executive','chief'].includes(input.persona as string));
 const backend=shape(r.backend,(r.backend as BotTaskBackend)?.kind==='native'?['kind','taskId','profileId','workspaceJid']:['kind','requestKey']);
 check(backend.kind===input.kind);
 if(backend.kind==='native')check(identifier(backend.taskId,200)&&identifier(backend.profileId,200)&&identifier(backend.workspaceJid,200));
 else check(backend.kind==='training'&&identifier(backend.requestKey,80));
 return r as BotTaskReservation;
}
function validateRecord(value:unknown):BotTaskRecord{
 const r=shape(value,['id','fingerprint','owner','input','backend','state','attempt','referenceId','detail','cancellation']);
 validateReservation({id:r.id,fingerprint:r.fingerprint,owner:r.owner,input:r.input,backend:r.backend});
 check(['reserved','attempting','linked','blocked','unknown'].includes(r.state as string)&&count(r.attempt)&&text(r.detail,2000,true));
 check(r.state==='reserved'?r.attempt===0:Number(r.attempt)>0);
 check(r.state==='linked'?identifier(r.referenceId,200):r.referenceId===null);
 const cancellation=shape(r.cancellation,['state','attempt','detail']);
 check(['none','attempting','requested','blocked','unknown'].includes(cancellation.state as string)&&count(cancellation.attempt)&&text(cancellation.detail,2000,true));
 check(cancellation.state==='none'?cancellation.attempt===0:Number(cancellation.attempt)>0);
 check(r.state==='linked'||cancellation.state==='none');return r as BotTaskRecord;
}
function startOutcome(value:unknown):BotTaskStartOutcome{
 const raw=snapshot(value);const o=shape(raw,(raw as BotTaskStartOutcome)?.state==='linked'?['state','referenceId','detail']:['state','detail']);
 check(text(o.detail,2000,true));
 if(o.state==='linked')check(identifier(o.referenceId,200));else check(o.state==='blocked'||o.state==='unknown');
 return o as BotTaskStartOutcome;
}
function cancelOutcome(value:unknown):BotTaskCancelOutcome{
 const o=shape(snapshot(value),['state','detail']);check(['requested','blocked','unknown'].includes(o.state as string)&&text(o.detail,2000,true));return o as BotTaskCancelOutcome;
}

/** Durable channel references only; no backend execution, scheduler or retries. */
export class BotTaskStore {
 private db:DatabaseSync;
 constructor(file:string){
  check(typeof file==='string'&&file.trim().length>0&&!file.includes('\u0000'));
  this.db=new DatabaseSync(file);
  try{this.db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS bot_task_refs(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bot_conversation_events(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bot_conversation_current(id TEXT PRIMARY KEY,event_id TEXT NOT NULL);');}catch(error){this.db.close();throw error;}
 }
 private transaction<T>(work:()=>T,guard?:()=>void):T{
  this.db.exec('BEGIN IMMEDIATE');
  try{guard?.();const result=work();guard?.();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private read(id:string):BotTaskRecord|undefined{
  const row=this.db.prepare('SELECT body FROM bot_task_refs WHERE id=?').get(id) as {body:string}|undefined;
  if(!row)return undefined;
  let value:unknown;try{value=JSON.parse(row.body);}catch{invalid();}
  const result=validateRecord(value);check(result.id===id);return result;
 }
 private owned(owner:BotTaskOwner,id:string):BotTaskRecord|undefined{
  const record=this.read(id);return record&&isDeepStrictEqual(record.owner,owner)?record:undefined;
 }
 private save(record:BotTaskRecord):void{this.db.prepare('UPDATE bot_task_refs SET body=? WHERE id=?').run(JSON.stringify(record),record.id);}
 reserve(input:BotTaskReservation,guard?:()=>void):BotTaskRecord{
  const seed=validateReservation(snapshot(input));
  return this.transaction(()=>{
   const previous=this.read(seed.id);
   if(previous){const original={id:previous.id,fingerprint:previous.fingerprint,owner:previous.owner,input:previous.input,backend:previous.backend};if(!isDeepStrictEqual(original,seed))throw Error('task_conflict');return previous;}
   const record:BotTaskRecord={...seed,state:'reserved',attempt:0,referenceId:null,detail:'',cancellation:{state:'none',attempt:0,detail:''}};
   this.db.prepare('INSERT INTO bot_task_refs(id,body) VALUES (?,?)').run(record.id,JSON.stringify(record));return record;
  },guard);
 }
 get(owner:BotTaskOwner,id:string):BotTaskRecord|undefined{
  const trusted=validateOwner(snapshot(owner));check(digest(id));return this.owned(trusted,id);
 }
 claimStart(owner:BotTaskOwner,id:string,guard?:()=>void):BotTaskRecord|undefined{
  const trusted=validateOwner(snapshot(owner));check(digest(id));
  return this.transaction(()=>{
   const record=this.owned(trusted,id);if(!record||!['reserved','blocked'].includes(record.state))return undefined;
   check(record.attempt<Number.MAX_SAFE_INTEGER);record.state='attempting';record.attempt++;this.save(record);return record;
  },guard);
 }
 finishStart(owner:BotTaskOwner,id:string,attempt:number,outcome:BotTaskStartOutcome):BotTaskRecord{
  const trusted=validateOwner(snapshot(owner));check(digest(id)&&count(attempt,1));const result=startOutcome(outcome);
  return this.transaction(()=>{
   const record=this.owned(trusted,id);if(!record||record.state!=='attempting'||record.attempt!==attempt)throw Error('task_attempt_conflict');
   record.state=result.state;record.referenceId=result.state==='linked'?result.referenceId:null;record.detail=result.detail;this.save(record);return record;
  });
 }
 claimCancel(owner:BotTaskOwner,id:string,guard?:()=>void):BotTaskRecord|undefined{
  const trusted=validateOwner(snapshot(owner));check(digest(id));
  return this.transaction(()=>{
   const record=this.owned(trusted,id);if(!record||record.state!=='linked'||!['none','blocked'].includes(record.cancellation.state))return undefined;
   check(record.cancellation.attempt<Number.MAX_SAFE_INTEGER);record.cancellation.state='attempting';record.cancellation.attempt++;this.save(record);return record;
  },guard);
 }
 finishCancel(owner:BotTaskOwner,id:string,attempt:number,outcome:BotTaskCancelOutcome):BotTaskRecord{
  const trusted=validateOwner(snapshot(owner));check(digest(id)&&count(attempt,1));const result=cancelOutcome(outcome);
  return this.transaction(()=>{
   const record=this.owned(trusted,id);if(!record||record.state!=='linked'||record.cancellation.state!=='attempting'||record.cancellation.attempt!==attempt)throw Error('task_attempt_conflict');
   record.cancellation={...record.cancellation,...result};this.save(record);return record;
  });
 }
 private conversationEvent(id:string):BotConversationRecord|undefined{
  const row=this.db.prepare('SELECT body FROM bot_conversation_events WHERE id=?').get(id) as {body:string}|undefined;
  return row?JSON.parse(row.body) as BotConversationRecord:undefined;
 }
 private currentConversationEvent(key:string):BotConversationRecord|undefined{
  const row=this.db.prepare('SELECT event_id FROM bot_conversation_current WHERE id=?').get(key) as {event_id:string}|undefined;
  return row?this.conversationEvent(row.event_id):undefined;
 }
 beginConversationSelection(input:BotConversationEvent,guard?:()=>void):BotConversationRecord{
  const seed=conversationEvent(input),eventId=conversationKey([seed.actor.corpId,seed.actor.botId,seed.actor.memberId,seed.messageId]);
  const key=conversationKey([seed.actor.corpId,seed.actor.botId,seed.actor.memberId]);
  return this.transaction(()=>{
   const previous=this.conversationEvent(eventId);
   if(previous){if(previous.fingerprint!==seed.fingerprint||!isDeepStrictEqual(previous.actor,seed.actor)||previous.role!==seed.role)throw Error('conversation_conflict');return previous;}
   const record:BotConversationRecord={eventId,fingerprint:seed.fingerprint,actor:seed.actor,role:seed.role,state:'preparing'};
   this.db.prepare('INSERT INTO bot_conversation_events(id,body) VALUES (?,?)').run(eventId,JSON.stringify(record));
   this.db.prepare('INSERT INTO bot_conversation_current(id,event_id) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET event_id=excluded.event_id').run(key,eventId);
   return record;
  },guard);
 }
 claimConversationPreparation(input:BotConversationEvent,guard?:()=>void):boolean{
  const seed=conversationEvent(input),eventId=conversationKey([seed.actor.corpId,seed.actor.botId,seed.actor.memberId,seed.messageId]);
  const key=conversationKey([seed.actor.corpId,seed.actor.botId,seed.actor.memberId]);
  return this.transaction(()=>{
   const record=this.conversationEvent(eventId);
   if(!record||record.fingerprint!==seed.fingerprint||record.role!==seed.role||!isDeepStrictEqual(record.actor,seed.actor))throw Error('conversation_conflict');
   if(record.state!=='preparing'||this.currentConversationEvent(key)?.eventId!==eventId)return false;
   record.state='attempting';this.db.prepare('UPDATE bot_conversation_events SET body=? WHERE id=?').run(JSON.stringify(record),eventId);return true;
  },guard);
 }
 markConversationUnknown(input:BotConversationEvent,guard?:()=>void):void{
  const seed=conversationEvent(input),eventId=conversationKey([seed.actor.corpId,seed.actor.botId,seed.actor.memberId,seed.messageId]);
  this.transaction(()=>{
   const record=this.conversationEvent(eventId);
   if(!record||record.fingerprint!==seed.fingerprint||record.role!==seed.role||!isDeepStrictEqual(record.actor,seed.actor))throw Error('conversation_conflict');
   if(record.state==='ready')return;
   record.state='unknown';this.db.prepare('UPDATE bot_conversation_events SET body=? WHERE id=?').run(JSON.stringify(record),eventId);
  },guard);
 }
 finishConversationSelection(input:BotConversationEvent,result:{workspaceJid:string;profileId:string},guard?:()=>void):BotConversationRecord{
  const seed=conversationEvent(input),eventId=conversationKey([seed.actor.corpId,seed.actor.botId,seed.actor.memberId,seed.messageId]);
  const key=conversationKey([seed.actor.corpId,seed.actor.botId,seed.actor.memberId]);
  check(identifier(result.workspaceJid,200)&&result.workspaceJid.startsWith('web:')&&!result.workspaceJid.startsWith('web:home')&&identifier(result.profileId,200));
  return this.transaction(()=>{
   const record=this.conversationEvent(eventId);
   if(!record||record.fingerprint!==seed.fingerprint||record.role!==seed.role||!isDeepStrictEqual(record.actor,seed.actor))throw Error('conversation_conflict');
   if(record.state==='ready'){
    if(record.workspaceJid!==result.workspaceJid||record.profileId!==result.profileId)throw Error('conversation_conflict');return record;
   }
   if(this.currentConversationEvent(key)?.eventId!==eventId)return record;
   const ready:BotConversationRecord={...record,state:'ready',workspaceJid:result.workspaceJid,profileId:result.profileId};
   this.db.prepare('UPDATE bot_conversation_events SET body=? WHERE id=?').run(JSON.stringify(ready),eventId);return ready;
  },guard);
 }
 currentConversation(actor:BotConversationActor):BotConversationRecord|undefined{
  const trusted=conversationActor(actor),key=conversationKey([trusted.corpId,trusted.botId,trusted.memberId]);
  const record=this.currentConversationEvent(key);
  if(!record)return undefined;
  return isDeepStrictEqual(record.actor,trusted)?record:{...record,state:'stale'};
 }
 exitConversation(actor:BotConversationActor,messageId:string,fingerprint:string,guard?:()=>void):{state:'exited'}{
  const trusted=conversationActor(actor);check(identifier(messageId,200)&&digest(fingerprint));
  const eventId=conversationKey([trusted.corpId,trusted.botId,trusted.memberId,messageId]);
  const key=conversationKey([trusted.corpId,trusted.botId,trusted.memberId]);
  return this.transaction(()=>{
   const row=this.db.prepare('SELECT body FROM bot_conversation_events WHERE id=?').get(eventId) as {body:string}|undefined;
   if(row){const previous=JSON.parse(row.body) as {kind?:string;fingerprint:string;actor:BotConversationActor};if(previous.kind!=='exit'||previous.fingerprint!==fingerprint||!isDeepStrictEqual(previous.actor,trusted))throw Error('conversation_conflict');return {state:'exited'};}
   // Exiting only clears this channel's pointer; a changed grant must not trap the member in an old mode.
   this.db.prepare('INSERT INTO bot_conversation_events(id,body) VALUES (?,?)').run(eventId,JSON.stringify({kind:'exit',fingerprint,actor:trusted}));
   this.db.prepare('DELETE FROM bot_conversation_current WHERE id=?').run(key);return {state:'exited'};
  },guard);
 }
 close():void{this.db.close();}
}
