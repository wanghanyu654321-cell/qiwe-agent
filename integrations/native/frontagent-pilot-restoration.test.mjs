import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreExistingFrontagentHost} from './frontagent-pilot-restoration.mjs';

function fixture(){
 const rows={scheduled_tasks:[{id:'task-old'}],task_runs:[],task_run_logs:[],messages:[{id:'message-old',chat_jid:'web:role',is_from_me:0}],wecom_conversation_receipts:[],wecom_conversation_execution:[],wecom_conversation_results:[]};
 const state={phase:'paused',admin:true,reviewable:true,reviewStatus:200,sessionValid:true,preserve:true,mutate:false};
 const calls=[],saved=new Set();
 const sql={prepare:query=>({all:()=>{
  if(query==='SELECT id FROM scheduled_tasks ORDER BY id')return rows.scheduled_tasks.map(({id})=>({id}));
  if(query.startsWith('SELECT m.chat_jid,m.id FROM messages m LEFT JOIN'))return rows.messages.filter(m=>!m.is_from_me).map(({id,chat_jid})=>({id,chat_jid}));
  const match=/^SELECT \* FROM (\w+) ORDER BY rowid$/.exec(query);
  if(!match||!(match[1] in rows))throw Error('unexpected query');return structuredClone(rows[match[1]]);
 }})};
 const host={fullHostBootGate:{phase:()=>state.phase},
  inspectFullHostLegacyWork:(who,selection)=>{assert.deepEqual(who,{sessionId:'session',userId:'administrator'});calls.push(['inspect',selection.kind]);return {version:'current',records:[{}]};},
  preserveFullHostLegacyWork:(_who,selection,version)=>{assert.equal(version,'current');calls.push(['preserve',selection.kind]);if(state.mutate)rows.messages[0].content='tampered';saved.add(selection.kind);return {state:state.preserve?'manual_review_required':'unknown'};}};
 const db={isLegacyTaskPreserved:()=>saved.has('task'),isLegacyMessagePreserved:()=>saved.has('message'),scanAppointmentBootInventory:()=>({blockers:['pending_evidence'],records:[]})};
 const auth={verifySessionToken:value=>state.sessionValid&&value==='cookie'?{token:'session',legacy:false}:undefined};
 const fetch=async(url,options)=>{const endpoint=new URL(url).pathname;calls.push([endpoint,options.method??'GET']);
  if(endpoint==='/api/auth/me')return {status:state.admin?200:403,json:async()=>({user:{id:'administrator',role:state.admin?'admin':'member'}})};
  if(endpoint==='/api/appointment/maintenance')return {status:200,json:async()=>({maintenance:true,phase:'paused'})};
  if(endpoint==='/api/appointment/maintenance/review')return {status:state.reviewStatus,json:async()=>({recoverable:state.reviewable,ticket:{proof:'original-ticket'}})};
  if(endpoint==='/api/appointment/maintenance/restore'){assert.deepEqual(JSON.parse(options.body),{proof:'original-ticket',confirmed:true});state.phase='ready';return {status:200,json:async()=>({restored:true,maintenance:false})};}
  throw Error('unexpected endpoint');
 };
 const classifyRestorationRow=()=>({disposition:'blocked'});
 return {state,calls,rows,options:{sql,host,db,auth,base:'http://127.0.0.1:1234',adminCookie:'miniclaw_session=cookie',classifyRestorationRow,fetch}};
}
test('uses original administrator review, preserves unknown legacy records, and restores using issued ticket',async()=>{
 const f=fixture(),result=await restoreExistingFrontagentHost(f.options);
 assert.equal(result.restored,true);assert.equal(f.state.phase,'ready');assert.deepEqual(result.preserved,{tasks:1,messages:1});
 assert.deepEqual(f.calls.map(c=>c[0]),['/api/auth/me','/api/appointment/maintenance','/api/appointment/maintenance/review','inspect','preserve','inspect','preserve','/api/appointment/maintenance/review','/api/appointment/maintenance/restore']);
});
test('fails closed for non-local target, invalid administrator, legacy session, or paused-state mismatch',async()=>{
 for(const change of [f=>f.options.base='https://example.com',f=>f.state.admin=false,f=>f.state.sessionValid=false,f=>f.state.phase='ready']){
  const f=fixture();change(f);await assert.rejects(()=>restoreExistingFrontagentHost(f.options));assert.equal(f.calls.some(c=>c[0]==='/api/appointment/maintenance/restore'),false);
 }
});
test('does not restore when review reports blockers or preservation is unconfirmed',async()=>{
 for(const change of [f=>f.state.reviewable=false,f=>f.state.reviewStatus=409,f=>f.state.preserve=false]){
  const f=fixture();change(f);await assert.rejects(()=>restoreExistingFrontagentHost(f.options),error=>{if(!f.state.reviewable||f.state.reviewStatus!==200)assert.ok(error.inventory);return true;});
  assert.equal(f.calls.some(c=>c[0]==='/api/appointment/maintenance/restore'),false);
 }
});
test('detects changes to existing records before sending restore request',async()=>{
 const f=fixture();f.state.mutate=true;await assert.rejects(()=>restoreExistingFrontagentHost(f.options),/RETAINED_RECORDS_CHANGED/);
 assert.equal(f.calls.some(c=>c[0]==='/api/appointment/maintenance/restore'),false);
});
test('does not re-preserve known records and does not invent decisions for other classifier dispositions',async()=>{
 const f=fixture();f.options.db.isLegacyTaskPreserved=()=>true;f.options.classifyRestorationRow=()=>({disposition:'eligible'});
 const result=await restoreExistingFrontagentHost(f.options);assert.deepEqual(result.preserved,{tasks:0,messages:0});assert.equal(f.calls.some(c=>c[0]==='preserve'),false);
});
test('does not preserve or restore when initial review fails server-side',async()=>{
 const f=fixture();f.state.reviewStatus=500;await assert.rejects(()=>restoreExistingFrontagentHost(f.options),/REVIEW_FAILED/);
 assert.equal(f.calls.some(c=>c[0]==='preserve'||c[0]==='/api/appointment/maintenance/restore'),false);
});
