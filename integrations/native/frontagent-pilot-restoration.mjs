import {createHash} from 'node:crypto';

const tables=['scheduled_tasks','task_runs','task_run_logs','messages','wecom_conversation_receipts','wecom_conversation_execution','wecom_conversation_results'];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};

/** Use the existing local administrator and original recovery gate. */
export async function restoreExistingFrontagentHost({sql,host,db,auth,base,adminCookie,classifyRestorationRow,fetch:request=globalThis.fetch}){
 if(typeof base!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(base)||new URL(base).port>65535||
    typeof adminCookie!=='string'||/[\r\n]/.test(adminCookie)||host?.fullHostBootGate?.phase()!=='paused'||
    typeof request!=='function'||typeof classifyRestorationRow!=='function')fail('EXISTING_RESTORE_INPUT_INVALID');
 const headers={cookie:adminCookie,Origin:'http://127.0.0.1:39130','content-type':'application/json',Connection:'close'};
 const get=route=>request(base+route,{headers,redirect:'error'});
 const post=(route,body)=>request(base+route,{method:'POST',headers,body:JSON.stringify(body),redirect:'error'});
 const authResponse=await get('/api/auth/me');
 if(authResponse.status!==200)fail('EXISTING_ADMIN_AUTH_FAILED');
 const authBody=await authResponse.json(),admin=authBody.user??authBody;
 if(admin?.role!=='admin'||typeof admin.id!=='string'||!admin.id)fail('EXISTING_ADMIN_AUTH_FAILED');
 const token=adminCookie.match(/(?:^|;\s*)miniclaw_session=([^;]+)/)?.[1];
 if(!token)fail('EXISTING_ADMIN_COOKIE_REQUIRED');
 const verified=auth.verifySessionToken(decodeURIComponent(token));
 if(!verified||verified.legacy||typeof verified.token!=='string'||!verified.token)fail('EXISTING_ADMIN_SESSION_INVALID');
 const who={sessionId:verified.token,userId:admin.id};
 const status=await get('/api/appointment/maintenance'),maintenance=await status.json();
 if(status.status!==200||maintenance.maintenance!==true||maintenance.phase!=='paused'||host.fullHostBootGate.phase()!=='paused')fail('EXISTING_RESTORE_NOT_PAUSED');
 const initial=await post('/api/appointment/maintenance/review',{});
 if(initial.status===401||initial.status===403)fail('EXISTING_RESTORE_REVIEW_FORBIDDEN');
 if(initial.status>=500)fail('EXISTING_RESTORE_REVIEW_FAILED');
 await initial.json();
 const observedRows=new Map(tables.map(table=>[table,sql.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 const retained=()=>digest(tables.map(table=>[table,sql.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 const before=retained(),preserved={tasks:0,messages:0};
 const selections=[...sql.prepare('SELECT id FROM scheduled_tasks ORDER BY id').all().map(row=>({kind:'task',taskId:row.id})),
  ...sql.prepare("SELECT m.chat_jid,m.id FROM messages m LEFT JOIN wecom_conversation_execution e ON e.workspace_jid=m.chat_jid AND e.message_id=m.id WHERE m.is_from_me=0 AND (m.delivery_status IS NULL OR m.delivery_status NOT IN ('cancelled','rejected')) AND NOT (COALESCE(e.state,'')='completed' AND EXISTS (SELECT 1 FROM wecom_conversation_results r WHERE r.receipt_id=e.receipt_id)) ORDER BY m.chat_jid,m.id").all().map(row=>({kind:'message',chatJid:row.chat_jid,messageId:row.id}))];
 for(const selection of selections){
  if(host.fullHostBootGate.phase()!=='paused')fail('EXISTING_RESTORE_NOT_PAUSED');
  if(selection.kind==='task'?db.isLegacyTaskPreserved(selection.taskId):db.isLegacyMessagePreserved(selection.chatJid,selection.messageId))continue;
  const table=selection.kind==='task'?'scheduled_tasks':'messages';
  const row=observedRows.get(table).find(item=>selection.kind==='task'?item.id===selection.taskId:item.id===selection.messageId&&item.chat_jid===selection.chatJid);
  if(!row)fail('EXISTING_RESTORE_RECORD_CHANGED');
  if(classifyRestorationRow(table,row,{rows:observedRows,evidence:[]}).disposition!=='blocked')continue;
  const selected=host.inspectFullHostLegacyWork(who,selection);
  if(!selected||typeof selected.version!=='string'||!selected.version||!Array.isArray(selected.records))fail('EXISTING_RESTORE_INSPECTION_FAILED');
  const result=host.preserveFullHostLegacyWork(who,selection,selected.version);
  if(result?.state!=='manual_review_required')fail('EXISTING_RESTORE_PRESERVATION_UNKNOWN');
  preserved[selection.kind==='task'?'tasks':'messages']++;
 }
 if(retained()!==before)fail('EXISTING_RESTORE_RETAINED_RECORDS_CHANGED');
 if(host.fullHostBootGate.phase()!=='paused')fail('EXISTING_RESTORE_NOT_PAUSED');
 const reviewed=await post('/api/appointment/maintenance/review',{}),review=await reviewed.json();
 if(reviewed.status!==200||review?.recoverable!==true||!review.ticket||typeof review.ticket!=='object'||Array.isArray(review.ticket)){
  const error=Error('EXISTING_ORIGINAL_RESTORE_REVIEW_BLOCKED');
  Object.defineProperty(error,'inventory',{value:db.scanAppointmentBootInventory(),enumerable:false});
  Object.defineProperty(error,'review',{value:review,enumerable:false});
  Object.defineProperty(error,'status',{value:reviewed.status,enumerable:false});
  throw error;
 }
 const restored=await post('/api/appointment/maintenance/restore',{...review.ticket,confirmed:true}),body=await restored.json();
 if(restored.status!==200||body?.restored!==true||body.maintenance!==false||host.fullHostBootGate.phase()!=='ready')fail('EXISTING_ORIGINAL_RESTORE_FAILED');
 if(retained()!==before)fail('EXISTING_RESTORE_RETAINED_RECORDS_CHANGED');
 return Object.freeze({restored:true,preserved:Object.freeze(preserved),retainedHash:before});
}
