import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sealControlledLinuxCopy} from './linux-runtime.mjs';
let api={};try{api=await import('./local-pilot-host.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const need=name=>{assert.equal(typeof api[name],'function',`${name} must implement explicit local initialization`);return api[name];};
const runId='11111111-1111-4111-8111-111111111111',root=path.resolve('.local/local-pilot-host-test'),copy=path.resolve('.local/controlled-copy');
test('requires explicit command and controlled copy only for first start',()=>{
 const parse=need('parseLocalPilotArguments');assert.deepEqual(parse(['start','--copy-root',copy]),{command:'start',copyRoot:copy});
 assert.deepEqual(parse(['status']),{command:'status'});assert.deepEqual(parse(['stop']),{command:'stop'});
 for(const args of [[],['start'],['start','--copy-root','relative'],['status','--copy-root',copy],['start','--image','other'],['stop','foreign'],['start','--copy-root',copy,'--copy-root',copy]])assert.throws(()=>parse(args),/local pilot arguments/);
});
test('publishes only loopback and mounts only readonly code/copy plus task data',()=>{
 const args=need('localPilotContainerArguments')({root,copyRoot:copy,runId});
 assert.ok(args.includes('--publish=127.0.0.1:39130:3000'));assert.ok(args.includes('--network=qiwe-local-pilot-'+runId+'-web'));
 for(const flag of ['--pull=never','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges'])assert.ok(args.includes(flag));
 assert.deepEqual(args.filter(v=>v.startsWith('--mount=')),[`--mount=type=bind,source=${copy},target=/input,readonly`,`--mount=type=bind,source=${path.join(root,'code')},target=/source,readonly`,`--mount=type=bind,source=${path.join(root,'data')},target=/pilot/data`]);
 const env=args.filter(v=>v.startsWith('--env='));assert.ok(env.includes('--env=MINICLAW_EXECUTION_BOUNDARY=member-container-only'));assert.ok(env.includes('--env=PLUGIN_AUTO_SCAN=false'));assert.ok(!env.some(v=>/SECRET|TOKEN|API_KEY|BOT|ANTHROPIC|FEISHU/.test(v)));assert.ok(!args.some(v=>/docker.sock|--privileged|--volume/.test(v)));
 for(const bad of ['',path.parse(root).root,copy+',readonly=false'])assert.throws(()=>need('localPilotContainerArguments')({root:bad,copyRoot:copy,runId}),/pilot path/);
});
test('boot compiles unmodified original modules and launches actual main with observed paused gate',()=>{
 const boot=need('localPilotBootSource')();assert.match(boot,/verifyOriginalLinuxSqlite/);assert.match(boot,/transpileModule/);assert.match(boot,/await import\(.*index\.js/);assert.match(boot,/localPilotGate\.phase\(\)/);assert.match(boot,/'paused'/);assert.doesNotMatch(boot,/fixture|createUserSession|setSafe|commitRestore|createWecomBotPilot|fetch\(/);
});
test('status with no task manifest does not run Docker or start a host',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-status-'));try{let calls=0;const s=await need('localPilotCommand')({command:'status'},{root:tmp,execute:()=>{calls++;throw Error('unexpected');}});assert.equal(s.state,'not-initialized');assert.equal(calls,0);}finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
function manifest(tmp){const m={version:1,runId,name:'qiwe-local-pilot-'+runId,copyRoot:copy,codeHash:'a'.repeat(64)};fs.writeFileSync(path.join(tmp,'host.json'),JSON.stringify(m));return m;}
test('stop checks exact container label and preserves data without deleting containers',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-stop-'));try{const m=manifest(tmp);fs.mkdirSync(path.join(tmp,'data'));fs.writeFileSync(path.join(tmp,'data','keep'),'owned local data');const calls=[];
 const execute=(_bin,args)=>{calls.push(args);if(args[0]==='context')return {status:0,stdout:'npipe:////./pipe/dockerDesktopLinuxEngine'};if(args.includes('inspect'))return {status:0,stdout:JSON.stringify({name:'/'+m.name,id:'c'.repeat(64),running:true,labels:{'qiwe.local.pilot':runId}})};return {status:0,stdout:''};};
 const s=await need('localPilotCommand')({command:'stop'},{root:tmp,execute});assert.equal(s.state,'stopped');assert.equal(calls.filter(a=>a.includes('stop')).length,1);assert.ok(!calls.some(a=>a.includes('rm')||a.includes('run')||a.includes('start')));assert.equal(fs.readFileSync(path.join(tmp,'data','keep'),'utf8'),'owned local data');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('foreign container or remote daemon never receives stop',async()=>{
 for(const remote of [true,false]){const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-foreign-'));try{const m=manifest(tmp),calls=[];const execute=(_bin,args)=>{calls.push(args);return args[0]==='context'?{status:0,stdout:remote?'tcp://remote:2375':'npipe:////./pipe/dockerDesktopLinuxEngine'}:{status:0,stdout:JSON.stringify({name:'/'+m.name,running:true,labels:{'qiwe.local.pilot':'foreign'}})};};await assert.rejects(need('localPilotCommand')({command:'stop'},{root:tmp,execute}),/local Docker|ownership/);assert.ok(!calls.some(a=>a.includes('stop')));}finally{fs.rmSync(tmp,{recursive:true,force:true});}}
});

test('creates only the missing target network; daemon and permission failures stop before creation',async()=>{
 const name='qiwe-local-pilot-'+runId,network=name+'-web';
 for(const [stderr,missing,existing] of [
  ['Error response from daemon: network '+network+' not found',true],
  ['Error: No such network: '+network,true],
  ['Error response from daemon: network other-network not found',false],
  ['permission denied while trying to connect to the Docker daemon socket',false],
  ['Cannot connect to the Docker daemon',false],
  ['',true,{internal:false,labels:{'qiwe.local.pilot':runId}}],
  ['',false,{internal:true,labels:{'qiwe.local.pilot':runId}}],
  ['',false,{internal:false,labels:{'qiwe.local.pilot':'foreign'}}],
 ]){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-network-'));
  try{
   const task=path.join(tmp,'task'),controlled=path.join(tmp,'copy');fs.mkdirSync(task);fs.mkdirSync(controlled);fs.mkdirSync(path.join(task,'code'));sealControlledLinuxCopy(controlled);
   fs.writeFileSync(path.join(task,'host.json'),JSON.stringify({version:1,runId,name,copyRoot:controlled,codeHash:createHash('sha256').update('').digest('hex')}));
   const calls=[];let running=false;
   const execute=(_bin,args)=>{
    calls.push(args);
    if(args[0]==='context')return {status:0,stdout:'npipe:////./pipe/dockerDesktopLinuxEngine'};
    if(args.includes('--type=container'))return running?{status:0,stdout:JSON.stringify({name:'/'+name,id:'c'.repeat(64),running:true,labels:{'qiwe.local.pilot':runId}})}:{status:1,stderr:'Error: No such object: '+name};
    if(args.includes('network')&&args.includes('inspect')){assert.equal(args.at(-1),network);return existing?{status:0,stdout:JSON.stringify(existing)}:{status:1,stderr};}
    if(args.includes('run'))running=true;
    return {status:0,stdout:''};
   };
   const starting=need('localPilotCommand')({command:'start',copyRoot:controlled},{root:task,execute});
   if(missing)assert.equal((await starting).state,'running');else await assert.rejects(starting,/network (state unknown|ownership mismatch)/);
   const creations=calls.filter(args=>args.includes('network')&&args.includes('create'));
   assert.equal(creations.length,missing&&!existing?1:0);
   for(const args of creations){assert.equal(args.at(-1),network);assert.ok(!args.includes('--internal'));}
   assert.equal(calls.filter(args=>args.includes('run')).length,missing?1:0);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 }
});
