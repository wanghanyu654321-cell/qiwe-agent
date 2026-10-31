import fs from 'node:fs';
import path from 'node:path';

const fail=code=>{throw Error(code);};
const runIdOk=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value??'');
function parse(raw,runId){
 let value;try{value=JSON.parse(raw);}catch{fail('PILOT_BUDGET_UNREADABLE');}
 if(!value||value.version!==1||value.runId!==runId||!runIdOk(runId)||!Number.isSafeInteger(value.maxRequests)||value.maxRequests<1||value.maxRequests>8||!Number.isSafeInteger(value.reserved)||value.reserved<0||value.reserved>value.maxRequests||!Number.isSafeInteger(value.expiresAt))fail('PILOT_BUDGET_UNREADABLE');
 return value;
}
function readLedger(file,runId){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>4096)fail('PILOT_BUDGET_UNREADABLE');return parse(fs.readFileSync(fd,'utf8'),runId);}
 finally{fs.closeSync(fd);}
}
export function createPilotRunLedger(file,input){
 if(typeof file!=='string'||!path.isAbsolute(file)||!runIdOk(input?.runId)||!Number.isSafeInteger(input.maxRequests)||input.maxRequests<1||input.maxRequests>8||!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=Date.now())fail('PILOT_BUDGET_INVALID');
 const body=JSON.stringify({version:1,runId:input.runId,maxRequests:input.maxRequests,reserved:0,expiresAt:input.expiresAt});
 const fd=fs.openSync(file,'wx',0o600);
 try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return Object.freeze(parse(body,input.runId));
}
export function openPilotRunLedger(file,expected){
 const value=readLedger(file,expected?.runId);
 if(value.maxRequests!==expected.maxRequests||value.expiresAt!==expected.expiresAt)fail('PILOT_BUDGET_MISMATCH');
 return Object.freeze({...value});
}
export function reservePilotModelCall(file,expected){
 const lock=file+'.lock';let lockFd;try{lockFd=fs.openSync(lock,'wx',0o600);}catch{fail('PILOT_BUDGET_LOCK_HELD');}
 try{
  const value=readLedger(file,expected.runId);
  if(value.maxRequests!==expected.maxRequests||value.expiresAt!==expected.expiresAt)fail('PILOT_BUDGET_MISMATCH');
  if(Date.now()>=value.expiresAt||value.reserved>=value.maxRequests)fail('PILOT_BUDGET_EXHAUSTED');
  const next={...value,reserved:value.reserved+1};const body=JSON.stringify(next);
  const fd=fs.openSync(file,'r+');
  try{fs.ftruncateSync(fd,0);fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return Object.freeze(next);
 }finally{fs.closeSync(lockFd);fs.unlinkSync(lock);}
}
/** Restart lookup can read the durable counter and cannot spend it or start a runner. */
export function openRestartLookup(file,runId){
 const value=readLedger(file,runId);
 return Object.freeze({reserved:value.reserved,maxRequests:value.maxRequests,expiresAt:value.expiresAt,
  read(fn){if(typeof fn!=='function')fail('PILOT_RESTART_LOOKUP_INVALID');return fn();},
  reserve(){fail('PILOT_RESTART_BUDGET_FORBIDDEN');},
  startRunner(){fail('PILOT_RESTART_RUNNER_FORBIDDEN');}});
}
