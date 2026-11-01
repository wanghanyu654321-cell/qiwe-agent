import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {createFullHostCandidate} from './full-host-candidate.mjs';

const source=process.env.QIWE_NATIVE_SOURCE,overlay=process.env.QIWE_NATIVE_OVERLAY;
if(!source||!overlay||!path.isAbsolute(source)||!path.isAbsolute(overlay))throw Error('EXPLICIT_NATIVE_SOURCE_AND_OVERLAY_REQUIRED');
const candidate=await createFullHostCandidate(source,overlay,{conversationIntake:true,fullHostConversationExecution:true});
const code=candidate.files.get('index.ts'),tree=ts.createSourceFile('index.ts',code,ts.ScriptTarget.Latest,true);
const runner=tree.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(tree)==='d3Runner'));
assert.equal(runner.length,1);
// Execute the actual generated full-host D3 runner with fake ports only.
const body=ts.transpileModule(`async function exercise(ports:any){
 const {runContainerAgent,finishConversationBatch,assertConversationBatchCurrent,conversationBatchActive,noteConversationSession,invalidateConversationProjection,logger}=ports;
 let d3TerminalRunner:any=undefined;let d5OnCompleted:any=ports.onCompleted;
 ${runner[0].getText(tree)}
 return d3Runner;
}
return exercise;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const exercise=new Function(body)();
const ports=()=>{const s={finished:[],notified:[],outputs:[],release:undefined};
 s.ports={finishConversationBatch:(...a)=>{s.finished.push(a);return a[2]==='completed'?['receipt-1']:[];},assertConversationBatchCurrent:()=>{},conversationBatchActive:()=>true,
  noteConversationSession:()=>{},invalidateConversationProjection:()=>{},logger:{warn:()=>{}},onCompleted:ids=>{s.notified.push(ids);},
  runContainerAgent:async(_g,_i,_p,onOutput)=>{await onOutput({status:'success',result:'synthetic',inputTurnCompleted:true,inputTurnId:'turn-1',turnId:'turn-1',newSessionId:'session-1'});return new Promise(r=>{s.release=r;});}};
 return s;};
const input={chatJid:'web:owned',queryRunId:'query-1',turnId:'turn-1'};
test('warm runner that never resolves still records the first turn and notifies',async()=>{
 const s=ports();const run=await exercise(s.ports);
 const pending=run({},input,()=>{},async e=>{s.outputs.push(e);},undefined);
 for(let i=0;i<20&&!s.notified.length;i++)await new Promise(r=>setTimeout(r,5));
 assert.deepEqual(s.finished,[['web:owned','query-1','completed','session-1']]);
 assert.deepEqual(s.notified,[['receipt-1']]);
 assert.equal(s.outputs.length,1);
 s.release({status:'success',turnId:'turn-1'});await pending;
 assert.equal(s.finished.length,1,'runner exit must not finish twice');
 assert.equal(s.notified.length,1);
});
test('unhealthy first turn is not finished early',async()=>{
 const s=ports();s.ports.runContainerAgent=async(_g,_i,_p,onOutput)=>{await onOutput({status:'error',inputTurnCompleted:true,inputTurnId:'turn-1',turnId:'turn-1'});return {status:'error',turnId:'turn-1'};};
 const run=await exercise(s.ports);await run({},input,()=>{},async()=>{},undefined);
 assert.equal(s.notified.length,0);assert.equal(s.finished[0][2],'failed');
});
