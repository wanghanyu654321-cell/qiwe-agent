import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {applyFullHostPiAbort,applyFullHostPiInputQueue} from './full-host-restoration-pi-overlay.mjs';
const source=process.env.QIWE_NATIVE_SOURCE;
if(!source||!path.isAbsolute(source))throw Error('EXPLICIT_NATIVE_SOURCE_REQUIRED');
const runnerSrc=path.join(source,'../container/agent-runner/src');
const original=fs.readFileSync(path.join(runnerSrc,'runtime/pi/pi-runner.ts'),'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'27f0e10092b9c37d49cf7aa27eb0eea659aa0f5441984625d5be7cc59992d248');
const transpile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const ipc=ts.createSourceFile('ipc.ts',fs.readFileSync(path.join(runnerSrc,'ipc-delivery.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const trackerClass=ipc.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='IpcTurnDeliveryTracker');assert.ok(trackerClass);
const Tracker=new Function(transpile(trackerClass.getText(ipc).replace('export class','class'))+'\nreturn IpcTurnDeliveryTracker;')();
function load(code){
 const tree=ts.createSourceFile('pi-runner.ts',code,ts.ScriptTarget.Latest,true);
 const picked=tree.statements.filter(n=>(ts.isFunctionDeclaration(n)&&['toRuntimeInput','runPiQueryAttempt'].includes(n.name?.text))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>/^piAnsweredInputKeys$|^piInputKey$/.test(d.name.getText(tree)))));
 const text=picked.map(n=>n.getText(tree).replace('export async','async')).join('\n');
 return new Function('emitRuntimeEvent',transpile(text)+'\nreturn runPiQueryAttempt;')((event,_o,state)=>{if(event.type==='result')state.result=event.result;});
}
const fixed=()=>load(applyFullHostPiInputQueue(applyFullHostPiAbort(original)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/** Mirrors Pi semantics: prompt() runs one agent loop and ends with one agent_end;
 * followUp() only queues, so input queued after agent_end is never run. */
function fakePi(){
 const state={prompts:[],followUps:0,isStreaming:false,listeners:new Set()};
 const session={sessionId:'s1',get isStreaming(){return state.isStreaming;},subscribe(fn){state.listeners.add(fn);return()=>state.listeners.delete(fn);},
  async prompt(input){if(state.isStreaming)throw Error('ALREADY_STREAMING');state.prompts.push(input.text);state.isStreaming=true;await sleep(30);
   for(const l of state.listeners)l({type:'result',result:{text:'answer:'+input.text,sessionId:'s1',finalizationReason:'completed'}});state.isStreaming=false;},
  async followUp(){state.followUps++;},async abort(){},dispose(){}};
 return {state,runtime:{async createSession(){return session;}}};
}
const msg=(text)=>({text,receipt:{deliveryId:'r-'+text}});
function options(pi,tracker,prompt,drain){const emitted=[];return {emitted,o:{runtime:pi.runtime,sessionOptions:{},onSessionId(){},prompt,images:undefined,containerInput:{},tracker,emit:x=>emitted.push(x),log(){},drainInput:drain,shouldClose:()=>false,shouldInterrupt:()=>false,acceptIpcMessagesDuringQuery:true,onTurnCompleted(){},onTurnActivated(){}}};}
const answers=emitted=>emitted.filter(x=>x.status==='success').map(x=>x.result);

test('two quick consecutive messages are each answered exactly once, in order',async()=>{
 const run=fixed(),pi=fakePi(),tracker=new Tracker([msg('A')]);let sent=false;
 const {o,emitted}=options(pi,tracker,'A',()=>sent?[]:(sent=true,[msg('B')]));
 const out=await run(o);
 assert.deepEqual(pi.state.prompts,['A','B']);assert.equal(pi.state.followUps,0);
 assert.deepEqual(answers(emitted),['answer:A','answer:B']);assert.equal(tracker.hasPendingTurns,false);assert.equal(out.durableInputTurnCompleted,true);
});
test('a message arriving after agent_end gets its own turn and answer',async()=>{
 const run=fixed(),pi=fakePi(),tracker=new Tracker([msg('A')]);let sent=false;
 const {o,emitted}=options(pi,tracker,'A',()=>(!sent&&pi.state.prompts.length===1&&!pi.state.isStreaming)?(sent=true,[msg('C')]):[]);
 await run(o);
 assert.equal(sent,true);assert.deepEqual(pi.state.prompts,['A','C']);assert.deepEqual(answers(emitted),['answer:A','answer:C']);
});
test('original wrapper reproduces the bug for input after agent_end',async()=>{
 const run=load(applyFullHostPiAbort(original)),pi=fakePi(),tracker=new Tracker([msg('A')]);let sent=false;
 const {o}=options(pi,tracker,'A',()=>(!sent&&pi.state.prompts.length===1&&!pi.state.isStreaming)?(sent=true,[msg('C')]):[]);
 await assert.rejects(run(o),/uncompleted input turns/);assert.equal(pi.state.followUps,1);
});
test('recovery skips already-answered redelivered input, so nothing is pushed twice',async()=>{
 const run=fixed(),all=[];
 {const pi=fakePi(),tracker=new Tracker([msg('A')]);let sent=false;const {o,emitted}=options(pi,tracker,'A',()=>sent?[]:(sent=true,[msg('B')]));await run(o);all.push(...answers(emitted));}
 {const pi=fakePi(),tracker=new Tracker([msg('D')]);let sent=false;const {o,emitted}=options(pi,tracker,'D',()=>sent?[]:(sent=true,[msg('B'),msg('A'),msg('E'),msg('E')]));await run(o);
  assert.deepEqual(pi.state.prompts,['D','E']);all.push(...answers(emitted));assert.equal(tracker.hasPendingTurns,false);}
 assert.deepEqual(all,['answer:A','answer:B','answer:D','answer:E']);
});
