import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createPilotRunLedger,openPilotRunLedger,openRestartLookup,reservePilotModelCall} from './controlled-real-run-budget.mjs';

const runId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function fixture(maxRequests=2){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-budget-'));const file=path.join(dir,'ledger.json');const expiresAt=Date.now()+60000;createPilotRunLedger(file,{runId,maxRequests,expiresAt});return {dir,file,expiresAt,expected:{runId,maxRequests,expiresAt},cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};}
test('a second opener sees a spent call and cannot reset or refund it',()=>{
 const f=fixture();try{
  assert.equal(reservePilotModelCall(f.file,f.expected).reserved,1);
  assert.equal(openPilotRunLedger(f.file,f.expected).reserved,1);
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {reservePilotModelCall} from ${JSON.stringify(pathToFileURL(path.resolve('integrations/native/controlled-real-run-budget.mjs')).href)}; reservePilotModelCall(${JSON.stringify(f.file)},${JSON.stringify(f.expected)});`],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(openPilotRunLedger(f.file,f.expected).reserved,2);
  assert.throws(()=>reservePilotModelCall(f.file,f.expected),/EXHAUSTED/);assert.equal(openPilotRunLedger(f.file,f.expected).reserved,2);
  fs.writeFileSync(f.file,'{"version":1,"reserved":0}');assert.throws(()=>openPilotRunLedger(f.file,f.expected),/UNREADABLE/);assert.equal(fs.readFileSync(f.file,'utf8').includes('"reserved":0'),true);
 }finally{f.cleanup();}
});
test('restart lookup reads the counter and cannot start a runner or spend budget',()=>{
 const f=fixture();try{reservePilotModelCall(f.file,f.expected);const lookup=openRestartLookup(f.file,runId);let started=0,seen;
  assert.equal(lookup.read(()=>{seen=lookup.reserved;return 'persisted';}),'persisted');assert.equal(seen,1);
  assert.throws(()=>lookup.reserve(),/FORBIDDEN/);assert.throws(()=>lookup.startRunner(()=>{started++;}),/FORBIDDEN/);assert.equal(started,0);
  assert.equal(openPilotRunLedger(f.file,f.expected).reserved,1);
 }finally{f.cleanup();}
});
test('held lock and mismatched cap fail closed without granting another allowance',()=>{
 const f=fixture();try{ fs.writeFileSync(f.file+'.lock','held');assert.throws(()=>reservePilotModelCall(f.file,f.expected),/LOCK_HELD/);assert.equal(openPilotRunLedger(f.file,f.expected).reserved,0);
  fs.unlinkSync(f.file+'.lock');assert.throws(()=>reservePilotModelCall(f.file,{...f.expected,maxRequests:8}),/MISMATCH/);assert.equal(openPilotRunLedger(f.file,f.expected).reserved,0);
 }finally{f.cleanup();}
});
