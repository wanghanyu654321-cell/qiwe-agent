import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
function failure(code){const error=new Error(code);error.code=code;return error;}
function present(target){try{fs.lstatSync(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function processIdentity(pid){
 const value=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),fields=value.slice(value.lastIndexOf(')')+2).split(' ');
 if(!/^\d+$/.test(fields[19]??''))throw failure('RESTORATION_PROCESS_IDENTITY_UNAVAILABLE');
 return {parent:Number(fields[1]),startTime:fields[19]};
}
function identity(target,directory){
 const stat=fs.lstatSync(target,{bigint:true});
 if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile()))throw failure('RESTORATION_SUPERVISOR_INPUT_INVALID');
 return {path:target,dev:String(stat.dev),ino:String(stat.ino)};
}
function sameIdentity(target,expected,directory=false){const current=identity(target,directory);return current.dev===expected.dev&&current.ino===expected.ino;}
function inputs(options){
 const {hostRoot,dataDir,runId,timeoutMs=5000}=options??{};
 if(typeof hostRoot!=='string'||typeof dataDir!=='string'||!path.isAbsolute(hostRoot)||!path.isAbsolute(dataDir)||
  path.resolve(hostRoot)!==hostRoot||path.resolve(dataDir)!==dataDir||path.dirname(hostRoot)!==fs.realpathSync(os.tmpdir())||
  !path.basename(hostRoot).startsWith('qiwe-full-host-')||dataDir!==path.join(hostRoot,'data')||
  typeof runId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId)||
  !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw failure('RESTORATION_SUPERVISOR_INPUT_INVALID');
 if(fs.realpathSync(hostRoot)!==hostRoot||fs.realpathSync(dataDir)!==dataDir)throw failure('RESTORATION_SUPERVISOR_INPUT_INVALID');
 const host=identity(hostRoot,true),data=identity(dataDir,true),dbPath=path.join(dataDir,'db/messages.db');
 let database;try{database=identity(dbPath,false);}catch{throw failure('RESTORATION_WRITER_DATABASE_REQUIRED');}
 if(fs.realpathSync(dbPath)!==dbPath)throw failure('RESTORATION_WRITER_DATABASE_REQUIRED');
 return {hostRoot,dataDir,runId,timeoutMs,host,data,dbPath,database};
}

// Fixed capability probe, never an Agent/external sender. The same-value UPDATE
// proves write access to the actual original DB; it is not an original-driver
// execution claim. Keep the SQLite handle open until the parent sends SIGTERM.
const writerSource=String.raw`
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const input=JSON.parse(process.argv[1]);
const db=new DatabaseSync(input.dbPath);
db.exec('PRAGMA busy_timeout=10000');
const before=db.prepare("SELECT value FROM router_state WHERE key='schema_version'").get();
if(!before||typeof before.value!=='string'||!/^\d+$/.test(before.value))throw Error('SCHEMA_VERSION_REQUIRED');
db.exec('BEGIN IMMEDIATE');
try{
 const written=db.prepare("UPDATE router_state SET value=? WHERE key='schema_version' AND value=?").run(before.value,before.value);
 if(written.changes!==1||db.prepare("SELECT value FROM router_state WHERE key='schema_version'").get().value!==before.value)throw Error('SAME_VALUE_WRITE_NOT_OBSERVED');
 db.exec('COMMIT');
 const proof={version:1,runId:input.runId,nonce:input.nonce,pid:process.pid,dbPath:input.dbPath,schemaVersion:before.value,updateChanges:Number(written.changes),ipcPath:input.ipcPath};
 const fd=fs.openSync(input.ipcPath,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(proof));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 process.send({kind:'writer-ready',proof});
 setInterval(()=>{},1000);
}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
`;

function bounded(promise,milliseconds,code){
 let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure(code)),milliseconds);})]).finally(()=>clearTimeout(timer));
}
function cleanupProof(ipcPath,expected){
 if(!present(ipcPath))return;
 if(!expected||!sameIdentity(ipcPath,expected))throw failure('RESTORATION_WRITER_PROOF_CLEANUP_UNVERIFIED');
 fs.unlinkSync(ipcPath);
}

/** Local lifecycle evidence only. This export cannot issue a boundary receipt. */
export async function observeOwnedRestorationWriter(options){
 const input=inputs(options),ipcRoot=path.join(input.dataDir,'ipc');
 fs.mkdirSync(ipcRoot,{recursive:true});
 if(fs.realpathSync(ipcRoot)!==ipcRoot)throw failure('RESTORATION_SUPERVISOR_INPUT_INVALID');
 identity(ipcRoot,true);
 const nonce=randomUUID(),ipcPath=path.join(ipcRoot,`.qiwe-owned-writer-${nonce}.json`);
 let child,exitPromise,exited=false,startTime=null,proofIdentity,primaryError;
 try{
  child=spawn(process.execPath,['--no-warnings','-e',writerSource,JSON.stringify({dbPath:input.dbPath,ipcPath,runId:input.runId,nonce})],{
   cwd:input.hostRoot,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:input.hostRoot,TMP:os.tmpdir(),TEMP:os.tmpdir(),NODE_ENV:'test'},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,
  });
  exitPromise=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(exitCode,signal)=>{exited=true;resolve({exitCode,signal});});});
  // Attach rejection immediately, including the case spawn fails before ready.
  exitPromise.catch(()=>{});
  if(!Number.isSafeInteger(child.pid)||child.pid<2)throw failure('RESTORATION_WRITER_SPAWN_FAILED');
  if(process.platform==='linux'){
   const observed=processIdentity(child.pid);if(observed.parent!==process.pid)throw failure('RESTORATION_WRITER_PARENT_CHANGED');startTime=observed.startTime;
  }
  const ready=new Promise((resolve,reject)=>{
   child.once('message',message=>{if(message?.kind!=='writer-ready')reject(failure('RESTORATION_WRITER_PROOF_INVALID'));else resolve(message.proof);});
   child.once('error',()=>reject(failure('RESTORATION_WRITER_SPAWN_FAILED')));
   child.once('exit',()=>reject(failure('RESTORATION_WRITER_EXITED_BEFORE_READY')));
  });
  const message=await bounded(ready,input.timeoutMs,'RESTORATION_WRITER_TIMEOUT');
  proofIdentity=identity(ipcPath,false);
  const raw=fs.readFileSync(ipcPath),proof=JSON.parse(raw.toString('utf8'));
  if(raw.length>4096||JSON.stringify(proof)!==JSON.stringify(message)||proof.version!==1||proof.pid!==child.pid||
   proof.runId!==input.runId||proof.nonce!==nonce||proof.dbPath!==input.dbPath||proof.ipcPath!==ipcPath||
   proof.updateChanges!==1||!/^\d+$/.test(proof.schemaVersion??'')||!sameIdentity(input.dbPath,input.database))throw failure('RESTORATION_WRITER_PROOF_INVALID');
  if(process.platform==='linux'&&processIdentity(child.pid).startTime!==startTime)throw failure('RESTORATION_WRITER_IDENTITY_CHANGED');
  if(!child.kill('SIGTERM'))throw failure('RESTORATION_WRITER_STOP_FAILED');
  const stopped=await bounded(exitPromise,input.timeoutMs,'RESTORATION_WRITER_STOP_TIMEOUT');
  if(stopped.signal!=='SIGTERM')throw failure('RESTORATION_WRITER_UNEXPECTED_EXIT');
  if(process.platform==='linux'&&fs.existsSync(`/proc/${child.pid}/stat`)&&processIdentity(child.pid).startTime===startTime)throw failure('RESTORATION_WRITER_STILL_ALIVE');
  cleanupProof(ipcPath,proofIdentity);proofIdentity=undefined;
  return {pid:child.pid,startTime,...stopped,capability:{dbPath:input.dbPath,ipcPath},writeObservedSha256:sha(raw)};
 }catch(error){primaryError=error;throw error;}
 finally{
  const cleanupErrors=[];
  if(child&&!exited&&Number.isSafeInteger(child.pid)){
   try{
    child.kill('SIGTERM');
    try{await bounded(exitPromise,input.timeoutMs,'RESTORATION_WRITER_STOP_TIMEOUT');}
    catch{child.kill('SIGKILL');await bounded(exitPromise,input.timeoutMs,'RESTORATION_WRITER_CLEANUP_TIMEOUT');}
   }catch(error){cleanupErrors.push(error);}
  }
  if(present(ipcPath)){
   try{
    // On a timeout the child may have exclusively created its file immediately
    // before termination. Its nonce, PID and exact payload still have to match.
    if(!proofIdentity){const proof=JSON.parse(fs.readFileSync(ipcPath,'utf8'));if(proof.nonce!==nonce||proof.pid!==child?.pid)throw failure('RESTORATION_WRITER_PROOF_CLEANUP_UNVERIFIED');proofIdentity=identity(ipcPath,false);}
    cleanupProof(ipcPath,proofIdentity);
   }catch(error){cleanupErrors.push(error);}
  }
  if(primaryError&&child?.pid)primaryError.ownedWriter={pid:child.pid,startTime};
  if(cleanupErrors.length)throw new AggregateError([...(primaryError?[primaryError]:[]),...cleanupErrors],'RESTORATION_WRITER_CLEANUP_FAILED');
 }
}

function linuxSupervisor(scriptPath){
 if(process.platform!=='linux'||process.pid!==1)throw failure('RESTORATION_SUPERVISOR_BOUNDARY_REQUIRED');
 if(typeof scriptPath!=='string'||!path.isAbsolute(scriptPath)||!scriptPath.startsWith('/input/')||fs.realpathSync(scriptPath)!==scriptPath)throw failure('RESTORATION_SUPERVISOR_BOUNDARY_REQUIRED');
 const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>{const [left,right]=line.split(' - '),parts=left.split(' ');return {mount:parts[4],options:parts[5].split(','),type:right.split(' ')[0]};});
 const containing=target=>mounts.filter(row=>target===row.mount||target.startsWith(row.mount==='/'?'/':row.mount+'/')).sort((a,b)=>b.mount.length-a.mount.length)[0];
 const status=fs.readFileSync('/proc/1/status','utf8');
 if(!mounts.some(row=>row.mount==='/'&&row.options.includes('ro'))||!containing(scriptPath)?.options.includes('ro')||
  containing(os.tmpdir())?.type!=='tmpfs'||!/^CapEff:\s+0+$/m.test(status)||!/^NoNewPrivs:\s+1$/m.test(status))throw failure('RESTORATION_SUPERVISOR_BOUNDARY_REQUIRED');
 const modulePath=fileURLToPath(import.meta.url);
 if(!modulePath.startsWith('/input/')||!containing(modulePath)?.options.includes('ro'))throw failure('RESTORATION_SUPERVISOR_BOUNDARY_REQUIRED');
 return {pid:1,startTime:processIdentity(1).startTime,scriptPath,scriptSha256:sha(fs.readFileSync(scriptPath)),modulePath,moduleSha256:sha(fs.readFileSync(modulePath))};
}

/** PID1-only producer. Receipt facts are all observed here, never caller flags. */
export async function createRestorationSupervisorReceipt(options){
 const supervisor=linuxSupervisor(process.argv[1]),input=inputs(options);
 const oldWriter=await observeOwnedRestorationWriter(options);
 if(!sameIdentity(input.hostRoot,input.host,true)||!sameIdentity(input.dataDir,input.data,true)||
  JSON.stringify(linuxSupervisor(process.argv[1]))!==JSON.stringify(supervisor))throw failure('RESTORATION_SUPERVISOR_IDENTITY_CHANGED');
 const namespaces=Object.fromEntries(['pid','net','mnt'].map(name=>[name,fs.readlinkSync(`/proc/1/ns/${name}`)]));
 const receipt={version:1,runId:input.runId,issuedAt:new Date().toISOString(),supervisor,hostRoot:input.host,dataRoot:input.data,namespaces,oldWriters:[oldWriter]};
 const raw=Buffer.from(JSON.stringify(receipt)),receiptPath=path.join(input.hostRoot,`.qiwe-restoration-receipt-${randomUUID()}.json`);
 let writerFd,readerFd,owned;
 try{
  writerFd=fs.openSync(receiptPath,'wx',0o600);owned=identity(receiptPath,false);
  fs.writeFileSync(writerFd,raw);fs.fsyncSync(writerFd);fs.closeSync(writerFd);writerFd=undefined;
  readerFd=fs.openSync(receiptPath,'r');
  if(!sameIdentity(receiptPath,owned)||!fs.readFileSync(readerFd).equals(raw))throw failure('RESTORATION_RECEIPT_CHANGED');
  fs.unlinkSync(receiptPath);
  const stat=fs.fstatSync(readerFd,{bigint:true});
  if(stat.nlink!==0n||stat.size!==BigInt(raw.length))throw failure('RESTORATION_RECEIPT_NOT_UNLINKED');
  let closed=false;const fd=readerFd;readerFd=undefined;
  return {locator:`/proc/1/fd/${fd}`,receipt,close(){if(!closed){fs.closeSync(fd);closed=true;}}};
 }finally{
  if(writerFd!==undefined)fs.closeSync(writerFd);if(readerFd!==undefined)fs.closeSync(readerFd);
  if(present(receiptPath)){if(!owned||!sameIdentity(receiptPath,owned))throw failure('RESTORATION_RECEIPT_CLEANUP_UNVERIFIED');fs.unlinkSync(receiptPath);}
 }
}
