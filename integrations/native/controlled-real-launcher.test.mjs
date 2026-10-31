import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runSupervisedPilot} from './controlled-real-launcher.mjs';
import {windowsIncrementalSkip} from '../../docs/handoff-20261031/verify.mjs';

const launcher=new URL('./controlled-real-launcher.mjs',import.meta.url).pathname;
const clean={PATH:process.env.PATH??''};
function callsOf(exec){return exec.calls;}
test('synthetic launcher creates the container, installs a fake private file, then starts, with no network',()=>{
 const exec=trackingDocker();
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,now:()=>1_700_000_000_000});
 try{
  const sub=exec.calls.map(argv=>argv[1]);
  const created=sub.indexOf('create'),copied=sub.indexOf('cp'),started=sub.indexOf('start');
  assert.ok(created!==-1&&created<copied&&copied<started);
  const create=exec.calls.find(argv=>argv[1]==='create');
  assert.equal(create.includes('--network')&&create.includes('none'),true);
  assert.equal(create.includes('-p')||create.includes('--publish'),false);
  assert.equal(create.includes('run'),false);
  assert.equal(create.includes('QIWE_CONTROLLED_REAL_PILOT=1'),true);
  assert.equal(create.includes('QIWE_PILOT_MODEL_REQUESTS=8'),true);
  assert.equal(create.includes('QIWE_PILOT_MODEL_OUTPUT_TOKENS=1024'),true);
  assert.equal(create.some(item=>item.startsWith('ANTHROPIC_API_KEY=')||item.startsWith('DEEPSEEK_')),false);
  assert.equal(result.report.ready,'CONTROLLED_REAL_READY');
  assert.equal(result.report.network,'none');
  assert.equal(result.report.caps.requests,8);
  assert.equal(result.report.caps.outputTokens,1024);
  assert.equal(result.report.caps.durationMs,1800000);
  assert.equal(result.report.expiresAt,1_700_000_000_000+1800000);
  assert.match(result.report.stopCommand,/^docker rm -f qiwe-pilot-host-/);
  assert.equal(JSON.stringify(result.report).includes('synthetic-bot-secret'),false);
  result.stop();
  assert.equal(fs.existsSync(result.privateFile),false);
  assert.equal(exec.calls.some(argv=>argv[1]==='rm'&&argv.includes('-f')),true);
 }finally{result.stop();}
});
test('synthetic launcher refuses a real provider variable before any docker command',()=>{
 const exec=trackingDocker();
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:{...clean,DEEPSEEK_API_KEY:'not-for-logs'},execFileSync:exec.execFileSync}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&!error.message.includes('not-for-logs'));
 assert.equal(exec.calls.length,0);
});
test('real launcher opens a private bridge, installs the file, then starts, and refuses a raised cap',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-real-'));
 const privateFile=path.join(root,'host-private.json');
 fs.writeFileSync(privateFile,JSON.stringify({bot:{botId:'bot-id-example',corpId:'corp-id-example',secret:'host-file-secret-value'},model:{apiKey:'host-file-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}),{mode:0o600});
 const exec=trackingDocker();
 try{
  assert.throws(()=>runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,requests:9,execFileSync:exec.execFileSync}),/PILOT_LAUNCH_BUDGET_CAP/);
  const result=runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:exec.execFileSync,now:()=>1_700_000_000_000,dockerContext:'desktop-linux',entryArgs:['verify-full-host.mjs','--controlled-real-pilot','--full-host-conversations']});
  const sub=exec.calls.map(argv=>argv.find((item,index)=>index>0&&!item.startsWith('--')&&item!=='desktop-linux'));
  const network=sub.indexOf('network'),created=sub.indexOf('create'),copied=sub.indexOf('cp'),started=sub.indexOf('start');
  assert.ok(network!==-1&&network<created&&created<copied&&copied<started);
  const create=exec.calls.find(argv=>argv.includes('create')&&argv.includes('--name'));
  assert.equal(create.includes('--full-host-conversations'),true);
  assert.equal(create.includes('-p')||create.includes('--publish'),false);
  assert.equal(create.some(item=>item.includes('127.0.0.1')),true);
  assert.match(result.report.network,/^qiwe-pilot-/);
  assert.match(result.report.stopCommand,/docker rm -f qiwe-pilot-host-.+ && docker network rm qiwe-pilot-/);
  assert.equal(result.report.stopCommand.includes('host-file-secret-value'),false);
  result.stop();
  assert.equal(exec.calls.some(argv=>argv.includes('network')&&argv.includes('rm')),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('synthetic cli prints the ready line, run id, expiry, and stop command',()=>{
 const child=spawnSync(process.execPath,[launcher,'--synthetic'],{encoding:'utf8',env:clean,timeout:20000});
 assert.equal(child.status,0,child.stderr);
 assert.match(child.stdout,/CONTROLLED_REAL_READY/);
 assert.equal(child.stdout.includes('synthetic-bot-secret'),false);
 const report=JSON.parse(child.stdout.trim().split('\n').filter(line=>line.startsWith('{')).at(-1));
 assert.equal(report.ready,'CONTROLLED_REAL_READY');
 assert.equal(report.mode,'synthetic');
 assert.equal(report.network,'none');
 assert.equal(report.caps.requests,8);
 assert.match(report.stopCommand,/^docker rm -f /);
});
test('windows verify skips filesystem cases and explains the transport scope failure',()=>{
 const text=windowsIncrementalSkip('win32');
 assert.match(text,/SKIP incremental/);
 assert.match(text,/EPERM/);
 assert.match(text,/CONTROLLED_REAL_TRANSPORT_SCOPE/);
 assert.equal(windowsIncrementalSkip('linux'),'');
});
function trackingDocker(){
 const calls=[],files=new Map();
 const execFileSync=(command,args)=>{
  calls.push([command,...args]);
  const op=args.find(item=>['cp','sha256sum','stat','ln','rm','create','start','network'].includes(item));
  if(op==='cp'){const host=args[args.indexOf('--')+1],spec=args.at(-1),dest=spec.slice(spec.indexOf(':')+1);files.set(dest,fs.readFileSync(host));return '';}
  if(op==='sha256sum'||op==='stat'){const target=args.at(-1),data=files.get(target);if(!data){const error=Error('missing');error.status=1;throw error;}if(op==='stat')return `1000 1000 600 1 ${data.length}\n`;return createHash('sha256').update(data).digest('hex')+'  '+target+'\n';}
  if(op==='ln'){const dest=args.at(-1),src=args.at(-2);if(files.has(dest)){const error=Error('File exists');error.status=1;throw error;}files.set(dest,Buffer.from(files.get(src)??''));return '';}
  return '';
 };
 return {calls,execFileSync};
}
