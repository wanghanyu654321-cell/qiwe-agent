import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
const column=(name,type='TEXT',notnull=1,pk=0)=>[name,type,notnull,null,pk,0];
// Fixed public producer compatibility contract. Opaque actor/input/session and
// answer bodies stay outside the metadata projection and remain unverified.
const tables={
 wecom_conversation_receipts:{family:'input',keys:'receipt_id',metadata:'message_id,accepted_at,fingerprint,text_hash,role,workspace_jid,profile_id,selection_id',columns:[
  column('receipt_id','TEXT',0,1),...['message_id','accepted_at','origin_message_id','fingerprint','text_hash','actor_json','role','workspace_jid','profile_id','selection_id'].map(name=>column(name)),
 ]},
 wecom_conversation_execution:{family:'execution',keys:'receipt_id',metadata:'workspace_jid,message_id,state,query_id,turn_id,batch_size',columns:[
  column('receipt_id','TEXT',0,1),...['workspace_jid','message_id','state'].map(name=>column(name)),
  ...['query_id','turn_id','session_id','input_json'].map(name=>column(name,'TEXT',0)),column('batch_size','INTEGER',0),
 ]},
 wecom_conversation_results:{family:'outbox',keys:'receipt_id,revision',metadata:'query_id,turn_id,digest',columns:[
  column('receipt_id','TEXT',1,1),column('revision','INTEGER',1,2),column('query_id'),column('turn_id'),column('session_id','TEXT',0),
  ...['source_ids_json','digest','content'].map(name=>column(name)),
 ]},
};
function once(source,before,after){
 if(typeof source!=='string'||source.split(before).length!==2)throw Error('CONVERSATION_INVENTORY_ANCHOR_CHANGED');
 return source.replace(before,after);
}

/** Only explicit D2/D3/D5 candidates. Registers known metadata; never classifies
 * records, changes budgets, suppresses blockers or issues a recovery permit. */
export function applyConversationRecoveryInventory(files,{conversationExecution=false}={}){
 if(typeof conversationExecution!=='boolean')throw Error('CONVERSATION_INVENTORY_SCOPE_INVALID');
 const db=files.get('db.ts');
 const names=Object.keys(tables).slice(0,conversationExecution?3:1);
 const schemas=names.map(name=>{
  // Reuse the actual composed public producer declaration. No second CREATE
  // statement or SQLite/config evaluation is introduced by the builder.
  const matches=[...db.matchAll(new RegExp('CREATE TABLE IF NOT EXISTS '+name+' \\([\\s\\S]*?\\n    \\);','g'))];
  if(matches.length!==1)throw Error('CONVERSATION_INVENTORY_PRODUCER_CHANGED:'+name);
  const sql=matches[0][0].replace(' IF NOT EXISTS','').slice(0,-1);
  return {name,sqlHash:digest(sql),columns:tables[name].columns};
 });
 const result=new Map(files);
 result.set('appointment-boot-inventory-schema.ts',once(files.get('appointment-boot-inventory-schema.ts').replaceAll('\r\n','\n'),
  'export const appointmentInventorySchemas = [\n','export const appointmentInventorySchemas = [\n'+schemas.map(row=>JSON.stringify(row)+',\n').join('')));
 let inventory=once(files.get('appointment-boot-inventory.ts').replaceAll('\r\n','\n'),
  "    chats: ['resource', 'jid', 'last_message_time'],",
  names.map(name=>`    ${name}: ${JSON.stringify([tables[name].family,tables[name].keys,tables[name].metadata])},\n`).join('')+"    chats: ['resource', 'jid', 'last_message_time'],");
 if(conversationExecution)inventory=once(inventory,"  messages: {\n",`  wecom_conversation_execution: { state: ['queued','running','cancelling','cancelled','completed','failed','unknown'] },\n  messages: {\n`);
 result.set('appointment-boot-inventory.ts',inventory);
 return result;
}
