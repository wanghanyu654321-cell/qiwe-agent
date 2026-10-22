import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {linuxContainerArguments, verifyOriginalLinuxSqlite,sealControlledLinuxCopy,verifyControlledLinuxCopy,runLinuxContainer} from './linux-runtime.mjs';

test('container is local, offline, read-only and only mounts the supplied copied tree',()=>{
  const root=process.platform==='win32'?'D:/synthetic-copy':'/tmp/synthetic-copy';
  const args=linuxContainerArguments(root,['/input/qiwe-agent/integrations/native/verify-full-host.mjs']);
  assert.deepEqual(args.slice(0,4),['--context','desktop-linux','run','--rm']);
  for(const flag of ['--read-only','--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--pull=never'])assert.ok(args.includes(flag));
  assert.equal(args.filter(value=>value.startsWith('--mount=')).length,1);
  assert.ok(args.includes(`--mount=type=bind,source=${root},target=/input,readonly`));
  assert.match(args.find(value=>value.startsWith('node@')), /^node@sha256:[a-f0-9]{64}$/);
  assert.ok(args.includes('--tmpfs=/tmp:rw,nosuid,nodev,size=768m'));
  assert.ok(args.includes('--env=QIWE_EVIDENCE_ROOT=/tmp/qiwe-full-host-evidence'));
  assert.ok(args.includes('--memory=4g'));
});

test('container rejects broad or ambiguous mounts and arbitrary interpreter options',()=>{
  for(const root of ['relative','/', 'C:/', '/tmp/copy,readonly=false'])assert.throws(()=>linuxContainerArguments(root,['/input/verify.mjs']),/copy root/);
  assert.throws(()=>linuxContainerArguments('/tmp/synthetic-copy',['--eval','danger']),/entry point/);
});

test('original Linux driver verifier does not admit a Windows process or guessed driver',()=>{
  assert.throws(()=>verifyOriginalLinuxSqlite('relative'),/Linux x64 Node ABI 127|absolute Native/);
});

for(const owned of [true,false])test('timeout cleanup only removes a container with this run name and label: '+owned,()=>{
  const commands=[],nonce='11111111-1111-4111-8111-111111111111',name='qiwe-native-linux-'+nonce;
  const execute=(_binary,args)=>{
    commands.push(args);
    if(args[0]==='context')return {status:0,stdout:'npipe:////./pipe/dockerDesktopLinuxEngine\n'};
    if(args.includes('run'))return {status:null,error:new Error('synthetic timeout')};
    if(args.includes('inspect'))return {status:0,stdout:JSON.stringify({name:'/'+name,running:true,labels:{'qiwe.native.linux.validation':owned?nonce:'different-run'}})};
    return {status:0,stdout:''};
  };
  assert.throws(()=>runLinuxContainer(process.platform==='win32'?'D:/synthetic-copy':'/tmp/synthetic-copy',['/input/verify.mjs'],{execute,nonce}),/synthetic timeout/);
  assert.equal(commands.filter(args=>args.includes('stop')).length,owned?1:0);
  assert.equal(commands.filter(args=>args.includes('rm')).length,owned?1:0);
  for(const args of commands.filter(args=>args.includes('stop')||args.includes('rm')))assert.equal(args.at(-1),name);
});

test('automatic removal after stop preserves the original timeout and does not report a cleanup error',()=>{
  const nonce='22222222-2222-4222-8222-222222222222',name='qiwe-native-linux-'+nonce;let stopped=false,removed=0;
  const execute=(_binary,args)=>{
    if(args[0]==='context')return {status:0,stdout:'npipe:////./pipe/dockerDesktopLinuxEngine\n'};
    if(args.includes('run'))return {status:null,error:new Error('synthetic timeout')};
    if(args.includes('stop')){stopped=true;return {status:0,stdout:name};}
    if(args.includes('rm')){removed++;return {status:1,stderr:'No such container'};}
    return stopped?{status:1,stderr:'No such container'}:{status:0,stdout:JSON.stringify({name:'/'+name,running:true,labels:{'qiwe.native.linux.validation':nonce}})};
  };
  assert.throws(()=>runLinuxContainer(process.platform==='win32'?'D:/synthetic-copy':'/tmp/synthetic-copy',['/input/verify.mjs'],{execute,nonce}),/synthetic timeout/);
  assert.equal(removed,0);
});

const source=process.env.QIWE_LINUX_NATIVE_SOURCE;

test('controlled copy admits runner source, prompts and dependencies but excludes runtime data',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-linux-runner-test-'));
  const runner=path.join(root,'.local/full-instance/stage/app/container/agent-runner');
  try{
    for(const relative of ['src/pi-index.ts','prompts/system.md','node_modules/synthetic/index.js','package.json','package-lock.json','tsconfig.json']){
      const file=path.join(runner,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic');
    }
    sealControlledLinuxCopy(root);assert.equal(verifyControlledLinuxCopy(root).files,6);
    for(const relative of ['.env','config/private.json','sessions/history.json','node_modules/synthetic/.env']){
      const file=path.join(runner,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic');
      assert.throws(()=>sealControlledLinuxCopy(root),/Unapproved stage path/);
      fs.unlinkSync(file);
      if(relative.startsWith('config/')||relative.startsWith('sessions/'))fs.rmdirSync(path.dirname(file));
    }
    assert.equal(verifyControlledLinuxCopy(root).files,6);
  }finally{
    assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('controlled copy admits only the exact public offline SDK fixture under tests',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-linux-fixture-test-'));
  try{
    const directory=path.join(root,'qiwe-agent/tests/fixtures');fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'offline-bot-sdk.ts'),'// synthetic public fixture');
    sealControlledLinuxCopy(root);assert.equal(verifyControlledLinuxCopy(root).files,1);
    fs.writeFileSync(path.join(directory,'credentials.json'),'synthetic forbidden');
    assert.throws(()=>sealControlledLinuxCopy(root),/Unapproved stage path/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('controlled copy admits the three existing D4 skill definitions without other skill payloads',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-linux-skills-test-'));
  try{
    const skills=path.join(root,'.local/d4-skills');
    for(const id of ['beauty-local-content','vendor-content-strategy','vendor-copywriting']){
      fs.mkdirSync(path.join(skills,id),{recursive:true});
      fs.writeFileSync(path.join(skills,id,'SKILL.md'),'synthetic');
    }
    sealControlledLinuxCopy(root);assert.equal(verifyControlledLinuxCopy(root).files,3);
    for(const file of ['vendor-copywriting/run.js','vendor-copywriting/.env','other/SKILL.md']){
      const target=path.join(skills,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'synthetic');
      assert.throws(()=>sealControlledLinuxCopy(root),/Unapproved stage path/);
      fs.unlinkSync(target);if(file.startsWith('other/'))fs.rmdirSync(path.dirname(target));
    }
    assert.equal(verifyControlledLinuxCopy(root).files,3);
  }finally{
    assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
test('controlled copy inventory rejects credentials, symlinks, missing and changed files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-linux-stage-test-'));
  try{
    fs.mkdirSync(path.join(root,'qiwe-agent/src'),{recursive:true});
    const file=path.join(root,'qiwe-agent/src/sample.ts');fs.writeFileSync(file,'export const value=1;');
    sealControlledLinuxCopy(root);assert.equal(verifyControlledLinuxCopy(root).files,1);
    fs.appendFileSync(file,'changed');assert.throws(()=>verifyControlledLinuxCopy(root),/inventory changed/);
    fs.writeFileSync(file,'export const value=1;');fs.writeFileSync(path.join(root,'qiwe-agent/.env'),'synthetic');
    assert.throws(()=>sealControlledLinuxCopy(root),/Unapproved stage path/);
    fs.rmSync(path.join(root,'qiwe-agent/.env'));fs.rmSync(file);assert.throws(()=>verifyControlledLinuxCopy(root),/inventory changed/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('stage marker must be a regular file and is checked before reading its content',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-linux-stage-marker-')),marker=path.join(root,'.qiwe-linux-stage.json');
  try{
    fs.mkdirSync(marker);assert.throws(()=>verifyControlledLinuxCopy(root),/marker must be a regular file/);fs.rmdirSync(marker);
    if(process.platform==='linux'){
      const outside=path.join(os.tmpdir(),path.basename(root)+'-not-json');fs.writeFileSync(outside,'synthetic non-JSON content');
      try{fs.symlinkSync(outside,marker);assert.throws(()=>verifyControlledLinuxCopy(root),/symlinks are forbidden/);}finally{fs.unlinkSync(marker);fs.unlinkSync(outside);}
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux original driver really loads and rejects substituted JS, binary and loader before execution',{skip:!source},()=>{
  assert.equal(verifyOriginalLinuxSqlite(source).binarySha256,'df9fbd0d061f360d81fb51e265c53c9605020bd68219e34f33c07c85de15719a');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-linux-identity-'));
  try{
    fs.mkdirSync(path.join(directory,'src'));
    fs.copyFileSync(path.join(source,'../package-lock.json'),path.join(directory,'package-lock.json'));
    for(const name of ['better-sqlite3','bindings','file-uri-to-path'])fs.cpSync(path.join(source,'../node_modules',name),path.join(directory,'node_modules',name),{recursive:true});
    for(const [relative,error]of [['better-sqlite3/lib/index.js',/JS changed/],['better-sqlite3/build/Release/better_sqlite3.node',/binary changed/],['bindings/bindings.js',/loader changed/]]){
      const file=path.join(directory,'node_modules',relative),original=fs.readFileSync(file);
      fs.appendFileSync(file,'\n;globalThis.__qiweUntrustedLoaderExecuted=true;');
      assert.throws(()=>verifyOriginalLinuxSqlite(path.join(directory,'src')),error);
      assert.equal(globalThis.__qiweUntrustedLoaderExecuted,undefined);
      fs.writeFileSync(file,original);
    }
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
