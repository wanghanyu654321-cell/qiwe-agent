import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {validateControlledRealPilotScope,inspectLocalDockerReceipt} from './full-host-local-docker.mjs';

const runId='12345678-1234-1234-1234-123456789abc',sha=value=>createHash('sha256').update(value).digest('hex');
const scope=()=>({mode:'controlled-real-pilot',environment:'local-test',runId,expiresAt:Date.now()+600000,networkName:'qiwe-pilot-'+runId});
const source=fs.readFileSync(new URL('./full-host-restoration-boundary.ts',import.meta.url),'utf8');
function boundaryFixture(version=3){
 const script='/input/supervisor.mjs',module='/input/full-host-restoration-supervisor.mjs',helper='/input/full-host-local-docker.mjs',host='/tmp/qiwe-full-host-synthetic',data=host+'/data';
 const receipt={version,runId:'inner-fixture-run',issuedAt:new Date().toISOString(),supervisor:{pid:1,startTime:'99',scriptPath:script,scriptSha256:sha('script'),modulePath:module,moduleSha256:sha('module')},hostRoot:{path:host,dev:'1',ino:'2'},dataRoot:{path:data,dev:'1',ino:'3'},namespaces:{pid:'pid:[1]',net:'net:[2]',mnt:'mnt:[3]'},oldWriters:[{pid:41,startTime:'70',exitCode:null,signal:'SIGTERM',capability:{dbPath:data+'/db/messages.db',ipcPath:data+'/ipc/proof'},writeObservedSha256:'a'.repeat(64)}],...(version>=2?{helperSha256:sha('helper')}:{})};
 if(version===3){receipt.controlledRealPilot=scope();receipt.docker={runId,controlledRealPilot:receipt.controlledRealPilot};}
 const env={QIWE_RESTORATION_RECEIPT:'/proc/1/fd/9',...(version>=2?{QIWE_RESTORATION_REAL_CONTAINER:'1'}:{}),...(version===3?{QIWE_CONTROLLED_REAL_PILOT:'1',QIWE_LOCAL_DOCKER_RUN_ID:runId,QIWE_LOCAL_DOCKER_NETWORK:receipt.controlledRealPilot.networkName}:{})};
 const stat=(ino,directory=false)=>({isFile:()=>!directory,isDirectory:()=>directory,dev:1n,ino:BigInt(ino),nlink:0n,size:2048n});
 const processStat=(parent,start)=>'42 (node) '+['S',String(parent),...Array(17).fill('0'),start].join(' ');
 const reads=new Map([[script,'script'],[module,'module'],[helper,'helper'],['/proc/1/fdinfo/9','flags:\t0100000'],['/proc/1/stat',processStat(0,'99')],['/proc/42/stat',processStat(1,'100')],['/proc/1/cmdline','node\0'+script+'\0'],['/proc/1/status','CapEff:\t000000\nNoNewPrivs:\t1'],['/proc/self/mountinfo','1 0 0:1 / / ro - overlay overlay ro\n2 1 0:2 / /input ro - tmpfs tmpfs ro\n3 1 0:3 / /tmp rw - tmpfs tmpfs rw'],['/proc/net/dev','header\nheader\nlo: 0\n'+(version===3?'eth0: 0\n':'')]]);
 const exists=new Set();let dockerChecks=0;
 const fakeFs={readFileSync(target){if(target===env.QIWE_RESTORATION_RECEIPT)return JSON.stringify(receipt);if(!reads.has(target))throw Error('unexpected synthetic read '+target);return reads.get(target);},statSync(target){if(target===env.QIWE_RESTORATION_RECEIPT)return stat(9);if(target===host)return stat(2,true);if(target===data)return stat(3,true);throw Error('unexpected stat '+target);},realpathSync:target=>target,readlinkSync:target=>receipt.namespaces[target.split('/').at(-1)],existsSync:target=>exists.has(target),readdirSync:()=>['1','42']};
 const fakeProcess={platform:'linux',pid:42,env,cwd:()=>host};
 const loaded=stripTypeScriptTypes(source).replace(/^import .*;\r?\n/gm,'').replace('export function inspectRestorationBoundary','function inspectRestorationBoundary').replace('LOCAL_DOCKER_HELPER_HASH',sha('helper'));
 const inspect=new vm.Script('(function(){'+loaded+';return inspectRestorationBoundary;})()').runInNewContext({fs:fakeFs,path:path.posix,createHash,process:fakeProcess,inspectLocalDockerReceipt(value){dockerChecks++;assert.equal(JSON.stringify(value),JSON.stringify(receipt));if(value.version===3){validateControlledRealPilotScope(value.controlledRealPilot,env.QIWE_LOCAL_DOCKER_RUN_ID);if(env.QIWE_CONTROLLED_REAL_PILOT!=='1'||env.QIWE_LOCAL_DOCKER_NETWORK!==value.controlledRealPilot.networkName)throw Error('LOCAL_DOCKER_BOUNDARY_UNVERIFIED');}}});
 return {receipt,env,reads,exists,fakeFs,inspect:()=>inspect(data,sha('script'),sha('module')),dockerChecks:()=>dockerChecks};
}
test('v3 boundary accepts scoped bridge only after original pinned process, mounts, namespaces and writer checks',()=>{
 const f=boundaryFixture();const result=f.inspect();assert.equal(f.dockerChecks(),1);assert.ok(result.evidence.includes('controlled_real_pilot_local_test'));assert.match(result.version,/^[a-f0-9]{64}$/);
});
test('v1/v2 retain loopback-only rejection and do not gain scope from environment',()=>{
 for(const version of [1,2]){const f=boundaryFixture(version);assert.doesNotThrow(f.inspect);f.reads.set('/proc/net/dev','header\nheader\nlo: 0\neth0: 0');assert.throws(f.inspect,/RESTORATION_BOUNDARY/);}
 const f=boundaryFixture(2);f.env.QIWE_CONTROLLED_REAL_PILOT='1';f.receipt.controlledRealPilot=scope();assert.throws(f.inspect,/RESTORATION_BOUNDARY/);
});
test('v3 boundary rejects missing/expired scope and all original identity or writer violations',()=>{
 const changes=[f=>delete f.receipt.controlledRealPilot,f=>f.receipt.controlledRealPilot.expiresAt=Date.now()-1,f=>f.receipt.supervisor.moduleSha256='0'.repeat(64),f=>f.reads.set('/proc/1/fdinfo/9','flags: 0100002'),f=>f.reads.set('/proc/1/status','CapEff: 1\nNoNewPrivs: 1'),f=>f.receipt.hostRoot.ino='99',f=>f.exists.add('/proc/41/stat'),f=>f.fakeFs.readdirSync=()=>['1','42','44'],f=>f.fakeFs.readlinkSync=()=> 'net:[other]',f=>f.reads.set('/proc/net/dev','header\nheader\nlo: 0\neth0: 0\neth1: 0')];
 for(const change of changes){const f=boundaryFixture();change(f);if(f.exists.has('/proc/41/stat'))f.reads.set('/proc/41/stat','41 (writer) '+['S','1',...Array(17).fill('0'),'70'].join(' '));assert.throws(f.inspect,/RESTORATION_BOUNDARY|LOCAL_DOCKER/);}
});
test('scope snapshot rejects privilege/scope substitutions and cannot follow caller mutation',()=>{
 const original=scope(),snapshot=validateControlledRealPilotScope(original,runId);original.environment='production';assert.equal(snapshot.environment,'local-test');assert.equal(Object.isFrozen(snapshot),true);
 for(const change of [s=>s.expiresAt=Date.now()+3601000,s=>s.expiresAt=Date.now(),s=>s.mode='production',s=>s.runId='other',s=>s.networkName='bridge',s=>s.extra='flag']){const value=scope();change(value);assert.throws(()=>validateControlledRealPilotScope(value,runId),/LOCAL_DOCKER/);}
});
test('receipt inspector refuses scope flags without pinned v3 receipt facts before touching Docker',()=>{
 const saved={...process.env};try{
  process.env.QIWE_RESTORATION_REAL_CONTAINER='1';process.env.QIWE_LOCAL_DOCKER_RUN_ID=runId;process.env.QIWE_CONTROLLED_REAL_PILOT='1';process.env.QIWE_LOCAL_DOCKER_NETWORK='qiwe-pilot-'+runId;
  assert.throws(()=>inspectLocalDockerReceipt({version:2,docker:{runId}}),/LOCAL_DOCKER/);
  assert.throws(()=>inspectLocalDockerReceipt({version:3,docker:{runId}}),/LOCAL_DOCKER/);
  assert.throws(()=>inspectLocalDockerReceipt({version:3,controlledRealPilot:scope(),docker:{runId,controlledRealPilot:{...scope(),environment:'production'}}}),/LOCAL_DOCKER/);
 }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});

const supervisorSource=fs.readFileSync(new URL('./full-host-restoration-supervisor.mjs',import.meta.url),'utf8');
function producerFixture({pilot=true}={}){
 const f=boundaryFixture(pilot?3:2),root=f.receipt.hostRoot.path,data=root+'/data',dbPath=data+'/db/messages.db',files=new Map([[dbPath,Buffer.from('synthetic db bytes')]]),fds=new Map();let nextFd=10,alive=false,dockerInput;
 const options={hostRoot:root,dataDir:data,runId:'inner-fixture-run',...(pilot?{controlledRealPilot:scope()}:{})};
 const fakeFs={...f.fakeFs,
  realpathSync:target=>target,mkdirSync(){},
  lstatSync(target){if(target===root||target===data||target===data+'/ipc')return {isSymbolicLink:()=>false,isDirectory:()=>true,dev:1n,ino:target===root?2n:3n};if(files.has(target))return {isSymbolicLink:()=>false,isFile:()=>true,dev:1n,ino:4n};throw Object.assign(Error('missing'),{code:'ENOENT'});},
  readFileSync(target){if(typeof target==='number')return fds.get(target).raw;if(target instanceof URL)return Buffer.from('helper');if(files.has(target))return files.get(target);if(target==='/proc/41/stat')return '41 (writer) '+['S','1',...Array(17).fill('0'),'70'].join(' ');return f.fakeFs.readFileSync(target);},
  writeFileSync(fd,raw){fds.get(fd).raw=Buffer.from(raw);files.set(fds.get(fd).target,Buffer.from(raw));},fsyncSync(){},closeSync(fd){fds.delete(fd);},
  openSync(target,mode){const fd=nextFd++;if(mode==='wx')files.set(target,Buffer.alloc(0));fds.set(fd,{target,raw:files.get(target)});return fd;},
  unlinkSync:target=>files.delete(target),fstatSync:fd=>({nlink:0n,size:BigInt(fds.get(fd).raw.length)}),existsSync:target=>target==='/proc/41/stat'?alive:files.has(target),
 };
 const spawn=(executable,args)=>{
  const input=JSON.parse(args[3]),child=new EventEmitter();child.pid=41;alive=true;
  child.kill=signal=>{alive=false;queueMicrotask(()=>child.emit('exit',null,signal));return true;};
  queueMicrotask(()=>{const proof={version:1,runId:input.runId,nonce:input.nonce,pid:41,dbPath:input.dbPath,schemaVersion:'73',updateChanges:1,ipcPath:input.ipcPath};files.set(input.ipcPath,Buffer.from(JSON.stringify(proof)));child.emit('message',{kind:'writer-ready',proof});});
  return child;
 };
 const loaded=supervisorSource.replace(/^import .*;\r?\n/gm,'').replaceAll('export async function','async function').replaceAll('import.meta.url',JSON.stringify('file:///input/full-host-restoration-supervisor.mjs'));
 const create=new vm.Script('(function(){'+loaded+';return createRestorationSupervisorReceipt;})()').runInNewContext({fs:fakeFs,os:{tmpdir:()=>'/tmp'},path:path.posix,spawn,URL,Buffer,setTimeout,clearTimeout,createHash,randomUUID:()=> 'synthetic-nonce',fileURLToPath:()=>'/input/full-host-restoration-supervisor.mjs',process:{platform:'linux',pid:1,argv:['node','/input/supervisor.mjs'],env:f.env,execPath:'/node'},validateControlledRealPilotScope,observeLocalDockerBoundary:async input=>{dockerInput=input;options.controlledRealPilot&&(options.controlledRealPilot.environment='production');return {runId,controlledRealPilot:input.controlledRealPilot};}});
 return {...f,options,create:()=>create(options),files,fds,dockerInput:()=>dockerInput};
}
test('PID1 producer emits v3 only from frozen bounded scope and keeps original unlinked fd writer evidence',async()=>{
 const f=producerFixture(),issued=await f.create();try{assert.equal(issued.receipt.version,3);assert.equal(issued.receipt.controlledRealPilot.environment,'local-test');assert.equal(f.dockerInput().controlledRealPilot.environment,'local-test');assert.equal(issued.receipt.oldWriters[0].signal,'SIGTERM');assert.match(issued.locator,/^\/proc\/1\/fd\/\d+$/);assert.equal([...f.files.keys()].some(name=>name.includes('receipt')||name.includes('owned-writer')),false);}finally{issued.close();}assert.equal(f.fds.size,0);
});
test('producer keeps v2 default and rejects absent opt-in, invalid scope or opt-in without scope before writer start',async()=>{
 const original=producerFixture({pilot:false}),receipt=await original.create();assert.equal(receipt.receipt.version,2);assert.equal(receipt.receipt.controlledRealPilot,undefined);receipt.close();
 for(const change of [f=>delete f.env.QIWE_CONTROLLED_REAL_PILOT,f=>f.env.QIWE_LOCAL_DOCKER_NETWORK='other',f=>f.options.controlledRealPilot.expiresAt=Date.now()-1,f=>delete f.options.controlledRealPilot,f=>f.env.QIWE_RESTORATION_REAL_CONTAINER='0']){const f=producerFixture();change(f);await assert.rejects(f.create(),/LOCAL_DOCKER|RESTORATION_SUPERVISOR/);assert.equal([...f.files.keys()].some(name=>name.includes('owned-writer')),false);}
});

test('v3 Docker receipt inspector re-observes actual pinned network, files, DB and canary rather than trusting receipt fields',()=>{
 const helperSource=fs.readFileSync(new URL('./full-host-local-docker.mjs',import.meta.url),'utf8'),controlledRealPilot=scope(),hostId='a'.repeat(64),networkId='c'.repeat(64),volume='qiwe-test',mountpoint='/var/lib/docker/volumes/qiwe-test/_data',hostRoot='/tmp/qiwe-full-host-synthetic',dbPath=hostRoot+'/data/db/messages.db',canaryPath=hostRoot+'/canary';
 const mounts=[{Type:'volume',Name:volume,Source:mountpoint,Destination:'/tmp',RW:true},...['/input','/qiwe-control/build-input.json','/qiwe-control/docker','/qiwe-control/docker.sock'].map(Destination=>({Type:'bind',Source:'/source'+Destination,Destination,RW:false}))];
 const network={Id:networkId,Name:controlledRealPilot.networkName,Driver:'bridge',Scope:'local',Internal:false,Attachable:false,Ingress:false,EnableIPv6:false,Labels:{'qiwe.verification-run':runId,'qiwe.controlled-real-pilot':'local-test'},Options:{},IPAM:{Driver:'default',Options:null,Config:[]}};
 const liveNetwork={...structuredClone(network),Containers:{[hostId]:{EndpointID:'e'.repeat(64)}}},host={Id:hostId,Config:{User:'1000:1000',Labels:{'qiwe.verification-run':runId}},State:{Running:true},HostConfig:{NetworkMode:network.Name,ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PortBindings:{},PublishAllPorts:false},Mounts:mounts,NetworkSettings:{Ports:{},Networks:{[network.Name]:{NetworkID:networkId,EndpointID:'e'.repeat(64)}}}};
 const controls=Object.fromEntries(['/qiwe-control/docker','/qiwe-control/docker.sock','/qiwe-control/build-input.json'].map(file=>[file,{dev:'1',ino:'2',...(file.endsWith('.sock')?{}:{sha256:sha('bytes')})}]));
 const receipt={version:3,controlledRealPilot,hostRoot:{path:hostRoot},dataRoot:{path:hostRoot+'/data'},docker:{runId,daemonId:'daemon',volume,mountpoint,hostId,hostMounts:mounts,controlledRealPilot,network,controls,canary:{path:canaryPath,dev:'1',ino:'2',sha256:sha('bytes')},oldContainerId:'b'.repeat(64),oldWriter:{dbPath,updateChanges:1,database:{dev:'1',ino:'2'}},probe:[{}, {path:dbPath,dev:'1',ino:'2'}]}};
 const calls=[],execute=(binary,args)=>{assert.equal(binary,'/qiwe-control/docker');assert.deepEqual(Array.from(args.slice(0,2)),['--host','unix:///qiwe-control/docker.sock']);const command=Array.from(args.slice(2));calls.push(command);if(command[0]==='ps')return hostId;if(command[0]==='info')return JSON.stringify('daemon');if(command[0]==='volume')return JSON.stringify([{Name:volume,Mountpoint:mountpoint,Driver:'local',Labels:{'qiwe.verification-run':runId}}]);if(command[0]==='network')return JSON.stringify([liveNetwork]);if(command[0]==='inspect'&&command[1]==='--format')return JSON.stringify({Id:hostId,Mounts:mounts});if(command[0]==='inspect')return JSON.stringify([host]);throw Error('unexpected command');};
 const loaded=helperSource.replace(/^import .*;\r?\n/gm,'').replaceAll('export async function','async function').replaceAll('export function','function').replaceAll('export const','const');
 const inspect=new vm.Script('(function(){'+loaded+';return inspectLocalDockerReceipt;})()').runInNewContext({fs:{lstatSync:target=>({dev:1n,ino:2n,isSocket:()=>target.endsWith('.sock'),isFile:()=>!target.endsWith('.sock')}),readFileSync:()=>Buffer.from('bytes')},path:path.posix,createHash,execFileSync:execute,process:{platform:'linux',getuid:()=>1000,getgid:()=>1000,env:{QIWE_RESTORATION_REAL_CONTAINER:'1',QIWE_LOCAL_DOCKER_RUN_ID:runId,QIWE_LOCAL_DOCKER_VOLUME:volume,QIWE_LOCAL_DOCKER_HOST:'qiwe-host',QIWE_CONTROLLED_REAL_PILOT:'1',QIWE_LOCAL_DOCKER_NETWORK:network.Name}}});
 assert.equal(inspect(receipt),receipt.docker);assert.ok(calls.some(command=>command[0]==='network'&&command[1]==='inspect'&&command[2]===network.Name));
 liveNetwork.Labels['qiwe.verification-run']='foreign';assert.throws(()=>inspect(receipt),/LOCAL_DOCKER/);
});
