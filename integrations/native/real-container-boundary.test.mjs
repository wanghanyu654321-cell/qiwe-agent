import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {admitDockerRun,admitDockerControl,admitDockerShell} from './real-container-boundary.mjs';
test('routes original info and only owned stop forms, rejecting extra shell/process commands',()=>{
 const owned=new Set(['miniclaw-synthetic-warm-1']);
 assert.deepEqual(admitDockerControl('docker',['info','--format','{{json .SecurityOptions}}'],owned),['info','--format','{{json .SecurityOptions}}']);
 assert.deepEqual(admitDockerShell('docker stop miniclaw-synthetic-warm-1',owned),['stop','miniclaw-synthetic-warm-1']);
 assert.throws(()=>admitDockerShell('docker stop miniclaw-synthetic-warm-1; echo leaked',owned),/SHELL/);
 assert.throws(()=>admitDockerControl('docker',['stop','miniclaw-synthetic-foreign-1'],owned),/ARGUMENT/);
 assert.throws(()=>admitDockerControl('docker',['info','--host','tcp://remote'],owned),/ARGUMENT/);
 assert.throws(()=>admitDockerControl('powershell',['anything'],owned),/COMMAND/);
});
test('retains original mounts and stdin run flags while imposing fixed child isolation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'real-boundary-'));
 try{
  fs.mkdirSync(path.join(root,'group'));
  const options={root,runner:root,deps:root,provider:path.join(root,'provider.mjs'),image:'sha256:'+'a'.repeat(64),runId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',expectedMounts:{'/workspace/group':{source:path.join(root,'group'),readonly:false}}};
  const args=['run','-i','--rm','--name','miniclaw-synthetic-1','-e','TZ=UTC','-v',path.join(root,'group')+':/workspace/group',options.image];
  const admitted=admitDockerRun(args,options);
  assert.deepEqual(admitted.mounts,[{source:fs.realpathSync(path.join(root,'group')),destination:'/workspace/group',readonly:false}]);
  assert.ok(admitted.args.includes('--read-only'));assert.ok(admitted.args.includes('none'));
  assert.ok(admitted.args.includes('/home/node/.claude/skills:rw,nosuid,nodev'));
  const readonlyOptions={...options,expectedMounts:{'/app/src':{source:path.join(root,'group'),readonly:true}}};
  const readonlyArgs=args.map((arg,index)=>index===8?path.join(root,'group')+':/app/src:ro':arg);
  assert.deepEqual(admitDockerRun(readonlyArgs,readonlyOptions).mounts,[{source:fs.realpathSync(path.join(root,'group')),destination:'/app/src',readonly:true}]);
  assert.throws(()=>admitDockerRun([...args.slice(0,-1),'-v','/var/run/docker.sock:/var/run/docker.sock',options.image],options),/MOUNT/);
  assert.throws(()=>admitDockerRun(['run','--privileged',options.image],options),/ARGUMENT/);
  assert.throws(()=>admitDockerRun([...args.slice(0,-1),'other-image'],options),/IMAGE/);
  assert.throws(()=>admitDockerRun([...args.slice(0,-1),'-e','ANTHROPIC_API_KEY=unexpected',options.image],options),/ENV/);
  assert.throws(()=>admitDockerRun([...args.slice(0,-1),'-v',path.join(root,'group')+':/app/src',options.image],options),/MODE/);
  assert.throws(()=>admitDockerRun([...args.slice(0,-1),'-v',root+':/workspace/ipc',options.image],options),/ESCAPE/);
  fs.mkdirSync(path.join(root,'other-group'));
  assert.throws(()=>admitDockerRun(args.map((arg,index)=>index===8?path.join(root,'other-group')+':/workspace/group':arg),options),/TARGET_MISMATCH/);
  const pinned={...options,image:'node@sha256:'+'b'.repeat(64)};
  assert.equal(admitDockerRun([...args.slice(0,-1),pinned.image],pinned).args.at(-2),pinned.image);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
