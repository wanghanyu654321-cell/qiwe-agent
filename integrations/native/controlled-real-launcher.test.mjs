import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {execFileSync as realExec} from 'node:child_process';
import {assertRecordedHostBoundary,assertStageSeal,launcherPlan,prepareSealedStage,runSupervisedPilot} from './controlled-real-launcher.mjs';
import {sealControlledLinuxCopy,verifyControlledLinuxCopy} from './linux-runtime.mjs';
import {probeDockerSocket,runBoundedCommand} from './original-shell.mjs';
import {createPilotScratch} from './pilot-private-bootstrap.mjs';
import {windowsEpermCase} from '../../docs/handoff-20261031/verify.mjs';

const launcher=fileURLToPath(new URL('./controlled-real-launcher.mjs',import.meta.url));
const clean={PATH:process.env.PATH??''};
function callsOf(exec){return exec.calls;}
test('synthetic launcher creates the container, installs a fake private file, then starts, with no network',()=>{
 const exec=trackingDocker();
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,now:()=>1_700_000_000_000});
 try{
  const sub=exec.calls.map(argv=>argv[1]);
  const created=sub.indexOf('create'),started=sub.indexOf('start'),copied=exec.calls.findIndex(argv=>argv.some(item=>String(item).includes('cat >'))),execed=exec.calls.findIndex(argv=>argv.includes('exec'));
  assert.ok(created!==-1&&created<started&&started<execed&&execed<=copied);
  const nonce=exec.calls.find(argv=>argv.includes('exec')&&argv.some(item=>/^[a-f0-9]{32}$/.test(item))).find(item=>/^[a-f0-9]{32}$/.test(item));
  assert.equal(exec.calls.find(argv=>argv.includes('create')).some(item=>String(item).startsWith('QIWE_PILOT_READY_NONCE=')),false);
  assert.match(nonce,/^[a-f0-9]{32}$/);
  const flagWrite=exec.calls.find(argv=>argv.includes('exec')&&argv.some(item=>item.includes('/tmp/qiwe-ready/flag')));
  assert.equal(flagWrite.includes('0:0'),true);
  assert.equal(flagWrite.includes(nonce),true);
  assert.equal(flagWrite.filter(item=>String(item).includes('printf')).some(item=>item.includes(nonce)),false);
  assert.equal(result.report.ready,`CONTROLLED_REAL_READY ${nonce}`);
  const create=exec.calls.find(argv=>argv[1]==='create');
  assert.equal(create.includes('--network')&&create.includes('none'),true);
  assert.equal(create.includes('-p')||create.includes('--publish'),false);
  assert.equal(create.includes('run'),false);
  assert.equal(create.includes('QIWE_CONTROLLED_REAL_PILOT=1'),true);
  assert.equal(create.includes('QIWE_PILOT_MODEL_REQUESTS=8'),true);
  assert.equal(create.includes('QIWE_PILOT_MODEL_OUTPUT_TOKENS=1024'),true);
  assert.equal(create.some(item=>item.startsWith('ANTHROPIC_API_KEY=')||item.startsWith('DEEPSEEK_')),false);
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
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:{...clean,DEEPSEEK_API_KEY:'not-for-logs',GIT_CONFIG_KEY_0:'credential.helper'},execFileSync:exec.execFileSync}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&error.envNames.includes('DEEPSEEK_API_KEY')&&!error.envNames.includes('GIT_CONFIG_KEY_0')&&!error.message.includes('not-for-logs'));
 assert.equal(exec.calls.length,0);
 const child=spawnSync(process.execPath,[launcher,'--no-credential'],{encoding:'utf8',env:{...clean,DEEPSEEK_API_KEY:'not-for-logs',STITCH_API_KEY:'stitch-secret',GIT_CONFIG_KEY_0:'credential.helper'},timeout:20000});
 assert.equal(child.status,1);
 assert.match(child.stderr,/ISOLATED_SYNTHETIC_REAL_CREDENTIAL/);
 assert.match(child.stderr,/DEEPSEEK_API_KEY/);
 assert.match(child.stderr,/STITCH_API_KEY/);
 assert.equal(child.stderr.includes('not-for-logs')||child.stderr.includes('stitch-secret')||child.stderr.includes('GIT_CONFIG_KEY_0'),false);
});
const winSocket=process.platform==='win32'&&'unix socket listen EACCES in Temp';
test('real launcher opens a private bridge, installs the file, then starts, and refuses a raised cap',{skip:winSocket},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-real-'));
 const controls=await hostControls(root);
 const privateFile=path.join(root,'host-private.json');
 fs.writeFileSync(privateFile,JSON.stringify({bot:{botId:'bot-id-example',corpId:'corp-id-example',secret:'host-file-secret-value'},model:{apiKey:'host-file-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}),{mode:0o600});
 const exec=trackingDocker();
 const win=process.platform==='win32'?{platform:'win32',homedir:root,realpath:()=>privateFile,currentSid:'S-1-5-21-1-2-3-1001',reparsePoint:false,aces:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',inherited:false}]}:{};
 try{
  assert.throws(()=>runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,requests:9,execFileSync:exec.execFileSync,cwd:root,...controls}),/PILOT_LAUNCH_BUDGET_CAP/);
  const result=runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:exec.execFileSync,now:()=>1_700_000_000_000,dockerContext:'desktop-linux',entryArgs:['verify-full-host.mjs','--controlled-real-pilot','--full-host-conversations'],cwd:root,...controls,...win});
  const sub=exec.calls.map(argv=>argv.find((item,index)=>index>0&&!item.startsWith('--')&&item!=='desktop-linux'));
  const network=sub.indexOf('network'),created=sub.indexOf('create'),started=sub.indexOf('start'),copied=exec.calls.findIndex(argv=>argv.some(item=>String(item).includes('cat >')));
  assert.ok(network!==-1&&network<created&&created<started&&started<copied);
  const create=exec.calls.find(argv=>argv.includes('create')&&argv.includes('--name'));
  assert.equal(create.some(item=>item.includes('exec node /input/qiwe-agent/integrations/native/verify-full-host.mjs /input/.local/full-instance/stage/app/src --host-overlay /input/.local/core-fix/appointment-identity-candidate/src --skill-root /input/.local/d4-skills')),true);
  assert.equal(create.some(item=>item.includes('--frontagent-existing-state /input/.local/frontagent-existing-input')),true);
  assert.equal(create.includes('--group-add')&&create[create.indexOf('--group-add')+1]==='0',true);
  assert.equal(create.includes('--pids-limit')&&create.includes('256')&&create.includes('--memory')&&create.includes('4g')&&create.includes('--cpus')&&create.includes('2'),true);
  assert.equal(create.includes('HOME=/tmp')&&create.includes('TMPDIR=/tmp')&&create.includes('QIWE_EVIDENCE_ROOT=/tmp/qiwe-evidence'),true);
  assert.equal(assertRecordedHostBoundary(create),true);
  assert.equal(create.some(item=>item.startsWith('QIWE_RESTORATION_RECEIPT=')),false);
  assert.equal(create.some(item=>item.startsWith('QIWE_LOCAL_DOCKER_DRIVER_IMAGE=sha256:092853e7')),true);
  assert.equal(create.some(item=>item.startsWith('QIWE_LOCAL_DOCKER_IMAGE=sha256:')),true);
  assert.equal(create.some(item=>item.startsWith('QIWE_LOCAL_DOCKER_VOLUME=qiwe-tmp-')),true);
  assert.equal(create.some(item=>item.startsWith('QIWE_LOCAL_DOCKER_HOST=qiwe-pilot-host-')),true);
  assert.equal(exec.calls.some(argv=>argv.includes('volume')&&argv.includes('create')),true);
  assert.equal(create.includes('-p')||create.includes('--publish'),false);
  assert.equal(create.some(item=>item.includes('127.0.0.1')),true);
  assert.match(result.report.network,/^qiwe-pilot-/);
  assert.match(result.report.stopCommand,/docker --context desktop-linux rm -f qiwe-pilot-host-.+ && docker --context desktop-linux network rm qiwe-pilot-/);
  assert.equal(result.report.stopCommand.includes('host-file-secret-value'),false);
  result.stop();
  assert.equal(exec.calls.some(argv=>argv.includes('network')&&argv.includes('rm')),true);
 }finally{controls.server.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('a symlink stage and a failed volume remove stay outside the boundary',{skip:winSocket},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-link-'));
 const controls=await hostControls(root);
 const linked=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-link-cwd-'));
 const privateFile=path.join(root,'host-private.json');
 fs.writeFileSync(privateFile,'{"bot":{"botId":"bot-id-example","corpId":"corp-id-example","secret":"host-file-secret-value"},"model":{"apiKey":"host-file-model-key","baseUrl":"https://api.deepseek.com/anthropic","model":"deepseek-flash"}}',{mode:0o600});
 try{
  fs.mkdirSync(path.join(linked,'.local'));
  if(process.platform!=='win32'){
   fs.symlinkSync(path.join(root,'.local','frontagent-r3-20261029'),path.join(linked,'.local','frontagent-r3-20261029'));
   assert.throws(()=>runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:trackingDocker().execFileSync,cwd:linked,dockerBin:controls.dockerBin,dockerSocket:controls.dockerSocket}),/PILOT_LAUNCH_STAGE_UNSAFE/);
  }
  const win=process.platform==='win32'?{platform:'win32',homedir:root,realpath:()=>privateFile,currentSid:'S-1-5-21-1-2-3-1001',reparsePoint:false,aces:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',inherited:false}]}:{};
  const exec=trackingDocker({failVolume:true});
  const result=runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:exec.execFileSync,cwd:root,dockerBin:controls.dockerBin,dockerSocket:controls.dockerSocket,setTimeout:()=>({unref(){}}),...win});
  assert.throws(()=>result.stop(),error=>error.message==='PILOT_LAUNCH_CLEANUP_FAILED'&&error.stopCommand.includes('volume rm'));
  assert.equal(exec.calls.filter(argv=>argv.includes('volume')&&argv.includes('rm')).length,3);
 }finally{controls.server.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(linked,{recursive:true,force:true});}
});
test('no-credential path reaches a ready line on a local docker daemon',{skip:!dockerDaemon()&&'docker daemon not available'},()=>{
 const result=runSupervisedPilot({mode:'no-credential',env:clean,durationMs:60000,setTimeout:()=>({unref(){}})});
 try{assert.match(result.report.ready,/^CONTROLLED_REAL_READY [a-f0-9]{32}$/);assert.equal(result.report.network,'none');}
 finally{result.stop();}
});
test('synthetic cli prints the ready line, run id, expiry, and stop command',()=>{
 const child=spawnSync(process.execPath,[launcher,'--synthetic'],{encoding:'utf8',env:clean,timeout:20000});
 assert.equal(child.status,0,child.stderr);
 assert.match(child.stdout,/CONTROLLED_REAL_READY/);
 assert.equal(child.stdout.includes('synthetic-bot-secret'),false);
 const report=JSON.parse(child.stdout.trim().split('\n').filter(line=>line.startsWith('{')).at(-1));
 assert.match(report.ready,/^CONTROLLED_REAL_READY [a-f0-9]{32}$/);
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
 const spec='✖ fsync parent (1.2ms)\n  Error: EPERM: operation not permitted, fsync\n✖ symlink (0.4ms)\n  Error: EPERM: operation not permitted, symlink \'D:\\\\tmp\'\n';
 const tap='TAP version 13\nnot ok 1 - fsync parent\n  ---\n  failureType: \'testCodeFailure\'\n  error: \'EPERM: operation not permitted, fsync\'\n  code: \'EPERM\'\n  ...\nnot ok 2 - symlink\n  ---\n  failureType: \'testCodeFailure\'\n  error: |-\n    EPERM: operation not permitted, symlink \'D:\\\\tmp\'\n  code: \'EPERM\'\n  ...\n';
 assert.equal(windowsEpermCase(spec),true);
 assert.equal(windowsEpermCase(tap),true);
 assert.equal(windowsEpermCase('not ok 1 - scope\n  error: CONTROLLED_REAL_TRANSPORT_SCOPE\n'),false);
 assert.equal(windowsEpermCase('not ok 1 - fsync\n  error: EPERM: operation not permitted, fsync\n  code: CONTROLLED_REAL_TRANSPORT_SCOPE\n'),false);
 const listed='✖ fsync parent (1.2ms)\n✖ failing tests:\n\n✖ fsync parent (1.2ms)\n  Error: EPERM: operation not permitted, fsync\n';
 assert.equal(windowsEpermCase(listed),true);
 assert.equal(windowsEpermCase('✖ fsync parent (1.2ms)\n  AssertionError: expected\n  Error: EPERM: operation not permitted, fsync\n'),false);
 const plan=launcherPlan('win32');
 assert.equal(plan.incremental,'per-file');
 assert.equal(launcherPlan('linux').incremental,'suite');
});
test('a failed start removes the container and the bridge',{skip:winSocket},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-fail-'));
 const controls=await hostControls(root);
 const privateFile=path.join(root,'host-private.json');
 fs.writeFileSync(privateFile,JSON.stringify({bot:{botId:'bot-id-example',corpId:'corp-id-example',secret:'host-file-secret-value'},model:{apiKey:'host-file-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}),{mode:0o600});
 const exec=trackingDocker({failStart:true});
 const win=process.platform==='win32'?{platform:'win32',homedir:root,realpath:()=>privateFile,currentSid:'S-1-5-21-1-2-3-1001',reparsePoint:false,aces:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',inherited:false}]}:{};
 try{
  assert.throws(()=>runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:exec.execFileSync,dockerContext:'desktop-linux',cwd:root,dockerBin:controls.dockerBin,dockerSocket:controls.dockerSocket,...win}),error=>error.message==='PILOT_LAUNCH_FAILED'&&error.causeName==='Error'&&error.causeMessage==='start failed');
  assert.equal(exec.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')),true);
  assert.equal(exec.calls.some(argv=>argv.includes('network')&&argv.includes('rm')),true);
 }finally{controls.server.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('ready is taken from container logs and the container is stopped at expiry',()=>{
 const exec=trackingDocker();
 let fired;
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,now:()=>1_700_000_000_000,setTimeout:(fn,ms)=>{fired={fn,ms};return {unref(){}};}});
 try{
  assert.equal(exec.calls.some(argv=>argv.includes('logs')),true);
  assert.match(result.report.ready,/^CONTROLLED_REAL_READY [a-f0-9]{32}$/);
  const deadline=Number(exec.calls.find(argv=>argv.includes('create')).find(item=>item.startsWith('QIWE_PILOT_EXPIRES_AT=')).split('=')[1]);
  assert.equal(fired.ms,deadline-1_700_000_000_000);
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
test('a ready flag that already exists refuses the launch before install',()=>{
 const exec=trackingDocker({readyFlagExists:true});
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,setTimeout:()=>({unref(){}})}),/PILOT_LAUNCH_READY_FLAG_EXISTS/);
 assert.equal(exec.calls.some(argv=>argv.includes('cp')),false);
 assert.equal(exec.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')&&!argv.includes('exec')),true);
});
test('an untagged or repeated ready line is not accepted',()=>{
 const bare=trackingDocker({logs:'CONTROLLED_REAL_READY\n'});
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:bare.execFileSync,logAttempts:1,sleep(){},setTimeout:()=>({unref(){}})}),error=>error.message==='PILOT_LAUNCH_NOT_READY');
 const twice=trackingDocker({logs:'duplicate'});
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:twice.execFileSync,logAttempts:1,sleep(){},setTimeout:()=>({unref(){}})}),/PILOT_LAUNCH_NOT_READY/);
});
test('a failed container remove is retried and reported with the cleanup command',()=>{
 const exec=trackingDocker({failRm:true});
 const result=runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,setTimeout:()=>({unref(){}})});
 assert.throws(()=>result.stop(),error=>error.message==='PILOT_LAUNCH_CLEANUP_FAILED'&&error.stopCommand.startsWith('docker rm -f ')&&!error.stopCommand.includes('synthetic-bot-secret'));
 assert.equal(exec.calls.filter(argv=>argv[1]==='rm'&&argv.includes('-f')).length,3);
});
test('windows no-credential scratch is created inside the profile and granted by SID',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-profile-'));
 const profile=path.join(home,'why的私密花园');fs.mkdirSync(profile);
 const exec=trackingDocker(),acl=[];
 const sid='S-1-5-21-9-8-7-1001';
 try{
  const scratch=createPilotScratch({platform:'win32',homedir:profile});
  assert.ok(scratch.startsWith(profile+path.sep));
  const result=runSupervisedPilot({mode:'no-credential',env:clean,execFileSync:exec.execFileSync,platform:'win32',homedir:profile,currentSid:sid,aces:[{sid,type:'Allow',inherited:false}],reparsePoint:false,aclExec:(command,args)=>{acl.push([command,...args]);},setTimeout:()=>({unref(){}})});
  assert.ok(result.privateFile.startsWith(profile+path.sep));
  const grant=acl.find(argv=>argv[0]==='icacls'&&argv[1]===result.privateFile);
  assert.equal(grant.at(-1),`*${sid}:(R)`);
  assert.equal(grant.includes('/inheritance:r')&&grant.includes('/grant:r'),true);
  result.stop();
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('no-credential wait returns when the container has exited',()=>{
 const exec=trackingDocker();
 const result=runSupervisedPilot({mode:'no-credential',env:clean,execFileSync:exec.execFileSync,setTimeout:()=>({unref(){}})});
 assert.equal(result.wait(),'exited');
 assert.equal(exec.calls.some(argv=>argv[1]==='rm'&&argv.includes('-f')),true);
});
test('entry arguments that assign a secret are refused',()=>{
 const exec=trackingDocker();
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,entryArgs:['DEEPSEEK_API_KEY=not-for-logs']}),error=>error.message==='PILOT_LAUNCH_ENTRY_INVALID'&&!error.message.includes('not-for-logs'));
 assert.equal(exec.calls.length,0);
});
test('rehearsal resolves host controls and succeeds only after the receipt and evidence',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-rehearsal-'));
 const stage=path.join(root,'.local','frontagent-r3-20261029');
 fs.mkdirSync(path.join(stage,'input'),{recursive:true});
 fs.writeFileSync(path.join(stage,'input','.qiwe-linux-stage.json'),JSON.stringify({format:'qiwe-linux-controlled-copy-v1',files:{}},null,2)+'\n');
 fs.writeFileSync(path.join(stage,'docker'),'');
 fs.writeFileSync(path.join(stage,'build-input-linux.json'),'{}');
 const win=process.platform==='win32'?{platform:'win32',homedir:root,currentSid:'S-1-5-21-1-2-3-1001',reparsePoint:false,aces:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',inherited:false}],aclExec(){}}: {};
 const image='sha256:'+'ab'.repeat(32);
 try{
  const missingControls=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-empty-'));
  fs.mkdirSync(path.join(missingControls,'.local','frontagent-r3-20261029','input'),{recursive:true});
  try{assert.throws(()=>runSupervisedPilot({mode:'rehearsal',image,env:clean,execFileSync:trackingDocker().execFileSync,cwd:missingControls,dockerContext:'desktop-linux',setTimeout:()=>({unref(){}}),...win}),error=>error.message==='PILOT_LAUNCH_SOURCE_MISSING'&&error.reason==='docker'&&error.paths.some(file=>file.endsWith(path.join('docker'))));}
  finally{fs.rmSync(missingControls,{recursive:true,force:true});}
  const early=trackingDocker();
  assert.throws(()=>runSupervisedPilot({mode:'rehearsal',image,env:clean,execFileSync:early.execFileSync,cwd:root,dockerContext:'desktop-linux',logAttempts:1,sleep(){},setTimeout:()=>({unref(){}}),...win}),error=>error.message==='PILOT_LAUNCH_NOT_READY');
  const dead=trackingDocker({exitedDuringReady:true,exitCode:'9'});
  assert.throws(()=>runSupervisedPilot({mode:'rehearsal',image,env:clean,execFileSync:dead.execFileSync,cwd:root,dockerContext:'desktop-linux',logAttempts:2,sleep(){},setTimeout:()=>({unref(){}}),...win}),error=>error.message==='PILOT_LAUNCH_HOST_EXITED'&&error.exitCode===9);
  assert.equal(dead.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')),true);
  const stageMiss=trackingDocker({exitedDuringReady:true,exitCode:'3',logs:'PILOT_LAUNCH_STAGE_INPUT_MISSING existing-input\nminiclaw_session=synthetic-private-session\n'});
  assert.throws(()=>runSupervisedPilot({mode:'rehearsal',image,env:clean,execFileSync:stageMiss.execFileSync,cwd:root,dockerContext:'desktop-linux',logAttempts:2,sleep(){},setTimeout:()=>({unref(){}}),...win}),error=>error.message==='PILOT_LAUNCH_HOST_EXITED'&&error.exitCode===3&&error.logTail.includes('PILOT_LAUNCH_STAGE_INPUT_MISSING')&&!error.logTail.includes('synthetic-private-session'));
  const missing=trackingDocker({logs:'receipt',evidence:false});
  assert.throws(()=>runSupervisedPilot({mode:'rehearsal',image,env:clean,execFileSync:missing.execFileSync,cwd:root,dockerContext:'desktop-linux',logAttempts:1,sleep(){},setTimeout:()=>({unref(){}}),...win}),/PILOT_LAUNCH_NOT_READY/);
  const exec=trackingDocker({logs:'receipt'});
  const result=runSupervisedPilot({mode:'rehearsal',image,env:clean,execFileSync:exec.execFileSync,cwd:root,dockerContext:'desktop-linux',now:()=>1_700_000_000_000,setTimeout:()=>({unref(){}}),...win});
  const create=exec.calls.find(argv=>argv.includes('create')&&argv.includes('--name'));
  assert.equal(assertRecordedHostBoundary(create),true);
  assert.equal(create.some(item=>String(item).endsWith('/qiwe-control/docker:ro')),true);
  assert.equal(create.some(item=>String(item).endsWith('/qiwe-control/build-input.json:ro')),true);
  assert.equal(exec.calls.some(argv=>argv.some(item=>String(item).includes('full-host-audit.json'))),true);
  assert.equal(result.report.receipt,'supervisor-receipt-created');
  assert.equal(result.report.evidenceRoot,'/tmp/qiwe-evidence');
  assert.match(result.report.ready,/FULL_HOST_PHASE .*"phase":"controlled-real"/);
  result.stop();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a host that has already exited fails the ready loop',()=>{
 const exec=trackingDocker({exitedDuringReady:true});
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,logAttempts:3,sleep(){},setTimeout:()=>({unref(){}})}),error=>error.message==='PILOT_LAUNCH_HOST_EXITED'&&Number.isInteger(error.exitCode));
 assert.equal(exec.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')),true);
 assert.equal(exec.calls.filter(argv=>argv.includes('logs')).length<=2,true);
});
test('prepare-stage builds frontagent-existing-input from the product host and checks every hash',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-existing-build-'));
 const stage=path.join(root,'.local','frontagent-r3-20261029');
 const input=path.join(stage,'input');
 fs.mkdirSync(path.join(input,'.local','full-instance','stage','app','src'),{recursive:true});
 fs.mkdirSync(path.join(input,'.local','core-fix','appointment-identity-candidate','src'),{recursive:true});
 fs.mkdirSync(path.join(input,'.local','d4-skills'),{recursive:true});
 fs.writeFileSync(path.join(stage,'docker'),'linux-docker');
 fs.writeFileSync(path.join(stage,'build-input-linux.json'),'{}\n');
 const product=path.join(root,'.local','frontagent-product-host-r1-final');
 fs.mkdirSync(path.join(product,'state','runtime'),{recursive:true});
 fs.mkdirSync(path.join(product,'code'),{recursive:true});
 const db=Buffer.from('sqlite-bytes');
 fs.writeFileSync(path.join(product,'state','runtime','messages.db'),db,{mode:0o600});
 fs.writeFileSync(path.join(product,'code','product-web.mjs'),'web-bytes');
 const typeWeb='export declare const routes: boolean;\n',typeModules='export declare const modules: boolean;\n';
 const sha=value=>createHash('sha256').update(value).digest('hex');
 const cookie='miniclaw_session=synthetic-private-session';
 const descriptor={format:'frontagent-existing-state-v1',accountId:'existing-member',homeJid:'web:existing-member-0',role:'marketing',profileId:'p',workspaceJid:'web:existing-member-1',folder:'folder',tenantId:'t',storeId:'s',instanceId:'i',employee:{employeeId:'e',employeeName:'Existing'},adminCookie:cookie,expectedCounts:{users:2,profiles:16,groups:16},files:[{path:'state/runtime/messages.db',sha256:sha(db)},{path:'code/product-web.mjs',sha256:sha('web-bytes')},{path:'code/product-web.d.mts',sha256:sha(typeWeb)},{path:'code/product-modules.d.mts',sha256:sha(typeModules)}]};
 fs.writeFileSync(path.join(stage,'bootstrap-input.private.json'),JSON.stringify({descriptor,typeFiles:{'product-web.d.mts':typeWeb,'product-modules.d.mts':typeModules}}));
 try{
  const prepared=prepareSealedStage(root);
  assert.deepEqual(fs.readdirSync(prepared.existing).sort(),['code','descriptor.json','state']);
  if(process.platform!=='win32'){
   assert.equal((fs.statSync(path.join(prepared.existing,'descriptor.json')).mode&0o777),0o600);
   assert.equal((fs.statSync(path.join(prepared.existing,'state','runtime','messages.db')).mode&0o777),0o644);
  }
  assert.equal(sha(fs.readFileSync(path.join(prepared.existing,'state','runtime','messages.db'))),sha(db));
  assert.equal(fs.readFileSync(path.join(prepared.existing,'code','product-web.d.mts'),'utf8'),typeWeb);
  const written=JSON.parse(fs.readFileSync(path.join(prepared.existing,'descriptor.json'),'utf8'));
  assert.equal(written.adminCookie,cookie);
  assert.equal(JSON.stringify(prepared).includes(cookie),false);
  descriptor.files[0].sha256='0'.repeat(64);
  fs.writeFileSync(path.join(stage,'bootstrap-input.private.json'),JSON.stringify({descriptor,typeFiles:{'product-web.d.mts':typeWeb,'product-modules.d.mts':typeModules}}));
  assert.throws(()=>prepareSealedStage(root),error=>error.message==='PILOT_LAUNCH_STAGE_INPUT_MISSING'&&error.reason==='existing-input'&&!String(error).includes(cookie)&&!JSON.stringify(error.paths??[]).includes(cookie));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(prepared.existing,'state','runtime','messages.db'))).digest('hex'),sha(db));
  assert.equal(fs.readdirSync(path.dirname(prepared.existing)).some(name=>name.includes('.tmp')||name.includes('.old')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('prepare-stage copies docker and build-input from the local runner source',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-prepare-stage-'));
 const stage=path.join(root,'.local','frontagent-r3-20261029');
 const input=path.join(stage,'input');
 fs.mkdirSync(path.join(input,'.local','full-instance','stage','app','src'),{recursive:true});
 fs.mkdirSync(path.join(input,'.local','core-fix','appointment-identity-candidate','src'),{recursive:true});
 fs.mkdirSync(path.join(input,'.local','d4-skills'),{recursive:true});
 const source=path.join(root,'.local','t7-runner-shell-20261024');
 fs.mkdirSync(source,{recursive:true});
 fs.writeFileSync(path.join(source,'docker'),'linux-docker');
 fs.writeFileSync(path.join(source,'build-input-linux.json'),'{"files":{}}\n');
 const existing=path.join(stage,'frontagent-existing-input');
 fs.mkdirSync(path.join(existing,'code'),{recursive:true});
 fs.mkdirSync(path.join(existing,'state'),{recursive:true});
 fs.writeFileSync(path.join(existing,'descriptor.json'),'{"format":"frontagent-existing-state-v1"}\n');
 fs.mkdirSync(path.join(root,'src/node_modules/left'),{recursive:true});
 fs.writeFileSync(path.join(root,'src/sample.ts'),'export const sample=1;\n');
 fs.writeFileSync(path.join(root,'src/node_modules/left/index.js'),'nope');
 fs.mkdirSync(path.join(input,'qiwe-agent/node_modules'),{recursive:true});
 fs.writeFileSync(path.join(input,'qiwe-agent/node_modules/linux.js'),'keep');
 try{
  const prepared=prepareSealedStage(root);
  assert.equal(fs.readFileSync(prepared.docker,'utf8'),'linux-docker');
  assert.equal(fs.readFileSync(prepared.buildInput,'utf8'),'{"files":{}}\n');
  assert.equal(fs.existsSync(path.join(prepared.existing,'descriptor.json')),true);
  assert.equal(fs.readFileSync(path.join(input,'qiwe-agent/src/sample.ts'),'utf8'),'export const sample=1;\n');
  assert.equal(fs.existsSync(path.join(input,'qiwe-agent/src/node_modules')),false);
  assert.equal(fs.readFileSync(path.join(input,'qiwe-agent/node_modules/linux.js'),'utf8'),'keep');
  assert.equal(verifyControlledLinuxCopy(input).files>=1,true);
  fs.writeFileSync(prepared.docker,'keep');
  prepareSealedStage(root);
  assert.equal(fs.readFileSync(prepared.docker,'utf8'),'keep');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
 const bare=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-prepare-missing-'));
 fs.mkdirSync(path.join(bare,'.local','frontagent-r3-20261029','input'),{recursive:true});
 try{assert.throws(()=>prepareSealedStage(bare),error=>error.message==='PILOT_LAUNCH_SOURCE_MISSING'&&error.reason==='docker'&&error.paths.length>1&&error.paths.every(file=>!file.includes('miniclaw_session'))&&!String(error.causeMessage??'').includes('secret'));}
 finally{fs.rmSync(bare,{recursive:true,force:true});}
});
test('prepare-stage reads a worktree from the main checkout and does not copy the private file',()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-worktree-'));
 const main=path.join(parent,'main'),wt=path.join(parent,'wt');
 fs.mkdirSync(main);
 const git=(args,cwd)=>realExec('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'qiwe',GIT_AUTHOR_EMAIL:'qiwe@example.com',GIT_COMMITTER_NAME:'qiwe',GIT_COMMITTER_EMAIL:'qiwe@example.com'}});
 git(['init'],main);
 fs.writeFileSync(path.join(main,'README'),'main\n');
 git(['add','README'],main);
 git(['commit','-m','init'],main);
 fs.mkdirSync(path.join(main,'src'),{recursive:true});
 fs.writeFileSync(path.join(main,'src/from-head.ts'),'export const head=1;\n');
 git(['worktree','add','--detach',wt],main);
 const runner=path.join(main,'.local','t7-runner-shell-20261024');
 fs.mkdirSync(runner,{recursive:true});
 fs.writeFileSync(path.join(runner,'docker'),'from-main-docker');
 fs.writeFileSync(path.join(runner,'build-input-linux.json'),'{"from":"main"}\n');
 const product=path.join(main,'.local','frontagent-product-host-r1-final');
 fs.mkdirSync(path.join(product,'state'),{recursive:true});
 fs.mkdirSync(path.join(product,'code'),{recursive:true});
 fs.writeFileSync(path.join(product,'state','note.txt'),'state-bytes');
 fs.writeFileSync(path.join(product,'code','product-web.mjs'),'web-bytes');
 const typeWeb='export declare const routes: boolean;\n',typeModules='export declare const modules: boolean;\n';
 const sha=value=>createHash('sha256').update(value).digest('hex');
 const cookie='miniclaw_session=synthetic-private-session';
 const descriptor={format:'frontagent-existing-state-v1',accountId:'existing-member',homeJid:'web:existing-member-0',role:'marketing',profileId:'p',workspaceJid:'web:existing-member-1',folder:'folder',tenantId:'t',storeId:'s',instanceId:'i',employee:{employeeId:'e',employeeName:'Existing'},adminCookie:cookie,expectedCounts:{users:2,profiles:16,groups:16},files:[{path:'state/note.txt',sha256:sha('state-bytes')},{path:'code/product-web.mjs',sha256:sha('web-bytes')},{path:'code/product-web.d.mts',sha256:sha(typeWeb)},{path:'code/product-modules.d.mts',sha256:sha(typeModules)}]};
 fs.mkdirSync(path.join(main,'.local','frontagent-r3-20261029'),{recursive:true});
 fs.writeFileSync(path.join(main,'.local','frontagent-r3-20261029','bootstrap-input.private.json'),JSON.stringify({descriptor,typeFiles:{'product-web.d.mts':typeWeb,'product-modules.d.mts':typeModules}}));
 const input=path.join(wt,'.local','frontagent-r3-20261029','input');
 fs.mkdirSync(path.join(input,'.local','full-instance','stage','app','src'),{recursive:true});
 fs.mkdirSync(path.join(input,'.local','core-fix','appointment-identity-candidate','src'),{recursive:true});
 fs.mkdirSync(path.join(input,'.local','d4-skills'),{recursive:true});
 try{
  const prepared=prepareSealedStage(wt,{env:{}});
  assert.equal(prepared.commit,git(['rev-parse','HEAD'],main).trim());
  assert.equal(JSON.parse(fs.readFileSync(path.join(input,'.qiwe-linux-stage.json'),'utf8')).commit,prepared.commit);
  assert.equal(fs.readFileSync(path.join(input,'qiwe-agent/src/from-head.ts'),'utf8'),'export const head=1;\n');
  assert.equal(fs.readFileSync(prepared.docker,'utf8'),'from-main-docker');
  assert.equal(fs.readFileSync(prepared.buildInput,'utf8'),'{"from":"main"}\n');
  assert.equal(fs.existsSync(path.join(wt,'.local','frontagent-r3-20261029','bootstrap-input.private.json')),false);
  assert.equal(fs.readFileSync(path.join(prepared.existing,'code','product-web.d.mts'),'utf8'),typeWeb);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.existing,'descriptor.json'),'utf8')).adminCookie,cookie);
  fs.rmSync(prepared.docker);fs.rmSync(prepared.buildInput);
  const wrong=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-source-root-'));
  try{assert.throws(()=>prepareSealedStage(wt,{sourceRoot:wrong,env:{QIWE_PILOT_SOURCE_ROOT:main}}),error=>error.message==='PILOT_LAUNCH_SOURCE_MISSING'&&error.reason==='docker'&&error.paths.some(file=>file.startsWith(wrong))&&!error.paths.some(file=>file.startsWith(main))&&!JSON.stringify(error.paths).includes(cookie));}
  finally{fs.rmSync(wrong,{recursive:true,force:true});}
 }finally{git(['worktree','remove','--force',wt],main);fs.rmSync(parent,{recursive:true,force:true});}
});
test('a quiet host is reported as stalled with the last log lines',()=>{
 let clock=0;
 const exec=trackingDocker({logs:'FULL_HOST_RUN {"status":"preparing"}\nsecret=should-not-appear\n'});
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync:exec.execFileSync,stallMs:120000,logAttempts:6,now:()=>clock,sleep(){clock+=60000;},setTimeout:()=>({unref(){}})}),error=>error.message==='PILOT_LAUNCH_HOST_STALLED'&&error.logTail.includes('FULL_HOST_RUN')&&error.logTail.includes('[redacted]')&&!error.logTail.includes('should-not-appear'));
 assert.equal(exec.calls.some(argv=>argv.includes('rm')&&argv.includes('-f')),true);
});
test('docker preflight does not wait on a client or proxy that never answers',async()=>{
 const started=Date.now();
 const hung=await runBoundedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:400,step:'docker-preflight'});
 assert.equal(hung.timedOut,true);
 assert.equal(hung.step,'docker-preflight');
 assert.ok(Date.now()-started<3000);
 if(process.platform==='win32')return;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-docker-sock-'));
 const sock=path.join(dir,'docker.sock');
 const silent=net.createServer(socket=>{socket.on('error',()=>{});});
 const ready=net.createServer(socket=>{socket.end('HTTP/1.1 200 OK\r\nContent-Length: 21\r\nConnection: close\r\n\r\n{"ApiVersion":"1.41"}');});
 const readySock=path.join(dir,'ready.sock');
 try{
  await new Promise((resolve,reject)=>{silent.once('error',reject);silent.listen(sock,resolve);});
  const quiet=Date.now();
  await assert.rejects(probeDockerSocket(sock,400),error=>error.message==='FULL_HOST_STEP_TIMEOUT'&&error.step==='docker-socket');
  assert.ok(Date.now()-quiet<3000);
  await new Promise((resolve,reject)=>{ready.once('error',reject);ready.listen(readySock,resolve);});
  assert.equal((await probeDockerSocket(readySock,2000)).ApiVersion,'1.41');
 }finally{silent.close();ready.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('launcher refuses a stage whose seal does not match the files or the commit',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-stage-seal-'));
 const stage=path.join(root,'.local','frontagent-r3-20261029');
 const input=path.join(stage,'input');
 fs.mkdirSync(path.join(input,'qiwe-agent','src'),{recursive:true});
 fs.writeFileSync(path.join(input,'qiwe-agent','src','sample.ts'),'export const value=1;\n');
 fs.writeFileSync(path.join(stage,'docker'),'');
 fs.writeFileSync(path.join(stage,'build-input-linux.json'),'{}');
 const win=process.platform==='win32'?{platform:'win32',homedir:root,currentSid:'S-1-5-21-1-2-3-1001',reparsePoint:false,aces:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',inherited:false}],aclExec(){}}: {};
 try{
  sealControlledLinuxCopy(input,'a'.repeat(40));
  assertStageSeal(input,'a'.repeat(40));
  assert.throws(()=>assertStageSeal(input,'b'.repeat(40)),error=>error.message==='PILOT_LAUNCH_STAGE_SEAL'&&error.reason==='commit');
  fs.writeFileSync(path.join(input,'qiwe-agent','src','sample.ts'),'export const value=2;\n');
  assert.throws(()=>assertStageSeal(input,'a'.repeat(40)),error=>error.message==='PILOT_LAUNCH_STAGE_SEAL'&&error.reason==='contents');
  const exec=trackingDocker();
  assert.throws(()=>runSupervisedPilot({mode:'rehearsal',image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:exec.execFileSync,cwd:root,dockerContext:'desktop-linux',sourceRoot:root,setTimeout:()=>({unref(){}}),...win}),error=>error.message==='PILOT_LAUNCH_STAGE_SEAL'&&error.reason==='contents');
  assert.equal(exec.calls.length,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an uncoded launch error prints its name and message without secrets',()=>{
 const execFileSync=(command,args)=>{if(args.includes('create'))throw Error('listen EACCES token=supersecretvalue');return '';};
 assert.throws(()=>runSupervisedPilot({mode:'synthetic',env:clean,execFileSync,setTimeout:()=>({unref(){}})}),error=>error.message==='PILOT_LAUNCH_FAILED'&&error.causeName==='Error'&&error.causeMessage==='listen EACCES [redacted]'&&!error.causeMessage.includes('supersecretvalue')&&!error.causeMessage.includes('powershell.exe'));
});
function dockerDaemon(){try{realExec('docker',['info'],{stdio:'ignore',timeout:8000});return true;}catch{return false;}}
async function hostControls(root){
 const stage=path.join(root,'.local','frontagent-r3-20261029');
 fs.mkdirSync(path.join(stage,'input'),{recursive:true});
 fs.writeFileSync(path.join(stage,'input','.qiwe-linux-stage.json'),JSON.stringify({format:'qiwe-linux-controlled-copy-v1',files:{}},null,2)+'\n');
 fs.writeFileSync(path.join(stage,'build-input-linux.json'),'{}');
 const dockerBin=path.join(stage,'docker');
 fs.writeFileSync(dockerBin,'');
 const dockerSocket=path.join(root,'docker.sock');
 const server=net.createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(dockerSocket,resolve);});
 return {dockerBin,dockerSocket,server};
}
function trackingDocker(options={}){
 const calls=[],files=new Map();let running=false,nonce='',flagReady=false,logsServed=false;
 const execFileSync=(command,args,opts)=>{
  if(args.includes('exec')&&!running){const error=Error('container is not running');error.status=1;throw error;}
  calls.push([command,...args]);
  if(args.includes('inspect')&&args.includes('-f')){const format=args[args.indexOf('-f')+1]??'';if(String(format).includes('ExitCode'))return String(options.exitCode??1)+'\n';return options.exitedDuringReady||logsServed?'exited\n':'running\n';}
  if(options.failRm&&args.includes('rm')&&args.includes('-f')&&!args.includes('exec')){const error=Error('rm failed');error.status=1;throw error;}
  if(options.failStart&&args.includes('start')&&!args.includes('create')&&!args.includes('exec')){const error=Error('start failed');error.status=1;throw error;}
  if(options.failVolume&&args.includes('volume')&&args.includes('rm')){const error=Error('volume rm failed');error.status=1;throw error;}
  if(options.readyFlagExists&&args.includes('mkdir')&&args.includes('/tmp/qiwe-ready')){const error=Error('EXISTS');error.status=1;throw error;}
  if(args.some(item=>String(item).includes('full-host-audit.json')))return options.evidence===false?'':'QIWE_EVIDENCE_WRITTEN\n';
  if(args.some(item=>String(item).includes('cat >'))){const dest=String(args.find(item=>String(item).includes('cat >'))).match(/\/tmp\/qiwe-private-[a-f0-9]{16}/)?.[0];if(dest)files.set(dest,opts?.stdio?.[0]==='pipe'?Buffer.from(opts?.input??''):Buffer.alloc(0));return '';}
  if(args.includes('create')&&args.includes('--name'))running=false;
  if(args.includes('start')&&!args.includes('create'))running=true;
  if(args.includes('exec')&&args.some(item=>String(item).includes('/tmp/qiwe-ready/flag')&&String(item).includes('printf'))){nonce=args.find(item=>/^[a-f0-9]{32}$/.test(item))??nonce;flagReady=true;}
  const op=args.find(item=>['cp','sha256sum','stat','ln','rm','logs','create','start','network'].includes(item));
  if(op==='logs'){
   let body;
   if(options.logs==='duplicate')body=flagReady?`CONTROLLED_REAL_READY ${nonce}\nCONTROLLED_REAL_READY ${nonce}\n`:'waiting\n';
   else if(options.logs==='receipt')body=flagReady?`FULL_HOST_PHASE ${JSON.stringify({phase:'controlled-real',status:'starting'})}\n`:'waiting\n';
   else if(options.logs!==undefined)body=options.logs;
   else body=flagReady?`CONTROLLED_REAL_READY ${nonce}\n`:'waiting\n';
   if(body.includes(`CONTROLLED_REAL_READY ${nonce}`)||body.includes('"phase":"controlled-real"'))logsServed=true;
   return body;
  }
  if(op==='cp'){const host=args[args.indexOf('--')+1],spec=args.at(-1),dest=spec.slice(spec.indexOf(':')+1);files.set(dest,fs.readFileSync(host));return '';}
  if(op==='sha256sum'||op==='stat'){const target=args.at(-1),data=files.get(target);if(!data){const error=Error('missing');error.status=1;throw error;}if(op==='stat')return `1000 1000 600 1 ${data.length}\n`;return createHash('sha256').update(data).digest('hex')+'  '+target+'\n';}
  if(op==='ln'){const dest=args.at(-1),src=args.at(-2);if(files.has(dest)){const error=Error('File exists');error.status=1;throw error;}files.set(dest,Buffer.from(files.get(src)??''));return '';}
  return '';
 };
 return {calls,execFileSync};
}
