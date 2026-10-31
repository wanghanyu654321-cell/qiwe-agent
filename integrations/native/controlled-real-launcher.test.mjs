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
import {assertRecordedHostBoundary,launcherPlan,runSupervisedPilot} from './controlled-real-launcher.mjs';
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
  const nonce=exec.calls.find(argv=>argv.includes('create')).find(item=>item.startsWith('QIWE_PILOT_READY_NONCE=')).split('=')[1];
  assert.match(nonce,/^[a-f0-9]{32}$/);
  const flagWrite=exec.calls.find(argv=>argv.includes('exec')&&argv.some(item=>item.includes('/tmp/qiwe-ready/flag')));
  assert.equal(flagWrite.includes('0:0'),true);
  assert.equal(flagWrite.some(item=>item.includes(nonce)),false);
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
test('real launcher opens a private bridge, installs the file, then starts, and refuses a raised cap',async()=>{
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
  assert.equal(create.some(item=>item.includes('exec node /input/qiwe-agent/integrations/native/verify-full-host.mjs /input/full-instance/stage/app/src --host-overlay /input/core-fix/appointment-identity-candidate/src --skill-root /input/d4-skills')),true);
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
test('a symlink stage and a failed volume remove stay outside the boundary',async()=>{
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
test('a failed start removes the container and the bridge',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-fail-'));
 const controls=await hostControls(root);
 const privateFile=path.join(root,'host-private.json');
 fs.writeFileSync(privateFile,JSON.stringify({bot:{botId:'bot-id-example',corpId:'corp-id-example',secret:'host-file-secret-value'},model:{apiKey:'host-file-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}),{mode:0o600});
 const exec=trackingDocker({failStart:true});
 const win=process.platform==='win32'?{platform:'win32',homedir:root,realpath:()=>privateFile,currentSid:'S-1-5-21-1-2-3-1001',reparsePoint:false,aces:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',inherited:false}]}:{};
 try{
  assert.throws(()=>runSupervisedPilot({mode:'real',privateFile,image:'sha256:'+'ab'.repeat(32),env:clean,execFileSync:exec.execFileSync,dockerContext:'desktop-linux',cwd:root,dockerBin:controls.dockerBin,dockerSocket:controls.dockerSocket,...win}),/PILOT_LAUNCH_FAILED/);
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
function dockerDaemon(){try{realExec('docker',['info'],{stdio:'ignore',timeout:8000});return true;}catch{return false;}}
async function hostControls(root){
 const stage=path.join(root,'.local','frontagent-r3-20261029');
 fs.mkdirSync(path.join(stage,'input'),{recursive:true});
 fs.writeFileSync(path.join(stage,'build-input-linux.json'),'{}');
 const dockerBin=path.join(stage,'docker');
 fs.writeFileSync(dockerBin,'');
 const dockerSocket=path.join(root,'docker.sock');
 const server=net.createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(dockerSocket,resolve);});
 return {dockerBin,dockerSocket,server};
}
function trackingDocker(options={}){
 const calls=[],files=new Map();let running=false,nonce='',flagReady=false;
 const execFileSync=(command,args,opts)=>{
  if(args.includes('exec')&&!running){const error=Error('container is not running');error.status=1;throw error;}
  calls.push([command,...args]);
  if(args[0]==='inspect')return 'exited\n';
  if(options.failRm&&args[0]==='rm'&&args.includes('-f')){const error=Error('rm failed');error.status=1;throw error;}
  if(options.failStart&&args.includes('start')&&!args.includes('create')&&!args.includes('exec')){const error=Error('start failed');error.status=1;throw error;}
  if(options.failVolume&&args[0]==='volume'&&args.includes('rm')){const error=Error('volume rm failed');error.status=1;throw error;}
  if(options.readyFlagExists&&args.includes('mkdir')&&args.includes('/tmp/qiwe-ready')){const error=Error('EXISTS');error.status=1;throw error;}
  if(args.some(item=>String(item).includes('cat >'))){const dest=String(args.find(item=>String(item).includes('cat >'))).match(/\/tmp\/qiwe-private-[a-f0-9]{16}/)?.[0];if(dest)files.set(dest,Buffer.from(opts?.input??''));return '';}
  if(args.includes('create')&&args.includes('--name')){running=false;nonce=args.find(item=>item.startsWith('QIWE_PILOT_READY_NONCE='))?.split('=')[1]??'';}
  if(args.includes('start')&&!args.includes('create'))running=true;
  if(args.includes('exec')&&args.some(item=>item.includes('/tmp/qiwe-ready/flag')&&item.includes('printf')))flagReady=true;
  const op=args.find(item=>['cp','sha256sum','stat','ln','rm','logs','create','start','network'].includes(item));
  if(op==='logs'){if(options.logs==='duplicate')return flagReady?`CONTROLLED_REAL_READY ${nonce}\nCONTROLLED_REAL_READY ${nonce}\n`:'waiting\n';if(options.logs!==undefined)return options.logs;return flagReady?`CONTROLLED_REAL_READY ${nonce}\n`:'waiting\n';}
  if(op==='cp'){const host=args[args.indexOf('--')+1],spec=args.at(-1),dest=spec.slice(spec.indexOf(':')+1);files.set(dest,fs.readFileSync(host));return '';}
  if(op==='sha256sum'||op==='stat'){const target=args.at(-1),data=files.get(target);if(!data){const error=Error('missing');error.status=1;throw error;}if(op==='stat')return `1000 1000 600 1 ${data.length}\n`;return createHash('sha256').update(data).digest('hex')+'  '+target+'\n';}
  if(op==='ln'){const dest=args.at(-1),src=args.at(-2);if(files.has(dest)){const error=Error('File exists');error.status=1;throw error;}files.set(dest,Buffer.from(files.get(src)??''));return '';}
  return '';
 };
 return {calls,execFileSync};
}
