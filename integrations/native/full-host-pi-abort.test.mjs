import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {applyFullHostPiAbort} from './full-host-restoration-pi-overlay.mjs';
const source=process.env.QIWE_NATIVE_SOURCE;
if(!source||!path.isAbsolute(source))throw Error('EXPLICIT_NATIVE_SOURCE_REQUIRED');
const original=fs.readFileSync(path.join(source,'../container/agent-runner/src/runtime/pi/pi-runner.ts'),'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'27f0e10092b9c37d49cf7aa27eb0eea659aa0f5441984625d5be7cc59992d248');
const code=process.env.QIWE_TEST_ORIGINAL_PI==='1'?original:applyFullHostPiAbort(original);
const tree=ts.createSourceFile('pi-runner.ts',code,ts.ScriptTarget.Latest,true);
const declarations=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&['toRuntimeInput','runPiQueryAttempt'].includes(node.name?.text));
assert.equal(declarations.length,2);
const compiled=ts.transpileModule(declarations.map(node=>node.getText(tree).replace('export async','async')).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const run=new Function('emitRuntimeEvent',compiled+'\nreturn runPiQueryAttempt;')(()=>{});
const entry=fs.readFileSync(path.join(source,'../container/agent-runner/src/pi-index.ts'),'utf8');
assert.equal(createHash('sha256').update(entry).digest('hex'),'94cebffd558f902d1ab881306d6ae3abb2d19c078c443d296632df8a7e201117');
const entryTree=ts.createSourceFile('pi-index.ts',entry,ts.ScriptTarget.Latest,true);
const writer=entryTree.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='writeOutput');assert.equal(writer.length,1);
const writerCode=ts.transpileModule(writer[0].getText(entryTree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const bindWriter=new Function('activeInputTurnId','console','OUTPUT_START','OUTPUT_END',writerCode+'\nreturn writeOutput;');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
for(const success of [true,false])test('exact interruption requires settled successful abort: '+success,async()=>{
 const abort=deferred(),entered=deferred(),events=[];let disposed=false;
 const emit=bindWriter('active-ipc-turn',{log(value){if(value.startsWith('{'))events.push(JSON.parse(value));}},'START','END');
 const session={sessionId:'original-session',subscribe:()=>()=>{},prompt:async()=>{},abort:()=>{entered.resolve();return abort.promise;},dispose:()=>{disposed=true;}};
 const pending=run({runtime:{createSession:async()=>session},sessionOptions:{},containerInput:{turnId:'original-turn'},prompt:'synthetic',
  tracker:{cancelCurrentTurn:()=>[],unacknowledgedMessages:[]},emit,onSessionId:()=>{},shouldClose:()=>false,shouldInterrupt:()=>true});
 await entered.promise;assert.equal(events.length,0);assert.equal(disposed,false);
 if(success){abort.resolve();const outcome=await pending;assert.equal(outcome.interruptedDuringQuery,true);
  assert.deepEqual(events,[{status:'stream',result:null,inputTurnId:'active-ipc-turn',streamEvent:{eventType:'status',statusText:'interrupted',agentScope:'main',displayLevel:'primary',sessionId:'original-session'}}]);
 }else{abort.reject(Error('synthetic abort failure'));await assert.rejects(pending,/synthetic abort failure/);assert.equal(events.length,0);}
 assert.equal(disposed,true);
});
