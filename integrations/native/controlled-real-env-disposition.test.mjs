import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {disposeConfirmedNewPilotEnv,witnessPilotEnvAbsence} from './controlled-real-env-disposition.mjs';

const secret='SUPER_SECRET_KEY';
const exited={state:'exited',exitCode:0,signal:null};
function root(){const data=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-env-'));return {data,cleanup:()=>fs.rmSync(data,{recursive:true,force:true})};}
function place(data,folder,text){const file=path.join(data,'env',folder,'default','main','env');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{mode:0o600});return file;}
test('confirmed exit removes only the new exact env file and leaves siblings',()=>{
 const f=root();try{const witness=witnessPilotEnvAbsence(f.data,'marketing');assert.equal(witness.status,'absent');
  const file=place(f.data,'marketing',secret+'\n');const sibling=path.join(path.dirname(file),'other');fs.writeFileSync(sibling,'keep');
  const other=place(f.data,'other-role',secret+'\n');
  const result=disposeConfirmedNewPilotEnv(f.data,'marketing',witness,exited);
  assert.deepEqual(result,{disposed:true,reason:'new_run_file_removed',extraEntries:1});
  assert.equal(fs.existsSync(file),false);assert.equal(fs.readFileSync(sibling,'utf8'),'keep');assert.equal(fs.readFileSync(other,'utf8'),secret+'\n');
  assert.equal(JSON.stringify(result).includes(secret),false);
 }finally{f.cleanup();}
});
test('original file, fixed secret-free text, symlink and hard link are not deleted',()=>{
 const f=root();try{
  const original=place(f.data,'marketing',secret+'\n');const kept=witnessPilotEnvAbsence(f.data,'marketing');
  assert.equal(disposeConfirmedNewPilotEnv(f.data,'marketing',kept,exited).reason,'original_file_retained');
  assert.equal(fs.readFileSync(original,'utf8'),secret+'\n');
  fs.rmSync(path.join(f.data,'env'),{recursive:true});
  const fresh=witnessPilotEnvAbsence(f.data,'marketing');
  const fixed=place(f.data,'marketing',"MINICLAW_CLAUDE_ENDPOINT_KIND='official'\nMINICLAW_AGENT_MCP_POLICY='disabled'\n");
  assert.equal(disposeConfirmedNewPilotEnv(f.data,'marketing',fresh,exited).reason,'fixed_secret_free_retained');
  assert.equal(fs.existsSync(fixed),true);
  fs.rmSync(fixed);fs.symlinkSync('/tmp',fixed);
  assert.throws(()=>disposeConfirmedNewPilotEnv(f.data,'marketing',fresh,exited),/PILOT_ENV_PATH_UNSAFE/);assert.equal(fs.lstatSync(fixed).isSymbolicLink(),true);
  fs.unlinkSync(fixed);fs.writeFileSync(fixed,secret);fs.linkSync(fixed,fixed+'.link');
  assert.throws(()=>disposeConfirmedNewPilotEnv(f.data,'marketing',fresh,exited),/PILOT_ENV_PATH_UNSAFE/);assert.equal(fs.existsSync(fixed),true);
 }finally{f.cleanup();}
});
test('unknown executor, forged witness and swapped parent do not unlink or rerun',()=>{
 const f=root();try{const witness=witnessPilotEnvAbsence(f.data,'marketing');const file=place(f.data,'marketing',secret);
  let rerun=0;assert.throws(()=>disposeConfirmedNewPilotEnv(f.data,'marketing',witness,{state:'unknown',exitCode:null,signal:null,rerun:()=>{rerun++;}}),/UNCONFIRMED/);
  assert.throws(()=>disposeConfirmedNewPilotEnv(f.data,'marketing',{...witness},exited),/UNCONFIRMED/);
  assert.equal(fs.readFileSync(file,'utf8'),secret);assert.equal(rerun,0);
  fs.rmSync(path.join(f.data,'env'),{recursive:true});
  const parent=path.join(f.data,'env','marketing','default','main');fs.mkdirSync(parent,{recursive:true});
  const pinned=witnessPilotEnvAbsence(f.data,'marketing');const stable=path.join(parent,'env');fs.writeFileSync(stable,secret);
  const moved=parent+'-moved';fs.renameSync(parent,moved);fs.mkdirSync(parent);const swapped=path.join(parent,'env');fs.writeFileSync(swapped,secret);
  assert.throws(()=>disposeConfirmedNewPilotEnv(f.data,'marketing',pinned,exited),/UNCONFIRMED|PATH_UNSAFE/);
  assert.equal(fs.readFileSync(swapped,'utf8'),secret);assert.equal(fs.readFileSync(path.join(moved,'env'),'utf8'),secret);
 }finally{f.cleanup();}
});
test('witness identity is frozen and a missing file after confirmed exit is not an error',()=>{
 const f=root();try{const witness=witnessPilotEnvAbsence(f.data,'marketing');assert.equal(Object.isFrozen(witness),true);
  assert.throws(()=>{witness.status='preexisting';});
  assert.deepEqual(disposeConfirmedNewPilotEnv(f.data,'marketing',witness,exited),{disposed:false,reason:'still_absent',extraEntries:0});
  assert.throws(()=>witnessPilotEnvAbsence(f.data,'../escape'),/INVALID/);
 }finally{f.cleanup();}
});
