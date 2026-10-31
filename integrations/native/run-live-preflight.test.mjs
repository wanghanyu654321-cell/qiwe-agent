import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'run-live-preflight.mts');
const linuxOnly={skip:process.platform!=='linux'&&'Linux uid mode 0600 and isolated-synthetic platform gate'};
const cleanEnv={PATH:process.env.PATH??''};
const secret='preflight-host-secret-value';
const modelKey='preflight-host-model-key';
function hostFile(root){
 const file=path.join(root,'host-private.json');
 fs.writeFileSync(file,JSON.stringify({bot:{botId:'bot-id-example',corpId:'corp-id-example',secret},model:{apiKey:modelKey,baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}),{mode:0o600});
 return file;
}
function run(args,env=cleanEnv){return spawnSync(process.execPath,[script,...args],{encoding:'utf8',env,timeout:20000});}

test('credential-free preflight runs the formal isolated-synthetic order',linuxOnly,()=>{
 const child=run(['--isolated-synthetic']);
 assert.equal(child.status,0,child.stderr);
 const report=JSON.parse(child.stdout.trim().split('\n').at(-1));
 assert.equal(report.status,'isolated-synthetic-stopped');
 assert.deepEqual(report.order,['ledger-create','env-witness','runner-spawn','runner-exit','env-dispose','restart-lookup']);
 assert.equal(report.restart,'PILOT_RESTART_RUNNER_FORBIDDEN');
 assert.equal(report.reserve,'PILOT_RESTART_BUDGET_FORBIDDEN');
 assert.equal(`${child.stdout}${child.stderr}`.includes('synthetic-placeholder'),false);
});

test('preflight refuses to mix isolated-synthetic with a private file or a real token',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-preflight-mix-'));
 try{
  const file=hostFile(root),destination=path.join(root,'should-not-exist.json');
  const mixed=run(['--isolated-synthetic','--private-file',file,'--destination',destination]);
  assert.equal(mixed.status,1);
  assert.equal(mixed.stderr.trim(),'ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  assert.equal(fs.existsSync(destination),false);
  assert.equal(mixed.stdout.includes(secret)||mixed.stderr.includes(secret),false);
  const token=run(['--isolated-synthetic'],{...cleanEnv,ANTHROPIC_API_KEY:modelKey});
  assert.equal(token.status,1);
  assert.equal(token.stderr.trim(),'ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  assert.equal(token.stderr.includes(modelKey)||token.stdout.includes(modelKey),false);
  const deepseek=run(['--isolated-synthetic'],{...cleanEnv,DEEPSEEK_API_KEY:'cc-switch-key-not-for-logs',ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic'});
  assert.equal(deepseek.status,1);
  assert.equal(deepseek.stderr.trim(),'ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  assert.equal(`${deepseek.stdout}${deepseek.stderr}`.includes('cc-switch-key-not-for-logs'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('preflight installs a host file as uid 1000 mode 0600 and does not print it',linuxOnly,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-preflight-install-'));
 try{
  const file=hostFile(root),destination=path.join(root,'container-private.json');
  const child=run(['--private-file',file,'--destination',destination]);
  assert.equal(child.status,0,child.stderr);
  const report=JSON.parse(child.stdout.trim());
  assert.deepEqual(report,{status:'private-config-installed',uid:1000,gid:1000,mode:'0600',nlink:1});
  const stat=fs.lstatSync(destination);
  assert.equal(stat.uid,1000);assert.equal(stat.gid,1000);assert.equal(stat.nlink,1);assert.equal(stat.mode&0o777,0o600);
  assert.equal(fs.readFileSync(destination,'utf8').includes(secret),true);
  assert.equal(child.stdout.includes(secret)||child.stderr.includes(secret)||child.stdout.includes(modelKey)||child.stderr.includes(modelKey),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
