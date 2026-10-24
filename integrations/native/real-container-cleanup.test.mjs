import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runLocalVerification,cleanupOwnedContainers} from './real-container-cleanup.mjs';
import {linuxImage} from './linux-runtime.mjs';

test('actual verifier timeout cleans only its labelled child, and refuses foreign ownership',{
 skip:process.platform!=='win32'||!process.env.QIWE_REAL_CONTAINER_DOCKER,
},async()=>{
 const docker=process.env.QIWE_REAL_CONTAINER_DOCKER,endpoint='npipe:////./pipe/dockerDesktopLinuxEngine';
 const runId=randomUUID(),foreignId=randomUUID(),root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-cleanup-test-'));
 const manifest=path.join(root,'owned.txt'),foreignManifest=path.join(root,'foreign.txt');
 const name='miniclaw-synthetic-timeout-'+runId,foreignName='miniclaw-synthetic-foreign-'+foreignId;
 const command=args=>execFileSync(docker,['--host',endpoint,...args],{encoding:'utf8',timeout:15000,windowsHide:true});
 try{
  command(['image','inspect',linuxImage]);
  const child=`const fs=require('fs'),cp=require('child_process');fs.writeFileSync(${JSON.stringify(manifest)},${JSON.stringify(name+'\n')});const child=cp.spawn(${JSON.stringify(docker)},${JSON.stringify(['--host',endpoint,'run','--pull=never','-i','--rm','--name',name,'--label','qiwe.verification-run='+runId,'--network','none','--read-only',linuxImage,'node','-e','setInterval(()=>{},1000)'])});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);setInterval(()=>{try{const s=cp.execFileSync(${JSON.stringify(docker)},['--host',${JSON.stringify(endpoint)},'inspect',${JSON.stringify(name)},'--format','{{.State.Running}}'],{stdio:['ignore','pipe','ignore']}).toString();if(s.trim()==='true')fs.writeFileSync(${JSON.stringify(path.join(root,'started'))},'started');}catch{}},200);`;
  await assert.rejects(runLocalVerification(process.execPath,['-e',child],{cwd:root,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},timeout:10000,log:path.join(root,'child.log')}),/REAL_CONTAINER_PROCESS_TIMEOUT/);
  assert.equal(fs.readFileSync(path.join(root,'started'),'utf8'),'started');
  assert.ok(cleanupOwnedContainers({docker,endpoint,manifest,runId}).every(item=>item.absent));
  fs.writeFileSync(foreignManifest,foreignName+'\n');
  command(['run','--pull=never','-d','--rm','--name',foreignName,'--label','qiwe.verification-run='+foreignId,'--network','none','--read-only',linuxImage,'node','-e','setInterval(()=>{},1000)']);
  assert.throws(()=>cleanupOwnedContainers({docker,endpoint,manifest:foreignManifest,runId}),error=>error.cleanup?.[0]?.error==='ownership-mismatch');
  assert.equal(command(['inspect',foreignName,'--format','{{.State.Running}}']).trim(),'true');
 }finally{
  cleanupOwnedContainers({docker,endpoint,manifest,runId});
  cleanupOwnedContainers({docker,endpoint,manifest:foreignManifest,runId:foreignId});
  const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('qiwe-cleanup-test-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
});
