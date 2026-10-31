import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {launcherPlan,runSupervisedPilot} from './controlled-real-launcher.mjs';
import {windowsEpermCase} from '../../docs/handoff-20261031/verify.mjs';

const launcher=new URL('./controlled-real-launcher.mjs',import.meta.url).pathname;
const clean={PATH:process.env.PATH??''};
function callsOf(exec){return exec.calls;}
test('synthetic launcher creates the container, installs a fake private file, then starts, with no network',()=>{
 const exec=trackingDocker();
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,now:()=>1_700_000_000_000});
 try{
  const sub=exec.calls.map(argv=>argv[1]);
  const created=sub.indexOf('create'),started=sub.indexOf('start'),copied=sub.indexOf('cp'),execed=exec.calls.findIndex(argv=>argv.includes('exec'));
  assert.ok(created!==-1&&created<started&&started<copied&&copied<=execed);
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
  assert.equal(result.report.web.scope,'container-loopback');
  assert.equal(result.report.web.hostPublished,false);
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
  const network=sub.indexOf('network'),created=sub.indexOf('create'),started=sub.indexOf('start'),copied=sub.indexOf('cp');
  assert.ok(network!==-1&&network<created&&created<started&&started<copied);
  const create=exec.calls.find(argv=>argv.includes('create')&&argv.includes('--name'));
  assert.equal(create.some(item=>item.includes('exec node verify-full-host.mjs --controlled-real-pilot --full-host-conversations')),true);
  assert.equal(create.includes('-p')||create.includes('--publish'),false);
  assert.equal(create.some(item=>item.includes('127.0.0.1')),true);
  assert.match(result.report.network,/^qiwe-pilot-/);
  assert.match(result.report.stopCommand,/docker --context desktop-linux rm -f qiwe-pilot-host-.+ && docker --context desktop-linux network rm qiwe-pilot-/);
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
test('windows verify skips only an EPERM fsync or symlink failure and still runs other files',()=>{
 const eperm='# Subtest: symlink\nnot ok 2 - symlink\n  error: EPERM: operation not permitted, symlink \'D:\\\\tmp\'\n';
 const fsync='# Subtest: fsync\nnot ok 1 - fsync\n  error: EPERM: operation not permitted, fsync\n';
 const assertion='# Subtest: scope\nnot ok 1 - scope\n  error: CONTROLLED_REAL_TRANSPORT_SCOPE\n';
 assert.equal(windowsEpermCase(eperm),true);
 assert.equal(windowsEpermCase(fsync),true);
 assert.equal(windowsEpermCase(assertion),false);
 assert.equal(windowsEpermCase(eperm+assertion),false);
 const plan=launcherPlan('win32');
 assert.equal(plan.incremental,'per-file');
 assert.equal(launcherPlan('linux').incremental,'suite');
});
test('a failed start removes the container and the bridge',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-fail-'));
 const privateFile=path.join(root,'host-private.json');
 fs.writeFileSync(privateFile,JSON.stringify({bot:{botId:'bot-id-example',corpId:'corp-id-example',secret:'host-file-secret-value'},model:{apiKey:'host-file-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}),{mode:0o600});
 const exec=trackingDocker({failStart:true});
 try{
  assert.throws(()=>runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:exec.execFileSync,dockerContext:'desktop-linux'}),/PILOT_LAUNCH_FAILED|Error/);
  assert.equal(exec.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')),true);
  assert.equal(exec.calls.some(argv=>argv.includes('network')&&argv.includes('rm')),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('ready is taken from container logs and the container is stopped at expiry',()=>{
 const exec=trackingDocker();
 let fired;
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,now:()=>1_700_000_000_000,setTimeout:(fn,ms)=>{fired={fn,ms};return {unref(){}};}});
 try{
  assert.equal(exec.calls.some(argv=>argv.includes('logs')),true);
  assert.equal(result.report.ready,'CONTROLLED_REAL_READY');
  assert.equal(fired.ms,1800000);
  const before=exec.calls.length;
  fired.fn();
  assert.ok(exec.calls.length>before&&exec.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')));
 }finally{result.stop();}
});
test('missing ready log cleans up and does not claim the entry is ready',()=>{
 const exec=trackingDocker({logs:'waiting'});
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,logAttempts:1,sleep(){}}),error=>error.message==='PILOT_LAUNCH_NOT_READY'&&!error.message.includes('CONTROLLED_REAL_READY'));
 assert.equal(exec.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')),true);
});
test('no-credential mode keeps network none and leaves the docker executable real',()=>{
 const planned=launcherPlan('linux',['--no-credential','--docker-context','desktop-linux']);
 assert.equal(planned.mode,'no-credential');
 assert.equal(planned.useRecordingDocker,false);
 const exec=trackingDocker();
 const result=runSupervisedPilot({mode:'no-credential',env:clean,execFileSync:exec.execFileSync,dockerContext:'desktop-linux',now:()=>1_700_000_000_000,setTimeout:()=>({unref(){}})});
 try{
  const create=exec.calls.find(argv=>argv.includes('create')&&argv.includes('--name'));
  assert.equal(create.includes('none'),true);
  assert.equal(create.includes('node:22.19.0-alpine'),true);
  assert.equal(create.some(item=>item.includes('while')&&item.includes('CONTROLLED_REAL_READY')),true);
  assert.match(result.report.stopCommand,/docker --context desktop-linux rm -f /);
  assert.equal(exec.calls.some(argv=>argv[1]==='network'),false);
 }finally{result.stop();}
});
test('host loopback publish is opt-in and never binds all interfaces',()=>{
 const exec=trackingDocker();
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,publishWeb:true,setTimeout:()=>({unref(){}})});
 try{
  const create=exec.calls.find(argv=>argv[1]==='create');
  assert.equal(create.includes('127.0.0.1:39130:39130'),true);
  assert.equal(create.some(item=>item.includes('0.0.0.0')),false);
  assert.equal(result.report.web.hostPublished,true);
 }finally{result.stop();}
});
test('SIGINT after create removes the container',()=>{
 const exec=trackingDocker();
 let exitCode;
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,exit:code=>{exitCode=code;},setTimeout:()=>({unref(){}})});
 const added=process.listeners('SIGINT').at(-1);
 const before=exec.calls.filter(argv=>argv.includes('rm')).length;
 added();
 assert.equal(exitCode,130);
 assert.ok(exec.calls.filter(argv=>argv.includes('rm')&&argv.includes('-f')).length>before);
 result.stop();
});
test('entry arguments that assign a secret are refused',()=>{
 const exec=trackingDocker();
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,entryArgs:['DEEPSEEK_API_KEY=not-for-logs']}),error=>error.message==='PILOT_LAUNCH_ENTRY_INVALID'&&!error.message.includes('not-for-logs'));
 assert.equal(exec.calls.length,0);
});
function trackingDocker(options={}){
 const calls=[],files=new Map();let running=false;
 const execFileSync=(command,args)=>{
  if(args.includes('exec')&&!running){const error=Error('container is not running');error.status=1;throw error;}
  calls.push([command,...args]);
  if(options.failStart&&args.includes('start')&&!args.includes('create')){const error=Error('start failed');error.status=1;throw error;}
  if(args.includes('create')&&args.includes('--name'))running=false;
  if(args.includes('start')&&!args.includes('create'))running=true;
  const op=args.find(item=>['cp','sha256sum','stat','ln','rm','logs','create','start','network'].includes(item));
  if(op==='logs')return options.logs??(files.has('/tmp/qiwe-live-pilot.private.json')?'CONTROLLED_REAL_READY\n':'waiting\n');
  if(op==='cp'){const host=args[args.indexOf('--')+1],spec=args.at(-1),dest=spec.slice(spec.indexOf(':')+1);files.set(dest,fs.readFileSync(host));return '';}
  if(op==='sha256sum'||op==='stat'){const target=args.at(-1),data=files.get(target);if(!data){const error=Error('missing');error.status=1;throw error;}if(op==='stat')return `1000 1000 600 1 ${data.length}\n`;return createHash('sha256').update(data).digest('hex')+'  '+target+'\n';}
  if(op==='ln'){const dest=args.at(-1),src=args.at(-2);if(files.has(dest)){const error=Error('File exists');error.status=1;throw error;}files.set(dest,Buffer.from(files.get(src)??''));return '';}
  return '';
 };
 return {calls,execFileSync};
}
