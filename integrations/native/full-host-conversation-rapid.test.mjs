import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
import {createFullHostCandidate} from './full-host-candidate.mjs';

// Two rapid WeCom messages: each receipt must be answered exactly once by its
// own batch, and nothing may be left queued. Uses the generated full-host code.
const source=process.env.QIWE_NATIVE_SOURCE,overlay=process.env.QIWE_NATIVE_OVERLAY;
if(!source||!overlay||!path.isAbsolute(source)||!path.isAbsolute(overlay))throw Error('EXPLICIT_NATIVE_SOURCE_AND_OVERLAY_REQUIRED');
const candidate=await createFullHostCandidate(source,overlay,{conversationIntake:true,fullHostConversationExecution:true});
const index=candidate.files.get('index.ts'),dbSource=candidate.files.get('db.ts');
const pick=(code,file,names)=>{const tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true);
 return names.map(name=>{const found=tree.statements.filter(n=>(ts.isFunctionDeclaration(n)&&n.name?.text===name)||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(tree)===name)));assert.equal(found.length,1,name);return found[0].getText(tree).replace(/^export /,'');}).join('\n');};
const compile=(params,body)=>new Function(ts.transpileModule(`async function exercise(ports:any){const {${params}}=ports;${body}}\nreturn exercise;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)();

test('message loop never pipes a receipt into another running batch',()=>{
 const gate=index.indexOf('if(conversationReceiptsInBatch(chatJid,messagesToSend.map(m=>m.id))){');
 const send=index.indexOf('const sendResult = queue.sendMessage(\n            chatJid,');
 assert.ok(gate>0&&send>gate&&send-gate<200,'gate must sit directly before IPC injection');
 assert.match(index.slice(gate,send),/queue\.enqueueMessageCheck\(chatJid\);\s*continue;/);
});

const openDb=()=>{const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE wecom_conversation_receipts(receipt_id TEXT PRIMARY KEY,workspace_jid TEXT,message_id TEXT);
 CREATE TABLE wecom_conversation_execution(receipt_id TEXT PRIMARY KEY,workspace_jid TEXT,message_id TEXT,state TEXT,query_id TEXT,turn_id TEXT,session_id TEXT,input_json TEXT,batch_size INTEGER);`);
 return db;};
const dbFns=async db=>(await compile('db',pick(dbSource,'db.ts',['conversationReceiptsInBatch','hasQueuedConversationReceipt'])+'\nreturn {conversationReceiptsInBatch,hasQueuedConversationReceipt};'))({db});

test('two rapid messages resolve to one answer each with no queued leftovers',async()=>{
 const db=openDb(),jid='web:owned';
 for(const n of [1,2]){db.prepare('INSERT INTO wecom_conversation_receipts VALUES (?,?,?)').run('r'+n,jid,'m'+n);db.prepare("INSERT INTO wecom_conversation_execution(receipt_id,workspace_jid,message_id,state) VALUES (?,?,?,'queued')").run('r'+n,jid,'m'+n);}
 const fns=await dbFns(db);
 const answers=[],notified=[],piped=[];let checks=0,active=false;
 const finishConversationBatch=(chat,query,state)=>{const rows=db.prepare("SELECT receipt_id FROM wecom_conversation_execution WHERE workspace_jid=? AND query_id=? AND state='running'").all(chat,query);
  db.prepare('UPDATE wecom_conversation_execution SET state=? WHERE workspace_jid=? AND query_id=? AND state=?').run(state,chat,query,'running');return state==='completed'?rows.map(r=>r.receipt_id):[];};
 const runner=await (compile('runContainerAgent,finishConversationBatch,hasQueuedConversationReceipt,queue,assertConversationBatchCurrent,conversationBatchActive,noteConversationSession,invalidateConversationProjection,logger',
  `let d3TerminalRunner:any=undefined;let d5OnCompleted:any=ports.onCompleted;\n${pick(index,'index.ts',['d3Runner'])}\nreturn d3Runner;`))({
  finishConversationBatch,hasQueuedConversationReceipt:fns.hasQueuedConversationReceipt,
  queue:{enqueueMessageCheck:()=>{checks++;}},assertConversationBatchCurrent:()=>{},conversationBatchActive:()=>true,noteConversationSession:()=>{},invalidateConversationProjection:()=>{},logger:{warn:()=>{}},
  onCompleted:ids=>{notified.push(...ids);},
  runContainerAgent:async(_g,input,_p,onOutput)=>{
   // While batch 1 is running, message 2 arrives: the generated loop gate must refuse IPC injection.
   if(input.turnId==='m1'){if(fns.conversationReceiptsInBatch(jid,['m2']))checks++;else piped.push('m2');}
   answers.push(input.turnId);
   const out={status:'success',result:'answer '+input.turnId,inputTurnCompleted:true,inputTurnId:input.turnId,turnId:input.turnId,newSessionId:'s'};
   await onOutput(out);return out;}});
 const startBatch=async(message,query)=>{active=true;db.prepare("UPDATE wecom_conversation_execution SET state='running',query_id=?,turn_id=? WHERE message_id=? AND state='queued'").run(query,message,message);
  await runner({},{chatJid:jid,queryRunId:query,turnId:message,prompt:'x'},()=>{},async()=>{},undefined);active=false;};
 await startBatch('m1','q1');
 assert.deepEqual(piped,[],'message 2 must not be injected into batch 1');
 assert.ok(checks>=1,'queued receipt must re-trigger the queue');
 assert.equal(fns.hasQueuedConversationReceipt(jid),true);
 await startBatch('m2','q2');
 assert.deepEqual(answers,['m1','m2']);
 assert.deepEqual(notified,['r1','r2'],'one answer per receipt, none twice');
 assert.equal(fns.hasQueuedConversationReceipt(jid),false);
 assert.deepEqual(db.prepare('SELECT state FROM wecom_conversation_execution ORDER BY receipt_id').all().map(r=>r.state),['completed','completed']);
 assert.equal(active,false);
});
