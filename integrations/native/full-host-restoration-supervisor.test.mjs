import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRestorationSupervisorReceipt,observeOwnedRestorationWriter} from './full-host-restoration-supervisor.mjs';

function fixture(){
 const hostRoot=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-full-host-supervisor-test-')),dataDir=path.join(hostRoot,'data');
 fs.mkdirSync(path.join(dataDir,'db'),{recursive:true});
 const db=new DatabaseSync(path.join(dataDir,'db/messages.db'));
 db.exec("CREATE TABLE router_state(key TEXT PRIMARY KEY,value TEXT); INSERT INTO router_state VALUES('schema_version','73'); CREATE TABLE preserved_fact(value TEXT); INSERT INTO preserved_fact VALUES('unchanged')");
 return {hostRoot,dataDir,db,close(){db.close();fs.rmSync(hostRoot,{recursive:true,force:true});}};
}
const options=value=>({hostRoot:value.hostRoot,dataDir:value.dataDir,runId:'supervisor-local-lifecycle',timeoutMs:5000});

test('receipt producer refuses a normal host process without creating proof files',{skip:process.platform==='linux'&&process.pid===1},async()=>{
 const f=fixture();try{
  await assert.rejects(createRestorationSupervisorReceipt(options(f)),/RESTORATION_SUPERVISOR_BOUNDARY_REQUIRED/);
  assert.equal(fs.existsSync(path.join(f.dataDir,'ipc')),false);
 }finally{f.close();}
});

test('confined Linux PID1 issues only an unlinked readonly receipt for its actually stopped writer',{skip:process.platform!=='linux'||process.pid!==1},async()=>{
 const f=fixture();let issued;try{
  issued=await createRestorationSupervisorReceipt(options(f));
  assert.match(issued.locator,/^\/proc\/1\/fd\/\d+$/);
  const stat=fs.statSync(issued.locator,{bigint:true});assert.equal(stat.nlink,0n);
  const info=fs.readFileSync('/proc/1/fdinfo/'+issued.locator.split('/').at(-1),'utf8');
  assert.equal(parseInt(info.match(/^flags:\s+([0-7]+)$/m)[1],8)&3,0);
  const receipt=JSON.parse(fs.readFileSync(issued.locator,'utf8'));
  assert.equal(receipt.supervisor.pid,1);assert.equal(receipt.supervisor.scriptPath,process.argv[1]);
  assert.equal(receipt.hostRoot.path,f.hostRoot);assert.equal(receipt.dataRoot.path,f.dataDir);
  assert.equal(receipt.oldWriters.length,1);assert.equal(receipt.oldWriters[0].signal,'SIGTERM');
  assert.equal(fs.existsSync('/proc/'+receipt.oldWriters[0].pid+'/stat'),false);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'ipc')),[]);
  issued.close();assert.equal(fs.existsSync(issued.locator),false);issued.close();
 }finally{issued?.close();f.close();}
});

test('fixed local writer actually writes same SQLite file and IPC proof, then exits and removes only its file',async()=>{
 const f=fixture();try{
  fs.mkdirSync(path.join(f.dataDir,'ipc'));fs.writeFileSync(path.join(f.dataDir,'ipc/unrelated-synthetic.txt'),'preserve');
  const observed=await observeOwnedRestorationWriter(options(f));
  assert.ok(Number.isSafeInteger(observed.pid)&&observed.pid>1);
  if(process.platform==='linux')assert.match(observed.startTime,/^\d+$/);else assert.equal(observed.startTime,null);
  assert.equal(observed.signal,'SIGTERM');assert.equal(observed.exitCode,null);
  assert.match(observed.writeObservedSha256,/^[a-f0-9]{64}$/);
  assert.equal(observed.capability.dbPath,path.join(f.dataDir,'db/messages.db'));
  assert.equal(fs.existsSync(observed.capability.ipcPath),false);
  assert.equal(fs.readFileSync(path.join(f.dataDir,'ipc/unrelated-synthetic.txt'),'utf8'),'preserve');
  assert.deepEqual(f.db.prepare('SELECT * FROM router_state').all().map(row=>({...row})),[{key:'schema_version',value:'73'}]);
  assert.equal(f.db.prepare('SELECT value FROM preserved_fact').get().value,'unchanged');
  assert.throws(()=>process.kill(observed.pid,0),{code:'ESRCH'});
 }finally{f.close();}
});

test('missing database, wrong data root and invalid budget fail before an owned child starts',async()=>{
 const f=fixture();try{
  for(const changed of [{dataDir:f.hostRoot},{timeoutMs:0},{timeoutMs:10001},{runId:'../invalid'}])
   await assert.rejects(observeOwnedRestorationWriter({...options(f),...changed}),/RESTORATION_SUPERVISOR_INPUT_INVALID/);
  f.db.close();f.close=()=>fs.rmSync(f.hostRoot,{recursive:true,force:true});
  fs.unlinkSync(path.join(f.dataDir,'db/messages.db'));
  await assert.rejects(observeOwnedRestorationWriter(options(f)),/RESTORATION_WRITER_DATABASE_REQUIRED/);
  assert.equal(fs.existsSync(path.join(f.dataDir,'ipc')),false);
 }finally{f.close();}
});

test('a child blocked before readiness is stopped on timeout and no receipt or IPC work survives',async()=>{
 const f=fixture();try{
  f.db.exec('BEGIN EXCLUSIVE');
  let failure;
  try{await observeOwnedRestorationWriter({...options(f),timeoutMs:25});}catch(error){failure=error;}
  assert.equal(failure?.code,'RESTORATION_WRITER_TIMEOUT');
  assert.ok(Number.isSafeInteger(failure.ownedWriter?.pid));
  assert.throws(()=>process.kill(failure.ownedWriter.pid,0),{code:'ESRCH'});
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'ipc')),[]);
  f.db.exec('ROLLBACK');
 }finally{f.close();}
});

test('original schema probe failure never leaves a writer or an IPC file to be mistaken for work',async()=>{
 const f=fixture();try{
  f.db.exec('DROP TABLE router_state');
  let failure;try{await observeOwnedRestorationWriter(options(f));}catch(error){failure=error;}
  assert.equal(failure?.code,'RESTORATION_WRITER_EXITED_BEFORE_READY');
  assert.throws(()=>process.kill(failure.ownedWriter.pid,0),{code:'ESRCH'});
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'ipc')),[]);
 }finally{f.close();}
});
