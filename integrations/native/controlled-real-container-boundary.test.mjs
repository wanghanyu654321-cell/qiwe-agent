import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as boundary from './real-container-boundary.mjs';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'controlled-real-runner-'));
 const group=path.join(root,'group'),preload=path.join(root,'preload.mjs'),modelModule=path.join(root,'model.ts');
 fs.mkdirSync(group);fs.writeFileSync(preload,'// preload');fs.writeFileSync(modelModule,'// model');
 const runId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',image='sha256:'+'a'.repeat(64);
 const controlledRealPilot={mode:'controlled-real-pilot',environment:'local-test',runId,expiresAt:Date.now()+600000,networkName:'qiwe-pilot-'+runId};
 const options={root,preload,modelModule,image,runId,controlledRealPilot,maxRequests:8,maxOutputTokens:1024,ownedContainerPrefix:'miniclaw-marketing-',
  expectedMounts:{'/workspace/group':{source:group,readonly:false}},expectedIdentity:'direct',expectedUid:1000,expectedGid:1000,
  originalShell:{verified:true,image,entrypoint:['/app/entrypoint.sh'],piVersion:'0.84.2',piAiVersions:{topLevel:'0.84.2',nested:'0.84.2'},files:{...boundary.originalShellHelpers}}};
 const args=['run','-i','--rm','--name','miniclaw-marketing-123','-e','MINICLAW_HOST_IDENTITY_MODE=direct','-e','MINICLAW_HOST_UID=1000','-e','MINICLAW_HOST_GID=1000','-v',group+':/workspace/group',image];
 return {root,group,preload,modelModule,runId,image,options,args,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('admits only original shell and mounts with scoped bridge and bounded model preload, no secret on command line',()=>{
 const f=fixture();try{
  const admitted=boundary.admitControlledRealDockerRun(f.args,f.options),args=admitted.args;
  assert.equal(admitted.name,'miniclaw-marketing-123');assert.equal(args.at(-1),f.image);
  assert.equal(args[args.indexOf('--network')+1],'qiwe-pilot-'+f.runId);
  for(const token of ['--read-only','--cap-drop','no-new-privileges','QIWE_PILOT_MODEL_REQUESTS=8','QIWE_PILOT_MODEL_OUTPUT_TOKENS=1024'])assert.ok(args.includes(token),token);
  assert.ok(args.includes(fs.realpathSync(f.preload)+':/verification/controlled-real-preload.mjs:ro'));
  assert.ok(args.includes(fs.realpathSync(f.modelModule)+':/verification/controlled-real-model.ts:ro'));
  assert.equal(args.some(v=>v.includes('ANTHROPIC_API_KEY')||v.includes('provider.mjs')||v==='--entrypoint'),false);
 }finally{f.cleanup();}
});
test('rejects foreign scope, exhausted deadline, unsafe limits, identity, shell, mount, or added environment',()=>{
 const f=fixture();try{
  for(const bad of [
   {controlledRealPilot:{...f.options.controlledRealPilot,environment:'production'}},
   {controlledRealPilot:{...f.options.controlledRealPilot,expiresAt:Date.now()-1}},
   {controlledRealPilot:{...f.options.controlledRealPilot,networkName:'bridge'}},
   {controlledRealPilot:{...f.options.controlledRealPilot,runId:'other'}},
   {controlledRealPilot:{...f.options.controlledRealPilot,expiresAt:Date.now()+1801000}},
   {maxRequests:9},{maxRequests:0},{maxOutputTokens:1025},
   {expectedIdentity:'virtualized'},{expectedUid:1},{originalShell:{...f.options.originalShell,verified:false}},
   {expectedMounts:{'/workspace/group':{source:f.group,readonly:true}}},
  ])assert.throws(()=>boundary.admitControlledRealDockerRun(f.args,{...f.options,...bad}));
  assert.throws(()=>boundary.admitControlledRealDockerRun([...f.args.slice(0,-1),'-e','ANTHROPIC_API_KEY=unexpected',f.image],f.options));
  assert.throws(()=>boundary.admitControlledRealDockerRun([...f.args.slice(0,-1),'-v',f.root+':/workspace/ipc',f.image],f.options));
 }finally{f.cleanup();}
});
test('rejects preload outside run root, hard links and missing original shell',()=>{
 const f=fixture();try{
  assert.throws(()=>boundary.admitControlledRealDockerRun(f.args,{...f.options,preload:path.join(os.tmpdir(),'other')}));
  const alias=path.join(f.root,'alias.mjs');fs.linkSync(f.preload,alias);
  assert.throws(()=>boundary.admitControlledRealDockerRun(f.args,{...f.options,preload:alias}));
  assert.throws(()=>boundary.admitControlledRealDockerRun(f.args,{...f.options,originalShell:undefined}));
 }finally{f.cleanup();}
});
