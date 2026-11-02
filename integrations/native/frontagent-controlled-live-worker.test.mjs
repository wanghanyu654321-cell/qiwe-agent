import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {startControlledLiveWorker,createControlledLiveShutdown,writeControlledLiveFailureMarker} from './frontagent-controlled-live-worker.mjs';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-live-worker-'));
 fs.mkdirSync(path.join(root,'data','config','container-env'),{recursive:true});
 const scope={mode:'controlled-real-pilot',environment:'local-test',runId:'12345678-1234-1234-1234-123456789abc',expiresAt:Date.now()+60000,networkName:'qiwe-pilot-12345678-1234-1234-1234-123456789abc'};
 const options={root,scope,base:'http://127.0.0.1:39131',descriptor:{accountId:'member',folder:'marketing',adminCookie:'miniclaw_session=private'},transportOptions:{root,folder:'marketing',accountId:'member',controlledRealPilot:scope},readCredentials:()=>({botId:'bot',corpId:'corp',secret:'private'}),readModelCredentials:()=>({apiKey:'model-private',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'})};
 return {root,options,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('stops before installing transport when original provider config exists, without exposing credentials',async()=>{
 const f=fixture();try{fs.writeFileSync(path.join(f.root,'data/config/claude-provider.json'),'{}');
  await assert.rejects(()=>startControlledLiveWorker(f.options),error=>/PROVIDER_CONFIG_PRESENT/.test(error.message)&&!error.message.includes('private'));
 }finally{f.cleanup();}
});
test('stops before installing transport when existing per-folder provider override exists',async()=>{
 const f=fixture();try{fs.writeFileSync(path.join(f.root,'data/config/container-env/marketing.json'),'{}');
  await assert.rejects(()=>startControlledLiveWorker(f.options),/PROVIDER_CONFIG_PRESENT/);
 }finally{f.cleanup();}
});
test('refuses nonlocal address, mismatched trial scope, invalid model or expired admission',async()=>{
 for(const change of [f=>f.options.base='http://example.com:39131',f=>f.options.scope.expiresAt=Date.now()-1,
  f=>f.options.transportOptions={...f.options.transportOptions,folder:'another'},
  f=>f.options.readModelCredentials=()=>({apiKey:'model-private',baseUrl:'https://example.com',model:'deepseek-flash'})]){
  const f=fixture();try{change(f);await assert.rejects(()=>startControlledLiveWorker(f.options));}finally{f.cleanup();}
 }
});
test('input preflight never mutates process model credentials on failure',async()=>{
 const f=fixture(),before=process.env.ANTHROPIC_API_KEY;
 try{f.options.readModelCredentials=()=>({apiKey:'model-private',baseUrl:'https://bad.invalid',model:'deepseek-flash'});
  await assert.rejects(()=>startControlledLiveWorker(f.options));assert.equal(process.env.ANTHROPIC_API_KEY,before);
 }finally{f.cleanup();}
});
test('cleanup attempts the original queue and exact owned transport even if earlier closures fail',async()=>{
 const events=[],broken=name=>async()=>{events.push(name);throw Error('private-secret');},good=name=>()=>events.push(name);
 const close=createControlledLiveShutdown({pilot:{close:broken('pilot')},host:{fullHostQueue:{shutdown:broken('queue')}},
  transport:{close:good('transport')},tasks:{close:good('tasks')},ledger:{close:good('ledger')},grants:{close:good('grants')},sql:{close:good('sql')},
  restoreEnvironment:good('environment'),reportUnknown:()=>events.push('report'),signalOriginal:good('signal')});
 await assert.rejects(close,error=>error instanceof AggregateError&&error.message==='FRONTAGENT_LIVE_CLEANUP_UNKNOWN'&&error.errors.length===2&&!String(error.errors).includes('private-secret'));
 assert.deepEqual(events,['pilot','queue','transport','tasks','ledger','grants','sql','environment','report','signal']);
 await assert.rejects(close,/CLEANUP_UNKNOWN/);assert.equal(events.length,10);
});
test('failed transport cleanup is surfaced as unknown and original shutdown is still signaled',async()=>{
 const events=[],close=createControlledLiveShutdown({host:{fullHostQueue:{shutdown:async()=>events.push('queue')}},transport:{close:async()=>{events.push('transport');throw Error('unknown');}},
  restoreEnvironment:()=>events.push('environment'),reportUnknown:()=>events.push('report'),signalOriginal:()=>events.push('signal')});
 await assert.rejects(close,error=>error instanceof AggregateError&&error.errors.some(e=>e.message==='FRONTAGENT_LIVE_CLEANUP_TRANSPORT_UNKNOWN'));
 assert.deepEqual(events,['queue','transport','environment','report','signal']);
});
test('a resolving pilot close with cleanup_unknown remains an unknown cleanup result',async()=>{
 const events=[],close=createControlledLiveShutdown({pilot:{close:async()=>events.push('pilot'),status:()=> 'cleanup_unknown'},transport:{close:async()=>events.push('transport')},restoreEnvironment:()=>{},reportUnknown:()=>{},signalOriginal:()=>{}});
 await assert.rejects(close,error=>error instanceof AggregateError&&error.errors.some(e=>e.message==='FRONTAGENT_LIVE_CLEANUP_PILOT_UNKNOWN'));
 assert.deepEqual(events,['pilot','transport']);
});
test('if unknown cannot be recorded, never invoke original successful-exit shutdown',async()=>{
 let signaled=false;const close=createControlledLiveShutdown({transport:{close:async()=>{throw Error('unknown');}},restoreEnvironment:()=>{},reportUnknown:()=>{throw Error('disk failed');},signalOriginal:()=>{signaled=true;}});
 await assert.rejects(close,error=>error instanceof AggregateError&&error.errors.some(e=>e.message==='FRONTAGENT_LIVE_CLEANUP_REPORT_UNKNOWN'));assert.equal(signaled,false);
});
test('preexisting cleanup-unknown marker stops a new run before credentials or transport',async()=>{
 const f=fixture();try{fs.writeFileSync(path.join(f.root,'frontagent-live-cleanup-unknown.json'),'{}');
  await assert.rejects(()=>startControlledLiveWorker(f.options),/CLEANUP_MARKER_PRESENT/);
 }finally{f.cleanup();}
});
test('failed startup is durably reported before original SIGTERM can exit zero',async()=>{
 const events=[],close=createControlledLiveShutdown({initialFailure:true,restoreEnvironment:()=>events.push('environment'),reportUnknown:codes=>{events.push(codes.join(','));},signalOriginal:()=>events.push('signal')});
 await assert.rejects(close,error=>error.errors.some(e=>e.message==='FRONTAGENT_LIVE_START_FAILED'));
 assert.deepEqual(events,['environment','FRONTAGENT_LIVE_START_FAILED','signal']);
});
test('failure marker contains only run identity and codes and is never overwritten',()=>{
 const f=fixture();try{const runId=f.options.scope.runId;writeControlledLiveFailureMarker(f.root,runId,['FRONTAGENT_LIVE_CLEANUP_TRANSPORT_UNKNOWN']);
  const value=JSON.parse(fs.readFileSync(path.join(f.root,'frontagent-live-cleanup-unknown.json'),'utf8'));
  assert.deepEqual(value,{runId,codes:['FRONTAGENT_LIVE_CLEANUP_TRANSPORT_UNKNOWN']});
  assert.throws(()=>writeControlledLiveFailureMarker(f.root,runId,['FRONTAGENT_LIVE_START_FAILED']));
 }finally{f.cleanup();}
});
test('original recovery Docker helper retains real execFileSync after controlled transport patches builtin exports',()=>{
 const f=fixture();try{
  fs.mkdirSync(path.join(f.root,'src'),{recursive:true});
  const source="import {execFileSync} from 'node:child_process'; export const captured=execFileSync;";
  fs.writeFileSync(path.join(f.root,'src/full-host-local-docker.mjs'),source);fs.writeFileSync(path.join(f.root,'src/late.mjs'),source);
  const worker=pathToFileURL(path.resolve('integrations/native/frontagent-controlled-live-worker.mjs')).href,fixture=pathToFileURL(path.join(f.root,'src/full-host-local-docker.mjs')).href,late=pathToFileURL(path.join(f.root,'src/late.mjs')).href;
  const script=`import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import assert from 'node:assert/strict'; const w=await import(${JSON.stringify(worker)}); const original=child.execFileSync; await w.preloadOriginalRestorationBoundary(${JSON.stringify(f.root)}); child.execFileSync=()=>{throw Error('routed')}; syncBuiltinESMExports(); const loaded=await import(${JSON.stringify(fixture)}); assert.equal(loaded.captured,original); const wrong=await import(${JSON.stringify(late)}); assert.notEqual(wrong.captured,original); assert.throws(()=>wrong.captured(),/routed/);`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 }finally{f.cleanup();}
});
