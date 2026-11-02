import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {admitLocalDockerSpawn,admitDockerRun,admitDockerControl,admitDockerShell} from './real-container-boundary.mjs';

const prefix='miniclaw-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-',name=prefix+'1234';
const args=['run','-i','--rm','--name',name],options={stdio:['pipe','pipe','pipe']};
test('existing transport refuses synthetic material collision and leaves original bytes unchanged',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'existing-material-')),previous=process.cwd(),receipt=process.env.QIWE_RESTORATION_RECEIPT,phase=process.env.QIWE_FULL_HOST_PHASE;
 try{
  const config={DATA_DIR:path.join(root,'data'),GROUPS_DIR:path.join(root,'data/groups')},folder='flow-synthetic-test',accountId='synthetic-member';
  for(const id of ['beauty-local-content','vendor-content-strategy','vendor-copywriting']){for(const file of [path.join(root,'skill-sources',id,'SKILL.md'),path.join(config.DATA_DIR,'skills',accountId,id,'SKILL.md')]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic skill bytes');}}
  const material=path.join(config.GROUPS_DIR,folder,'approved.txt');fs.mkdirSync(path.dirname(material),{recursive:true});fs.writeFileSync(material,'original synthetic owner material\n');const before=fs.readFileSync(material);
  const code=ts.transpileModule(fs.readFileSync(new URL('./full-host-local-container.fixture.mts',import.meta.url),'utf8'),{fileName:'fixture.ts',compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const nativeRequire=createRequire(import.meta.url),exports={};
  const imports={'vitest':{expect:value=>({toBe:expected=>assert.equal(value,expected)})},'node:fs':fs,'node:path':path,'node:child_process':childProcess,'./real-container-boundary.mjs':{},'../src/full-host-local-docker.mjs':{inspectLocalDockerReceipt:()=>({mountpoint:root})},'./full-host-restoration.fixture.mts':{actor:{accountId:'synthetic-default'},folder:'synthetic-restoration-role'}};
  process.env.QIWE_RESTORATION_RECEIPT=path.join(root,'receipt.json');fs.writeFileSync(process.env.QIWE_RESTORATION_RECEIPT,'{}');delete process.env.QIWE_FULL_HOST_PHASE;process.chdir(root);
  new Function('require','exports',code)(name=>Object.hasOwn(imports,name)?imports[name]:nativeRequire(name),exports);
  const fixture=exports.prepareLocalContainerTransport([],{actor:{accountId},folder,ownedContainerPrefix:'miniclaw-'+folder+'-'});
  let failure;try{fixture.prepare(config);}catch(error){failure=error;}
  assert.deepEqual(fs.readFileSync(material),before);
  assert.match(String(failure),/EXISTING_SYNTHETIC_MATERIAL_ALREADY_EXISTS|EEXIST/);
  fs.unlinkSync(material);fixture.prepare(config);assert.match(fs.readFileSync(material,'utf8'),/^synthetic-approved-v1:/);
  const defaultMaterial=path.join(config.GROUPS_DIR,'synthetic-restoration-role','approved.txt');fs.mkdirSync(path.dirname(defaultMaterial),{recursive:true});fs.writeFileSync(defaultMaterial,'old synthetic fixture material');
  exports.prepareLocalContainerTransport([]).prepare(config);assert.match(fs.readFileSync(defaultMaterial,'utf8'),/^synthetic-approved-v1:/);
 }finally{process.chdir(previous);if(receipt===undefined)delete process.env.QIWE_RESTORATION_RECEIPT;else process.env.QIWE_RESTORATION_RECEIPT=receipt;if(phase===undefined)delete process.env.QIWE_FULL_HOST_PHASE;else process.env.QIWE_FULL_HOST_PHASE=phase;fs.rmSync(root,{recursive:true,force:true});}
});
test('original Native flow folder is admitted only under its complete approved prefix',()=>{
 const approved='miniclaw-flow-localtest-ab12-',container=approved+'1234',command=[...args.slice(0,4),container],owned=new Set([container]);
 const state={ready:true,alreadyStarted:false,ownedContainerPrefix:approved};
 assert.doesNotThrow(()=>admitLocalDockerSpawn('docker',command,options,state));
 assert.deepEqual(admitDockerControl('docker',['stop',container],owned,approved),['stop',container]);
 assert.deepEqual(admitDockerShell('docker stop '+container,owned,approved),['stop',container]);
 for(const wrong of [undefined,'miniclaw-flow-','miniclaw-flow-localtest-','miniclaw-flow-localtest-other-'])assert.throws(()=>admitLocalDockerSpawn('docker',command,options,{...state,ownedContainerPrefix:wrong}),/SPAWN/);
});
test('existing owned UUID folder needs an exact explicit prefix at spawn and control boundaries',()=>{
 const state={ready:true,alreadyStarted:false,ownedContainerPrefix:prefix},owned=new Set([name]);
 assert.doesNotThrow(()=>admitLocalDockerSpawn('docker',args,options,state));
 assert.deepEqual(admitDockerControl('docker',['stop',name],owned,prefix),['stop',name]);
 assert.deepEqual(admitDockerShell('docker stop '+name,owned,prefix),['stop',name]);
 for(const candidate of [undefined,'miniclaw-','miniclaw-aaaaaaaa-','miniclaw-'+'.*','miniclaw-ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee-']){
  assert.throws(()=>admitLocalDockerSpawn('docker',args,options,{...state,ownedContainerPrefix:candidate}),/LOCAL_DOCKER/);
  assert.throws(()=>admitDockerControl('docker',['stop',name],owned,candidate),/REAL_CONTAINER/);
 }
 assert.throws(()=>admitDockerControl('docker',['stop',prefix+'foreign'],owned,prefix),/ARGUMENT/);
 assert.throws(()=>admitDockerShell('docker stop '+name+'; echo x',owned,prefix),/SHELL/);
 assert.throws(()=>admitLocalDockerSpawn('docker',args,{...options,shell:true},state),/SPAWN/);
 assert.throws(()=>admitLocalDockerSpawn('docker',args,options,{...state,alreadyStarted:true}),/SPAWN/);
});
test('explicit existing folder retains exact mounts, isolation and network/env restrictions',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'existing-boundary-'));
 try{
  const group=path.join(root,'group');fs.mkdirSync(group);
  const spec={root,runner:root,deps:root,provider:path.join(root,'provider.mjs'),image:'sha256:'+'a'.repeat(64),runId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',ownedContainerPrefix:prefix,expectedMounts:{'/workspace/group':{source:group,readonly:false}}};
  const command=[...args,'-v',group+':/workspace/group',spec.image];
  const admitted=admitDockerRun(command,spec);
  assert.equal(admitted.name,name);assert.ok(admitted.args.includes('--read-only'));assert.ok(admitted.args.includes('none'));
  assert.throws(()=>admitDockerRun(command,{...spec,ownedContainerPrefix:undefined}),/ARGUMENT/);
  for(const extra of [['--network','host'],['-e','SECRET=forbidden'],['-v',root+':/workspace/ipc'],['-v',group+':/app/src']])assert.throws(()=>admitDockerRun([...command.slice(0,-1),...extra,spec.image],spec),/ARGUMENT|MOUNT/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
