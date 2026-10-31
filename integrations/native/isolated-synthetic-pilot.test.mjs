import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runIsolatedSyntheticFormalPath,runIsolatedSyntheticWorker} from './isolated-synthetic-pilot.mjs';
import {openPilotRunLedger} from './controlled-real-run-budget.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const linuxOnly={skip:process.platform!=='linux'&&'Linux ledger fsync and isolated-synthetic platform gate'};
const cleanEnv={PATH:process.env.PATH??''};
function scratch(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-synthetic-pilot-'));const data=path.join(root,'data');fs.mkdirSync(data);return {root,data,privateConfig:path.join(root,'absent-private.json'),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};}

test('worker order writes the placeholder env from the runner and disposes it after exit',linuxOnly,async()=>{
 const f=scratch();try{
  let spawnEnv;
  const result=await runIsolatedSyntheticWorker({dataDir:f.data,folder:'marketing',privateConfigPath:f.privateConfig,env:{...cleanEnv,OTHER_MARKER:'should-not-forward'},spawnImpl(command,args,options){
   spawnEnv=options.env;
   assert.equal(path.basename(args[0]),'isolated-synthetic-runner.mjs');
   assert.equal(args.length,2);
   const child=spawnSync(command,args,{env:options.env,encoding:'utf8'});
   assert.equal(child.status,0,child.stderr);
   return {code:child.status,signal:null};
  }});
  assert.deepEqual(result.order,['env-witness','runner-spawn','runner-exit','env-dispose']);
  assert.equal(result.disposed,'new_run_file_removed');
  assert.deepEqual(spawnEnv,{PATH:cleanEnv.PATH});
  assert.equal(fs.existsSync(path.join(f.data,'env','marketing','default','main','env')),false);
  assert.equal(JSON.stringify(result).includes('synthetic-placeholder'),false);
 }finally{f.cleanup();}
});

test('a real private file or real token refuses the worker before spawn and does not echo the token',async()=>{
 const f=scratch();const token='super-secret-value-not-for-logs';try{
  fs.writeFileSync(f.privateConfig,'not-json',{mode:0o600});
  let spawned=0;
  await assert.rejects(runIsolatedSyntheticWorker({dataDir:f.data,folder:'marketing',privateConfigPath:f.privateConfig,env:cleanEnv,spawnImpl(){spawned++;return {code:0,signal:null};}}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  fs.rmSync(f.privateConfig);
  await assert.rejects(runIsolatedSyntheticWorker({dataDir:f.data,folder:'marketing',privateConfigPath:f.privateConfig,env:{...cleanEnv,WECOM_BOT_SECRET:token},spawnImpl(){spawned++;return {code:0,signal:null};}}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&!error.message.includes(token)&&!String(error).includes(token));
  await assert.rejects(runIsolatedSyntheticWorker({dataDir:f.data,folder:'marketing',privateConfigPath:f.privateConfig,env:{...cleanEnv,QIWE_CONTROLLED_REAL_PILOT:'1'},spawnImpl(){spawned++;}}),/ISOLATED_SYNTHETIC_REAL_CREDENTIAL/);
  assert.equal(spawned,0);
 }finally{f.cleanup();}
});

test('formal path runs ledger, entry worker, dispose and restart refusal without a real credential',linuxOnly,async()=>{
 const f=scratch();let result;try{
  result=await runIsolatedSyntheticFormalPath({args:['--isolated-synthetic'],env:cleanEnv,privateConfigPath:f.privateConfig});
  assert.deepEqual(result.order,['ledger-create','env-witness','runner-spawn','runner-exit','env-dispose','restart-lookup']);
  assert.equal(result.disposed,'new_run_file_removed');
  assert.equal(result.restart,'PILOT_RESTART_RUNNER_FORBIDDEN');
  assert.equal(result.reserve,'PILOT_RESTART_BUDGET_FORBIDDEN');
  assert.equal(result.reserved,0);
  assert.equal(openPilotRunLedger(result.ledgerPath,{runId:result.runId,maxRequests:8,expiresAt:result.expiresAt}).reserved,0);
  assert.equal(JSON.stringify(result).includes('synthetic-placeholder'),false);
 }finally{f.cleanup();if(result?.root)fs.rmSync(result.root,{recursive:true,force:true});}
});

test('formal path fails closed when real pilot mode, a private file, or a token is present',async()=>{
 const f=scratch();const token='another-secret-value';try{
  let started=0;
  const refuse=options=>assert.rejects(runIsolatedSyntheticFormalPath({...options,spawnEntry(){started++;}}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&!error.message.includes(token));
  await refuse({args:['--isolated-synthetic','--controlled-real-pilot'],env:cleanEnv,privateConfigPath:f.privateConfig});
  await refuse({args:['--isolated-synthetic'],env:{...cleanEnv,QIWE_CONTROLLED_REAL_PILOT:'1'},privateConfigPath:f.privateConfig});
  await refuse({args:['--isolated-synthetic'],env:{...cleanEnv,ANTHROPIC_API_KEY:token},privateConfigPath:f.privateConfig});
  await refuse({args:['--isolated-synthetic'],env:{...cleanEnv,DEEPSEEK_API_KEY:token},privateConfigPath:f.privateConfig});
  await refuse({args:['--isolated-synthetic'],env:{...cleanEnv,ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic'},privateConfigPath:f.privateConfig});
  fs.writeFileSync(f.privateConfig,'{}',{mode:0o600});
  await refuse({args:['--isolated-synthetic'],env:cleanEnv,privateConfigPath:f.privateConfig});
  assert.equal(started,0);
  await assert.rejects(runIsolatedSyntheticFormalPath({args:['--isolated-synthetic','--typecheck'],env:cleanEnv,privateConfigPath:f.privateConfig}),/ISOLATED_SYNTHETIC_ARGUMENTS/);
 }finally{f.cleanup();}
});

test('verify-full-host isolated-synthetic flag completes the formal order and does not open the real pilot',linuxOnly,()=>{
 const child=spawnSync(process.execPath,[path.join(here,'verify-full-host.mjs'),'--isolated-synthetic'],{encoding:'utf8',env:cleanEnv,timeout:20000});
 assert.equal(child.status,0,child.stderr);
 const line=child.stdout.trim().split('\n').at(-1);
 const report=JSON.parse(line);
 assert.equal(report.status,'isolated-synthetic-stopped');
 assert.deepEqual(report.order,['ledger-create','env-witness','runner-spawn','runner-exit','env-dispose','restart-lookup']);
 assert.equal(report.restart,'PILOT_RESTART_RUNNER_FORBIDDEN');
 assert.equal(report.reserve,'PILOT_RESTART_BUDGET_FORBIDDEN');
 assert.equal(child.stdout.includes('synthetic-placeholder')||child.stderr.includes('CONTROLLED_REAL_READY'),false);
 const mixed=spawnSync(process.execPath,[path.join(here,'verify-full-host.mjs'),'--isolated-synthetic','--controlled-real-pilot'],{encoding:'utf8',env:{...cleanEnv,QIWE_CONTROLLED_REAL_PILOT:'1'},timeout:20000});
 assert.equal(mixed.status,1);
 assert.equal(mixed.stderr.trim(),'ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
 assert.equal(mixed.stdout.includes('FULL_HOST_RUN'),false);
});

test('typescript load is outside the audit try and a failure is a fixed code',async()=>{
 const source=fs.readFileSync(path.join(here,'verify-full-host.mjs'),'utf8');
 const runAt=source.indexOf("console.log('FULL_HOST_RUN'");
 const loadAt=source.search(/import\('typescript'\)|loadVerifierTypescript\(/);
 const auditCatch=source.indexOf('catch(error){writeAudit');
 const tryStart=source.lastIndexOf('try{',auditCatch);
 assert.ok(loadAt!==-1&&loadAt<runAt&&loadAt<tryStart);
 const {loadVerifierTypescript}=await import('./full-host-typescript.mjs');
 await assert.rejects(loadVerifierTypescript(async()=>{throw Error('Cannot find package typescript secret-loader-path');}),error=>error.message==='FULL_HOST_TYPESCRIPT_UNAVAILABLE'&&!error.message.includes('secret-loader-path')&&!String(error.stack).includes('secret-loader-path'));
});
