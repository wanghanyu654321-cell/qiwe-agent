import test from 'node:test';
import assert from 'node:assert/strict';
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
