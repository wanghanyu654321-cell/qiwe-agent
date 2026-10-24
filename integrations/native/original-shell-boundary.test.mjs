import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {admitDockerRun} from './real-container-boundary.mjs';
import {originalShellHelpers} from './original-shell.mjs';

test('original shell mode retains image entrypoint and fixed six-capability profile',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shell-boundary-'));
 try{
  const group=path.join(root,'group');fs.mkdirSync(group);
  const provider=path.join(root,'provider.mjs');fs.writeFileSync(provider,'// fixture');
  const image='sha256:'+'a'.repeat(64);
  const options={root,runner:root,deps:root,provider,image,runId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',expectedMounts:{'/workspace/group':{source:group,readonly:false}},originalShell:{image,entrypoint:['/app/entrypoint.sh'],verified:true,piVersion:'0.84.2',files:{...originalShellHelpers}}};
  const args=['run','-i','--rm','--name','miniclaw-synthetic-shell-1','-e','TZ=UTC','-e','MINICLAW_HOST_IDENTITY_MODE=virtualized','-v',group+':/workspace/group',image];
  const admitted=admitDockerRun(args,options);
  assert.equal(admitted.args.at(-1),image);
  assert.equal(admitted.args.includes('--entrypoint'),false);
  assert.equal(admitted.args.some(value=>value===root+':/app:ro'||value===root+':/app/node_modules:ro'),false);
  const caps=admitted.args.flatMap((value,index)=>value==='--cap-add'?[admitted.args[index+1]]:[]);
  assert.deepEqual(caps,['CHOWN','DAC_OVERRIDE','FOWNER','KILL','SETGID','SETUID']);
  assert.ok(admitted.args.includes('/run:rw,nosuid,nodev'));
  assert.ok(admitted.args.includes('/home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700'));
  for(const shell of [undefined,{...options.originalShell,verified:false},{...options.originalShell,image:'sha256:'+'b'.repeat(64)},{...options.originalShell,entrypoint:['node']}]){
   if(shell===undefined)continue;
   assert.throws(()=>admitDockerRun(args,{...options,originalShell:shell}),/ORIGINAL_SHELL/);
  }
  assert.throws(()=>admitDockerRun(args.map(value=>value==='MINICLAW_HOST_IDENTITY_MODE=virtualized'?'MINICLAW_HOST_IDENTITY_MODE=direct':value),options),/ORIGINAL_SHELL_IDENTITY/);
  assert.throws(()=>admitDockerRun(args,{...options,provider:path.dirname(root)+'/foreign-provider'}),/ORIGINAL_SHELL_PROVIDER/);
  assert.throws(()=>admitDockerRun(args,{...options,originalShell:{...options.originalShell,piVersion:'0.84.3'}}),/ORIGINAL_SHELL/);
  assert.throws(()=>admitDockerRun(args,{...options,originalShell:{...options.originalShell,files:{}}}),/ORIGINAL_SHELL/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
