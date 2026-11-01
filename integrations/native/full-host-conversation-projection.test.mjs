import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {createFullHostCandidate} from './full-host-candidate.mjs';

const source=process.env.QIWE_NATIVE_SOURCE,overlay=process.env.QIWE_NATIVE_OVERLAY;
if(!source||!overlay||!path.isAbsolute(source)||!path.isAbsolute(overlay))throw Error('EXPLICIT_NATIVE_SOURCE_AND_OVERLAY_REQUIRED');
const candidate=await createFullHostCandidate(source,overlay,{conversationIntake:true,fullHostConversationExecution:true});
const code=candidate.files.get('index.ts'),tree=ts.createSourceFile('index.ts',code,ts.ScriptTarget.Latest,true);
const find=(root,predicate)=>{const found=[];function walk(node){if(predicate(node))found.push(node);ts.forEachChild(node,walk);}walk(root);assert.equal(found.length,1);return found[0];};
const processGroup=find(tree,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='processGroupMessages');
const runAgent=find(tree,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='runAgent');
const start=find(processGroup,node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(tree)==='startConversationBatch');
const projection=find(processGroup,node=>ts.isCallExpression(node)&&node.expression.getText(tree)==='noteConversationProjection');
const wrapped=find(runAgent,node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(tree)==='wrappedOnOutput'));
const statements=start.parent.statements,position=statements.indexOf(start),previous=statements[position-1];
const captured=ts.isVariableStatement(previous)&&previous.getText(tree).includes('conversationBatchQueryId')?previous.getText(tree):'';
// Execute the actual generated capture, original O output wrapper and actual
// D3 projection call in their original order. Only unrelated ports are fake;
// no original main, scheduler, DB or network is started by this source unit.
const body=ts.transpileModule(`async function exercise(ports:any,result:any){
 const {queue,startConversationBatch,noteConversationProjection}=ports;
 const chatJid='web:owned',missedMessages=[{id:'input-1'}],lastProcessed={id:'input-1'};
 const group={folder:'owned'},sessions:any={},resolvedAgentProfile:any=undefined;
 const setSession=()=>{},commitIpcDeliveryReceipts=()=>{};
 const outputChannelScope={inputId:'input-1'},turnIdForDb=result.inputTurnId,replySendOutcome={messageId:'output-1'},dbText=result.result;
 ${captured}
 ${start.getText(tree)}
 const onOutput=async()=>{${projection.getText(tree)};};
 ${wrapped.getText(tree)}
 await wrappedOnOutput!(result);
}
return exercise;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const exercise=new Function(body)();
for(const successor of [null,'successor-query'])test('Pi queryIdle keeps the original durable batch identity when queue becomes '+successor,async()=>{
 let active='original-query';const started=[],projected=[];
 const queue={getConversationQueryId:()=>active,markRunnerActivity:()=>{},markRunnerQueryIdle:()=>{active=successor;}};
 await exercise({queue,startConversationBatch:(...args)=>started.push(args),noteConversationProjection:(...args)=>projected.push(args)},
  {status:'success',result:'synthetic draft',queryIdle:true,inputTurnCompleted:true,inputTurnId:'input-1',sourceKind:'sdk_final',finalizationReason:'completed'});
 assert.equal(active,successor);assert.equal(started[0][2],'original-query');
 assert.deepEqual(projected,[['web:owned','original-query','input-1','input-1','output-1','synthetic draft']]);
});

const d3=find(tree,node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(tree)==='d3Runner'));
const bind=new Function('ports',ts.transpileModule(`const {runContainerAgent,conversationBatchActive,assertConversationBatchCurrent,noteConversationSession,finishConversationBatch,invalidateConversationProjection,logger}=ports;let d5OnCompleted=ports.onCompleted;${d3.getText(tree)};return d3Runner;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText);
for(const rejected of [false,true])test('settled runner cannot forward late output, while active warm output remains valid: '+rejected,async()=>{
 let callback;const forwarded=[];
 const warm={status:'success',result:'warm',inputTurnId:'warm',inputTurnCompleted:true};
 const run=bind({runContainerAgent:async(_group,_input,_process,onOutput)=>{callback=onOutput;await callback(warm);if(rejected)throw Error('synthetic runner failure');return {status:'success',result:null};},
  conversationBatchActive:()=>true,assertConversationBatchCurrent:()=>{},noteConversationSession:()=>{},finishConversationBatch:()=>[],invalidateConversationProjection:()=>{},logger:{warn:()=>{}}});
 const pending=run({}, {chatJid:'web:owned',queryRunId:'original-query',turnId:'original-turn'},()=>{},async event=>forwarded.push(event));
 if(rejected)await assert.rejects(pending,/synthetic runner failure/);else await pending;
 await callback({status:'success',result:'late cancelled output',inputTurnId:'original-turn',inputTurnCompleted:true});
 await callback({...warm,result:'late warm output'});
 assert.deepEqual(forwarded,[warm]);
});
test('runner settlement fences callbacks while completion delivery is still pending',async()=>{
 let callback,release,started;const forwarded=[],sessions=[];
 const delivery=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
 const initial={status:'success',result:'owned',inputTurnId:'original-turn',inputTurnCompleted:true,newSessionId:'original-session'};
 const run=bind({runContainerAgent:async(_group,_input,_process,onOutput)=>{callback=onOutput;await callback(initial);return initial;},
  conversationBatchActive:()=>true,assertConversationBatchCurrent:()=>{},noteConversationSession:(...args)=>sessions.push(args),finishConversationBatch:()=>['owned-receipt'],invalidateConversationProjection:()=>{},logger:{warn:()=>{}},onCompleted:()=>{started();return delivery;}});
 const pending=run({}, {chatJid:'web:owned',queryRunId:'original-query',turnId:'original-turn'},()=>{},async event=>forwarded.push(event));
 await entered;await callback({...initial,result:'late',newSessionId:'wrong-session'});release();await pending;
 assert.deepEqual(forwarded,[initial]);assert.deepEqual(sessions,[['web:owned','original-query','original-session']]);
});
