import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('./verify-full-host.mjs',import.meta.url));
test('verify-full-host prints a coded error on an early failure',()=>{
 const evidence=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-full-host-exit-'));
 const missing=path.join(evidence,'missing');
 const child=spawnSync(process.execPath,[script,missing,'--host-overlay',missing,'--skill-root',missing,'--full-host-conversations','--restoration-scenario','--restoration-real-container','--frontagent-existing-state',missing,'--typecheck','--controlled-real-pilot'],{encoding:'utf8',env:{PATH:process.env.PATH??'',QIWE_CONTROLLED_REAL_PILOT:'1',HOME:evidence,TMPDIR:evidence,QIWE_EVIDENCE_ROOT:evidence},timeout:30000});
 try{
  assert.notEqual(child.status,0);
  assert.match(child.stderr,/^(?:[A-Z0-9_]{1,80})$/m);
  assert.equal(child.stderr.includes('miniclaw_session='),false);
 }finally{fs.rmSync(evidence,{recursive:true,force:true});}
});
