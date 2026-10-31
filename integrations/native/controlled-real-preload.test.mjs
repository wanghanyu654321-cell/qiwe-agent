import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPilotRunLedger,openPilotRunLedger} from './controlled-real-run-budget.mjs';
import {installControlledRealModelFetch} from './controlled-real-preload.mjs';

const environment=()=>({QIWE_PILOT_RUN_ID:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',QIWE_PILOT_MODEL_EXPIRES_AT:String(Date.now()+60000),QIWE_PILOT_MODEL_REQUESTS:'2',QIWE_PILOT_MODEL_OUTPUT_TOKENS:'64'});
test('original runtime uses a bounded real transport without replacing its response',async()=>{
 const calls=[],response=new Response('ok'),target={fetch:async request=>{calls.push(request);return response;}};
 const admission=installControlledRealModelFetch(environment(),target);
 assert.throws(()=>installControlledRealModelFetch(environment(),target),/CONTROLLED_REAL_PRELOAD/);
 const request=()=>target.fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash',max_tokens:400})});
 assert.equal(await request(),response);assert.equal((await calls[0].json()).max_tokens,64);
 await request();await assert.rejects(request(),/CONTROLLED_MODEL/);assert.equal(admission.state.attempts,2);
});
test('rejects missing, expired and malformed trial scope without changing the original fetch',()=>{
 for(const change of [e=>delete e.QIWE_PILOT_RUN_ID,e=>e.QIWE_PILOT_MODEL_EXPIRES_AT='0',e=>e.QIWE_PILOT_MODEL_REQUESTS='2x',e=>e.QIWE_PILOT_MODEL_OUTPUT_TOKENS='1025']){
  const env=environment(),original=async()=>new Response(),target={fetch:original};change(env);
  assert.throws(()=>installControlledRealModelFetch(env,target),/CONTROLLED_REAL_PRELOAD/);assert.equal(target.fetch,original);
 }
});
test('a durable ledger survives a new runtime and restart lookup is not wired to spend it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-preload-')),file=path.join(dir,'ledger.json'),expiresAt=Date.now()+60000,runId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 try{createPilotRunLedger(file,{runId,maxRequests:2,expiresAt});
  const env={...environment(),QIWE_PILOT_MODEL_EXPIRES_AT:String(expiresAt),QIWE_PILOT_MODEL_LEDGER:file};
  const request=target=>target.fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',body:JSON.stringify({model:'deepseek-flash'})});
  const first={fetch:async()=>new Response('ok')};installControlledRealModelFetch(env,first);await request(first);await request(first);
  const second={fetch:async()=>{throw Error('must not spend');}};installControlledRealModelFetch(env,second);
  await assert.rejects(request(second),/PILOT_BUDGET_EXHAUSTED/);assert.equal(openPilotRunLedger(file,{runId,maxRequests:2,expiresAt}).reserved,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
