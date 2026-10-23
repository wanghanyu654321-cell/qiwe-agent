import {expect} from 'vitest';
import {createHash} from 'node:crypto';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actor={tenantId:'result-tenant',accountId:'synthetic-full-admin',storeId:'result-store',corpId:'result-corp',botId:'result-bot',memberId:'result-member',bindingVersion:1,grantVersion:1};
const origin='synthetic-result-origin',receiptId=digest([actor.corpId,actor.botId,actor.memberId,origin]);
const content='synthetic canonical answer whose durable relationship is verified';
const queryId='synthetic-result-query',outputId='synthetic-result-output';
const resultKey=digest([receiptId,1]);
const resultRecord=(db:any)=>db.scanAppointmentBootInventory().records.find((r:any)=>r.kind==='outbox/wecom_conversation_results'&&r.key===resultKey);

export function seed(db:any,sql:any){
 sql.prepare("UPDATE users SET role='member' WHERE id=?").run(actor.accountId);
 const receipt=db.submitBotConversationMessage({receiptId,originMessageId:origin,fingerprint:digest('input'),text:'synthetic result input',actor,
  target:{workspaceJid:'web:full-role',profileId:'synthetic-result-profile',role:'marketing',selectionId:'synthetic-result-selection'}});
 sql.prepare("UPDATE wecom_conversation_execution SET state='running',query_id=?,turn_id=?,input_json=?,batch_size=? WHERE receipt_id=?")
  .run(queryId,receipt.messageId,JSON.stringify([receipt.messageId]),1,receiptId);
 db.storeMessageDirect(outputId,'web:full-role',actor.accountId,'Synthetic',content,new Date().toISOString(),true);
 sql.prepare('UPDATE messages SET turn_id=? WHERE id=? AND chat_jid=?').run(receipt.messageId,outputId,'web:full-role');
 // Real D5 producer and durable canonical witness; no fabricated result INSERT.
 db.noteConversationProjection('web:full-role',queryId,receipt.messageId,receipt.messageId,outputId,content);
 expect(db.finishConversationBatch('web:full-role',queryId,'completed','synthetic-result-session')).toEqual([receiptId]);
 expect(db.readConversationResults(receiptId)).toMatchObject([{revision:1,content}]);
 sql.prepare("UPDATE users SET role='admin' WHERE id=?").run(actor.accountId);
}

export function snapshot(sql:any){return {
 receipt:sql.prepare('SELECT * FROM wecom_conversation_receipts WHERE receipt_id=?').get(receiptId),
 execution:sql.prepare('SELECT * FROM wecom_conversation_execution WHERE receipt_id=?').get(receiptId),
 result:sql.prepare('SELECT * FROM wecom_conversation_results WHERE receipt_id=?').get(receiptId),
};}

export function exercise({db,sql,restarting,events}:any){
 const stored=snapshot(sql),record=resultRecord(db);
 expect(record?.evidence,'original canonical producer must reach the original recovery scanner').toContain('d5_frozen_result_verified');
 expect(record).toMatchObject({disposition:'blocked'});
 expect(record.evidence).toEqual(expect.arrayContaining(['result_delivery_unverified','old_writer_ownership_unverified','current_snapshot_only']));
 expect(db.readConversationResults(receiptId)).toMatchObject([{revision:1,content}]);
 if(!restarting){
  const mutate=(table:string,column:string,value:any,original:any,keyColumn:string,key:any)=>{
   sql.prepare('UPDATE '+table+' SET '+column+'=? WHERE '+keyColumn+'=?').run(value,key);
   try{
    const changed=resultRecord(db);
    expect(changed?.evidence,table+'.'+column).not.toContain('d5_frozen_result_verified');
    expect(changed?.evidence,table+'.'+column).toContain('d5_result_relation_unverified');
    expect(changed?.disposition).toBe('blocked');
    expect(changed?.version).not.toBe(record.version);
   }finally{sql.prepare('UPDATE '+table+' SET '+column+'=? WHERE '+keyColumn+'=?').run(original,key);}
  };
  for(const [column,value] of [['content','forged answer'],['digest',digest('forged')],['source_ids_json','["missing-output"]'],['source_ids_json','{"safe":true}'],['query_id','forged-query'],['turn_id','forged-turn']])
   mutate('wecom_conversation_results',column,value,stored.result[column],'receipt_id',receiptId);
  for(const [column,value] of [['content','changed canonical answer'],['turn_id','foreign-turn'],['is_from_me',0]]){
   const original=sql.prepare('SELECT '+column+' AS value FROM messages WHERE id=?').get(outputId).value;
   mutate('messages',column,value,original,'id',outputId);
  }
  for(const [column,value] of [['state','running'],['message_id','missing-input'],['query_id','wrong-query'],['turn_id','wrong-turn'],['input_json','["wrong-input"]']])
   mutate('wecom_conversation_execution',column,value,stored.execution[column],'receipt_id',receiptId);
  mutate('wecom_conversation_receipts','actor_json','{}',stored.receipt.actor_json,'receipt_id',receiptId);
  mutate('wecom_conversation_receipts','text_hash','forged',stored.receipt.text_hash,'receipt_id',receiptId);
  sql.prepare('DELETE FROM wecom_conversation_receipts WHERE receipt_id=?').run(receiptId);
  try{
   const missing=resultRecord(db);expect(missing.evidence).toContain('d5_result_relation_unverified');
   expect(missing.evidence).not.toContain('d5_frozen_result_verified');expect(missing.version).not.toBe(record.version);
  }finally{
   const columns=Object.keys(stored.receipt);
   sql.prepare('INSERT INTO wecom_conversation_receipts ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').run(...columns.map(column=>stored.receipt[column]));
  }
  const originalOutput=sql.prepare('SELECT content FROM messages WHERE id=?').get(outputId).content;
  sql.prepare('UPDATE messages SET content=? WHERE id=?').run('x'.repeat(12*1024*1024),outputId);
  try{
   const limited=db.scanAppointmentBootInventory();expect(limited.blockers).toContain('BUDGET:BYTES');
   const denied=limited.records.find((r:any)=>r.kind==='outbox/wecom_conversation_results'&&r.key===resultKey);
   expect(denied.evidence).toContain('d5_result_relation_unverified');expect(denied.evidence).not.toContain('d5_frozen_result_verified');
  }finally{sql.prepare('UPDATE messages SET content=? WHERE id=?').run(originalOutput,outputId);}
  // Opaque data is part of the relationship version, even where the original
  // producer allows a different session and it does not invalidate persistence.
  sql.prepare('UPDATE wecom_conversation_results SET session_id=? WHERE receipt_id=?').run('different-session',receiptId);
  try{const changed=resultRecord(db);expect(changed.evidence).toContain('d5_frozen_result_verified');expect(changed.version).not.toBe(record.version);}
  finally{sql.prepare('UPDATE wecom_conversation_results SET session_id=? WHERE receipt_id=?').run(stored.result.session_id,receiptId);}
  const serialized=JSON.stringify(db.scanAppointmentBootInventory());
  for(const secret of [content,origin,receiptId,actor.corpId,'synthetic-result-session'])expect(serialized).not.toContain(secret);
 }
 expect(snapshot(sql)).toEqual(stored);
 events.push(restarting?'D5-original-result-evidence-second-process-read-only':'D5-original-producer-scanner-relation-evidence-and-refusals');
}
