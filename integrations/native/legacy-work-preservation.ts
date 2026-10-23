import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';

export const legacyWorkPreservationPrefix='qiwe_legacy_work_preservation:v1:';
const keyColumns={scheduled_tasks:['id'],task_runs:['id'],task_run_logs:['id'],messages:['chat_jid','id'],wecom_conversation_receipts:['receipt_id'],wecom_conversation_execution:['receipt_id']} as const;
type Table=keyof typeof keyColumns;
type Row=Record<string,unknown>;
type RecordIdentity={table:Table;keys:(string|number)[];rowVersion:string;taskId:string|null};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
function validTable(table:string):table is Table{return Object.hasOwn(keyColumns,table);}
function recordKey(table:Table,keys:readonly unknown[]):string{return legacyWorkPreservationPrefix+table+':'+JSON.stringify(keys);}
function keysFor(table:Table,row:Row):(string|number)[]{
 const keys=keyColumns[table].map(key=>row[key]);
 if(keys.some(key=>typeof key!=='string'&&!(typeof key==='number'&&Number.isSafeInteger(key))))throw Error('LEGACY_PRESERVATION_INVALID_KEY');
 return keys as (string|number)[];
}
function readRow(connection:Database.Database,table:Table,keys:readonly (string|number)[]):Row|undefined{
 const columns=connection.prepare('PRAGMA table_info('+quote(table)+')').all() as {name:string}[];
 if(!columns.length)throw Error('LEGACY_PRESERVATION_TABLE_MISSING');
 const where=keyColumns[table].map(key=>quote(key)+'=?').join(' AND ');
 const bytes=connection.prepare('SELECT '+columns.map(column=>'coalesce(length(CAST('+quote(column.name)+' AS BLOB)),0)').join('+')+' AS bytes FROM '+quote(table)+' WHERE '+where).get(...keys) as {bytes:number}|undefined;
 if(!bytes)return undefined;
 if(!Number.isSafeInteger(bytes.bytes)||bytes.bytes>1024*1024)throw Error('LEGACY_PRESERVATION_ROW_BUDGET');
 return connection.prepare('SELECT * FROM '+quote(table)+' WHERE '+where).get(...keys) as Row|undefined;
}
export function legacyWorkRecordPreserved(connection:Database.Database,table:string,row:Row):boolean{
 if(!validTable(table))return false;
 const key=recordKey(table,keysFor(table,row));
 if(connection.prepare('SELECT 1 FROM router_state WHERE key=?').get(key))return true;
 if((table==='task_runs'||table==='task_run_logs')&&typeof row.task_id==='string')return !!connection.prepare('SELECT 1 FROM router_state WHERE key=?').get(recordKey('scheduled_tasks',[row.task_id]));
 return false;
}
export type LegacyWorkPreservationEvidence=Readonly<{state:'manual_review_required';rowVersion:string;markerVersion:string}|{state:'unverified';reason:string}>;
/** Exact row consistency and retention only. This does not certify stopped OS
 * writers, external effects, whole-inventory completeness, or permission to restore. */
export function readLegacyWorkPreservationEvidence(connection:Database.Database,table:string,row:Row,observedRows?:ReadonlyMap<string,readonly Row[]>):LegacyWorkPreservationEvidence|undefined{
 const markerAt=(key:string):Row|undefined=>observedRows
  ? observedRows.get('router_state')?.find(item=>item.key===key)
  : connection.prepare('SELECT value FROM router_state WHERE key=?').get(key) as Row|undefined;
 if(table==='router_state'&&typeof row.key==='string'&&row.key.startsWith(legacyWorkPreservationPrefix)){
  try{
   if(typeof row.value!=='string'||row.value.length>4096)throw Error('invalid_marker');
   const marker=JSON.parse(row.value);
   if(!marker||!validTable(marker.table)||!Array.isArray(marker.keys)||row.key!==recordKey(marker.table,marker.keys))throw Error('invalid_marker');
   const target:Table=marker.table;
   return readLegacyWorkPreservationEvidence(connection,target,Object.fromEntries(keyColumns[target].map((key,index)=>[key,marker.keys[index]])),observedRows)??{state:'unverified',reason:'missing_target_marker'};
  }catch{return {state:'unverified',reason:'invalid_marker'};}
 }
 if(!validTable(table))return undefined;
 try{
  const keys=keysFor(table,row);
  const stored=markerAt(recordKey(table,keys));
  if(!stored){
   if((table==='task_runs'||table==='task_run_logs')&&typeof row.task_id==='string'&&markerAt(recordKey('scheduled_tasks',[row.task_id])))return {state:'unverified',reason:'unregistered_descendant'};
   return undefined;
  }
  if(typeof stored.value!=='string'||stored.value.length>4096)return {state:'unverified',reason:'invalid_marker'};
  const value=JSON.parse(stored.value);
  if(!value||Object.keys(value).sort().join(',')!=='keys,recordedAt,rowVersion,state,table,taskId,version'||value.version!==1||value.state!=='manual_review_required'||value.table!==table||JSON.stringify(value.keys)!==JSON.stringify(keys)||!/^\d{4}-\d\d-\d\dT/.test(value.recordedAt)||!Number.isFinite(Date.parse(value.recordedAt))||!/^[a-f0-9]{64}$/.test(value.rowVersion)||(value.taskId!==null&&typeof value.taskId!=='string'))return {state:'unverified',reason:'invalid_marker'};
  const current=observedRows?observedRows.get(table)?.find(item=>JSON.stringify(keysFor(table,item))===JSON.stringify(keys)):readRow(connection,table,keys);
  if(!current||digest(current)!==value.rowVersion)return {state:'unverified',reason:'record_changed'};
  if(table==='scheduled_tasks'&&value.taskId!==current.id||(table==='task_runs'||table==='task_run_logs')&&value.taskId!==current.task_id)return {state:'unverified',reason:'relationship_changed'};
  return {state:'manual_review_required',rowVersion:value.rowVersion,markerVersion:digest(stored.value)};
 }catch{return {state:'unverified',reason:'read_or_marker_error'};}
}
type Selection={kind:'task';taskId:string}|{kind:'message';chatJid:string;messageId:string};
function collect(connection:Database.Database,selection:Selection):RecordIdentity[]{
 const valid=(value:unknown,maximum:number)=>typeof value==='string'&&value.length>0&&value.length<=maximum;
 if(!selection||(selection.kind==='task'?!valid(selection.taskId,512):selection.kind==='message'?(!valid(selection.chatJid,512)||!valid(selection.messageId,256)):true))throw Error('LEGACY_PRESERVATION_INVALID_SELECTION');
 const records:RecordIdentity[]=[];let bytes=0;
 const add=(table:Table,keys:(string|number)[],taskId:string|null)=>{
  if(records.length>=10000)throw Error('LEGACY_PRESERVATION_ROW_COUNT');
  const row=readRow(connection,table,keys);if(!row)throw Error('LEGACY_PRESERVATION_ROW_MISSING');
  bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>16*1024*1024)throw Error('LEGACY_PRESERVATION_TOTAL_BUDGET');
  records.push({table,keys,rowVersion:digest(row),taskId});
 };
 const addMessage=(chatJid:string,messageId:string)=>{
  add('messages',[chatJid,messageId],null);
  const receipts=connection.prepare('SELECT receipt_id FROM wecom_conversation_receipts WHERE workspace_jid=? AND message_id=? ORDER BY receipt_id LIMIT 10001').all(chatJid,messageId) as {receipt_id:string}[];
  for(const receipt of receipts){
   add('wecom_conversation_receipts',[receipt.receipt_id],null);
   if(connection.prepare('SELECT 1 FROM wecom_conversation_execution WHERE receipt_id=?').get(receipt.receipt_id))add('wecom_conversation_execution',[receipt.receipt_id],null);
  }
 };
 if(selection.kind==='task'){
  add('scheduled_tasks',[selection.taskId],selection.taskId);
  for(const table of ['task_runs','task_run_logs'] as const){
   const rows=connection.prepare('SELECT id FROM '+table+' WHERE task_id=? ORDER BY id LIMIT 10001').all(selection.taskId) as {id:string|number}[];
   for(const row of rows)add(table,[row.id],selection.taskId);
  }
  const inputs=connection.prepare('SELECT chat_jid,id FROM messages WHERE task_id=? ORDER BY chat_jid,id LIMIT 10001').all(selection.taskId) as {chat_jid:string;id:string}[];
  for(const input of inputs)addMessage(input.chat_jid,input.id);
 }else{
  addMessage(selection.chatJid,selection.messageId);
 }
 return records;
}
export function inspectLegacyWorkSelection(connection:Database.Database,selection:Selection):Readonly<{version:string;records:readonly RecordIdentity[]}>{
 const records=collect(connection,selection);return {version:digest(records),records};
}
/** Internal maintenance write. Caller owns current ACL, gate registration and
 * actual old-writer termination. Markers never claim execution or delivery ended. */
export function preserveLegacyWorkSelection(connection:Database.Database,selection:Selection,expectedVersion:string):Readonly<{version:string;records:number;state:'manual_review_required'}>{
 if(!/^[a-f0-9]{64}$/.test(expectedVersion))throw Error('LEGACY_PRESERVATION_VERSION_REQUIRED');
 return connection.transaction(()=>{
  const snapshot=inspectLegacyWorkSelection(connection,selection);
  if(snapshot.version!==expectedVersion)throw Error('LEGACY_PRESERVATION_STALE_SELECTION');
  const recordedAt=new Date().toISOString();
  for(const record of snapshot.records){
   const key=recordKey(record.table,record.keys);
   const old=connection.prepare('SELECT value FROM router_state WHERE key=?').get(key);
   if(old){
    const row=Object.fromEntries(keyColumns[record.table].map((column,index)=>[column,record.keys[index]]));
    if(readLegacyWorkPreservationEvidence(connection,record.table,row)?.state!=='manual_review_required')throw Error('LEGACY_PRESERVATION_EXISTING_CONFLICT');
   }else connection.prepare('INSERT INTO router_state(key,value) VALUES (?,?)').run(key,JSON.stringify({version:1,state:'manual_review_required',...record,recordedAt}));
  }
  return {version:snapshot.version,records:snapshot.records.length,state:'manual_review_required' as const};
 }).immediate();
}
