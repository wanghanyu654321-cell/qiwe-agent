import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {disposeConfirmedNewPilotEnv,witnessPilotEnvAbsence} from './controlled-real-env-disposition.mjs';

// Exercise the adapter with deterministic local ports; no Docker or network call.
function fixture(){
 const runId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const scope={mode:'controlled-real-pilot',environment:'local-test',runId,networkName:'qiwe-pilot-'+runId,expiresAt:Date.now()+60000};
 const receipt={version:3,controlledRealPilot:scope,docker:{mountpoint:'/var/lib/docker/volumes/qiwe-test/_data'}};
 const calls=[],owned=[],child=new EventEmitter(),state={stopFails:false};child.pid=42;
 const actual={spawn:(...a)=>{calls.push(['spawn',...a]);return child;},execFile:(...a)=>{calls.push(['execFile',...a]);return child;},execFileSync:(...a)=>{calls.push(['execFileSync',...a]);if(a[1].includes('info'))return '[]';if(a[1].includes('stop')){if(state.stopFails)throw Error('stop unknown');child.emit('close',0);}},exec:()=>{},execSync:()=>{},spawnSync:()=>{},fork:()=>{}};
 const fakeFs={constants:{O_WRONLY:1,O_APPEND:2,O_NOFOLLOW:4},readFileSync:p=>{assert.equal(p,'/proc/1/fd/8');return JSON.stringify(receipt);},realpathSync:p=>p,openSync:()=>7,writeSync:(_fd,s)=>owned.push(s),closeSync:()=>{},fstatSync:()=>({isFile:()=>true,nlink:1})};
 const fakeProcess={platform:'linux',getuid:()=>1000,getgid:()=>1000,cwd:()=>'/tmp/job',env:{QIWE_RESTORATION_RECEIPT:'/proc/1/fd/8'}};
 const source=fs.readFileSync(new URL('./controlled-real-container-transport.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function ','function ');
 const disposed=[];
 const install=new vm.Script('(function(){'+source+';return installControlledRealContainerTransport;})()').runInNewContext({fs:fakeFs,path:path.posix,childProcess:actual,syncBuiltinESMExports:()=>{},process:fakeProcess,
  witnessPilotEnvAbsence:(dataDir,folder)=>({status:'absent',dataDir,folder}),disposeConfirmedNewPilotEnv:(...args)=>{disposed.push(args);return {disposed:false,reason:'still_absent'};},
  inspectLocalDockerReceipt:r=>{assert.equal(r.version,3);return r.docker;},localDocker:'/qiwe-control/docker',localEndpoint:'unix:///qiwe-control/docker.sock',
  admitLocalDockerSpawn:(cmd,args,opts,s)=>{if(cmd!=='docker'||!s.ready||s.alreadyStarted||args[4]!=='miniclaw-marketing-123')throw Error('LOCAL_DOCKER_SPAWN_FORBIDDEN');},
  admitControlledRealDockerRun:(args,opts)=>({name:args[4],args:[...args],mounts:[]}),translateLocalMounts:args=>args,
  admitDockerControl:(cmd,args,owners)=>{if(cmd!=='docker'||args[0]!=='info'&&!(args[0]==='stop'&&owners.has(args[1])))throw Error('CONTROL');return args;},
  admitDockerShell:(cmd,owners)=>{const name=cmd.replace('docker stop ','');if(!owners.has(name))throw Error('CONTROL');return ['stop',name];},
  setTimeout,clearTimeout,Promise,Set,Error,JSON,Object,Number,String});
 const opts={root:'/tmp/job',folder:'marketing',accountId:'member',image:'sha256:'+'a'.repeat(64),originalShell:{},controlledRealPilot:scope,manifest:'/tmp/job/owned',preload:'/tmp/job/preload.mjs',modelModule:'/tmp/job/model.ts'};
 return {install,opts,scope,receipt,calls,owned,actual,child,state,disposed};
}
test('requires prepared original gate, routes exactly one runner and keeps control ownership',async()=>{
 const f=fixture(),originalSpawn=f.actual.spawn,transport=f.install(f.opts);
 assert.equal('originalSpawn' in transport,false);
 assert.throws(()=>f.install(f.opts),/ALREADY_INSTALLED/);
 const args=['run','-i','--rm','--name','miniclaw-marketing-123',f.opts.image],options={stdio:['pipe','pipe','pipe']};
 assert.throws(()=>f.actual.spawn('docker',args,options),/FORBIDDEN/);
 assert.throws(()=>transport.activate({phase:()=> 'ready'}),/PREPARE/);
 assert.throws(()=>transport.prepare({GROUPS_DIR:'/tmp',DATA_DIR:'/tmp/job/data'}),/PREPARE/);
 transport.prepare({GROUPS_DIR:'/tmp/job/groups',DATA_DIR:'/tmp/job/data'});
 assert.throws(()=>transport.activate({phase:()=> 'paused'}),/GATE/);
 transport.activate({phase:()=> 'ready'});
 assert.equal(f.actual.spawn('docker',args,options),f.child);
 assert.equal(f.owned[0],'miniclaw-marketing-123\n');
 assert.throws(()=>f.actual.spawn('docker',args,options),/FORBIDDEN/);
 assert.throws(()=>f.actual.execFileSync('docker',['stop','miniclaw-marketing-999']),/CONTROL/);
 const callback=()=>{},execOptions={encoding:'utf8'};
 assert.equal(f.actual.execFile('docker',['stop','miniclaw-marketing-123'],execOptions,callback),f.child);
 const routed=f.calls.find(call=>call[0]==='execFile');assert.equal(routed[3],execOptions);assert.equal(routed[4],callback);
 await transport.close();assert.ok(f.calls.some(call=>call[0]==='execFileSync'&&call[2].includes('stop')));
 assert.equal(f.disposed.length,1);assert.equal(JSON.stringify(f.disposed[0][3]),JSON.stringify({state:'exited',exitCode:0,signal:null}));
 assert.notEqual(f.actual.spawn,originalSpawn);
 assert.throws(()=>f.actual.spawn('docker',args,options),/FORBIDDEN/);
 assert.throws(()=>f.actual.execFileSync('docker',['stop','miniclaw-marketing-123']),/CONTROL/);
});
test('unknown stop retains the deny-by-default process routing until exit',async()=>{
 const f=fixture(),originalSpawn=f.actual.spawn,transport=f.install(f.opts),args=['run','-i','--rm','--name','miniclaw-marketing-123',f.opts.image],options={stdio:['pipe','pipe','pipe']};
 transport.prepare({GROUPS_DIR:'/tmp/job/groups',DATA_DIR:'/tmp/job/data'});transport.activate({phase:()=> 'ready'});
 f.actual.spawn('docker',args,options);f.state.stopFails=true;
 await assert.rejects(transport.close(),/stop unknown/);assert.equal(f.disposed.length,0);
 assert.notEqual(f.actual.spawn,originalSpawn);
 assert.throws(()=>f.actual.spawn('docker',args,options),/FORBIDDEN/);
 assert.throws(()=>f.actual.execFileSync('docker',['stop','miniclaw-marketing-999']),/CONTROL/);
});
test('real close disposes a witnessed new env file through the real disposition function',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-real-close-'))),data=path.join(root,'data');
 fs.mkdirSync(data);
 const runId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const scope={mode:'controlled-real-pilot',environment:'local-test',runId,networkName:'qiwe-pilot-'+runId,expiresAt:Date.now()+60000};
 const receipt={version:3,controlledRealPilot:scope,docker:{mountpoint:'/var/lib/docker/volumes/qiwe-test/_data'}};
 const child=new EventEmitter();child.pid=42;
 const actual={spawn:()=>child,execFile:()=>child,execFileSync:(...args)=>{if(args[1].includes('info'))return '[]';if(args[1].includes('stop'))child.emit('close',0);},exec:()=>{},execSync:()=>{},spawnSync:()=>{},fork:()=>{}};
 const source=fs.readFileSync(new URL('./controlled-real-container-transport.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function ','function ');
 const install=new vm.Script('(function(){'+source+';return installControlledRealContainerTransport;})()').runInNewContext({fs:{constants:fs.constants,readFileSync:target=>target=== '/proc/1/fd/8'?JSON.stringify(receipt):fs.readFileSync(target),realpathSync:target=>target,openSync:fs.openSync,writeSync:fs.writeSync,closeSync:fs.closeSync,fstatSync:fs.fstatSync},path:path.posix,childProcess:actual,syncBuiltinESMExports:()=>{},process:{platform:'linux',getuid:()=>1000,getgid:()=>1000,cwd:()=>root,env:{QIWE_RESTORATION_RECEIPT:'/proc/1/fd/8'}},
  witnessPilotEnvAbsence,disposeConfirmedNewPilotEnv,
  inspectLocalDockerReceipt:value=>value.docker,localDocker:'/qiwe-control/docker',localEndpoint:'unix:///qiwe-control/docker.sock',
  admitLocalDockerSpawn:(cmd,args,opts,state)=>{if(cmd!=='docker'||!state.ready||state.alreadyStarted||args[4]!=='miniclaw-marketing-123')throw Error('LOCAL_DOCKER_SPAWN_FORBIDDEN');},
  admitControlledRealDockerRun:args=>({name:args[4],args:[...args],mounts:[]}),translateLocalMounts:args=>args,
  admitDockerControl:(cmd,args,owners)=>{if(cmd!=='docker'||args[0]!=='info'&&!(args[0]==='stop'&&owners.has(args[1])))throw Error('CONTROL');return args;},
  admitDockerShell:()=>['stop','miniclaw-marketing-123'],setTimeout,clearTimeout,Promise,Set,Error,JSON,Object,Number,String});
 const manifest=path.join(root,'owned');fs.writeFileSync(manifest,'');
 const transport=install({root,folder:'marketing',accountId:'member',image:'sha256:'+'ab'.repeat(32),originalShell:{},controlledRealPilot:scope,manifest,preload:path.join(root,'preload.mjs'),modelModule:path.join(root,'model.ts')});
 try{
  transport.prepare({GROUPS_DIR:path.join(root,'groups'),DATA_DIR:data});
  const file=path.join(data,'env','marketing','default','main','env');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'SECRET_NOT_ORIGINAL\n');
  transport.activate({phase:()=>'ready'});
  actual.spawn('docker',['run','-i','--rm','--name','miniclaw-marketing-123','image'],{});
  await transport.close();
  assert.equal(fs.existsSync(file),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('rejects mismatched scope and refuses malformed options before installing process routes',()=>{
 const f=fixture(),original=f.actual.spawn;
 assert.throws(()=>f.install({...f.opts,controlledRealPilot:{...f.scope,runId:'foreign'}}),/SCOPE/);
 assert.throws(()=>f.install({...f.opts,folder:'../other'}),/SCOPE/);
 assert.equal(f.actual.spawn,original);
});
