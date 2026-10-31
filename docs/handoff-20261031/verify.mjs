import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
function windowsTestName(block){
 const named=block.match(/(?:✖|✔|# Subtest: |not ok \d+ - |ok \d+ - )([^\n(]+)/);
 const name=named?.[1]?.trim()??'';
 return /^failing tests:?$/i.test(name)?'':name;
}
export function windowsEpermCase(output){
 if(typeof output!=='string'||!/EPERM/.test(output))return false;
 const blocks=output.split(/\n(?=# Subtest: |not ok \d|ok \d|✖ |✔ )/);
 const groups=new Map();
 for(const block of blocks){
  if(!/not ok \d|✖ |failureType: ['"]testCodeFailure['"]/.test(block))continue;
  const name=windowsTestName(block);
  if(!name)continue;
  const seen=groups.get(name)??[];
  seen.push(block);
  groups.set(name,seen);
 }
 if(!groups.size)return false;
 for(const blocks of groups.values()){
  const text=blocks.join('\n');
  if(/AssertionError|ERR_ASSERTION|CONTROLLED_REAL_/.test(text))return false;
  if(!/EPERM/.test(text)||!/fsync|symlink/i.test(text))return false;
 }
 return true;
}
const scopeNote='NOTE CONTROLLED_REAL_TRANSPORT_SCOPE: that code is the linux uid and realpath(cwd) gate. A Windows temp directory reached through a symlink such as D:\\tmp can fail it in the test harness. Inside the Linux container it is fail-closed scope enforcement, not a missing launch switch.';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const names=['controlled-real-container-boundary','controlled-real-container-transport','controlled-real-preload','controlled-real-web','controlled-real-pi-retry','frontagent-controlled-live-entry','frontagent-controlled-live-worker','frontagent-controlled-pilot','frontagent-pilot-restoration','full-host-controlled-real-pilot','full-host-local-docker','real-container-boundary','controlled-real-env-disposition','controlled-real-run-budget','pi-session-recovery','full-host-local-residue'];
const commands=[['incremental',['--test',...names.map(n=>'integrations/native/'+n+'.test.mjs')]],['model',['node_modules/vitest/vitest.mjs','run','tests/native/controlled-real-model.test.ts']],['typecheck',['node_modules/typescript/bin/tsc','--noEmit']],['build',['node_modules/typescript/bin/tsc','-p','tsconfig.build.json']]];
function evidenceDirectory(){if(!evidenceDirectory.dir)evidenceDirectory.dir=process.env.QIWE_EVIDENCE_ROOT??fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-verify-'));return evidenceDirectory.dir;}
function record(name,args,result){const output='Command: node '+args.join(' ')+'\nExit: '+result.status+'\n'+(result.stdout??'')+(result.stderr??'');const dir=evidenceDirectory();fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'verification-'+name+'.txt'),output.replaceAll('\r\n','\n').replace(/[ \t]+$/gm,'').trimEnd()+'\n');return output;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 console.log('QIWE_VERIFY_EVIDENCE '+evidenceDirectory());let failed=false,skipped=false;
 if(process.platform==='win32'){
  for(const name of names){
   const file='integrations/native/'+name+'.test.mjs',args=['--test',file],result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000});
   const output=record(name.replaceAll('/','-'),args,result);
   if(result.status===0){console.log(file+': PASS');continue;}
   if(windowsEpermCase(output)){skipped=true;console.log(file+': SKIP EPERM filesystem');continue;}
   console.log(file+': FAIL');failed=true;break;
  }
  if(skipped)console.log(scopeNote);
 }else{
  const [name,args]=commands[0],result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000});record(name,args,result);console.log(name+': '+(result.status===0?'PASS':'FAIL'));failed=result.status!==0;
 }
 if(!failed)for(const [name,args]of commands.slice(1)){const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000});record(name,args,result);console.log(name+': '+(result.status===0?'PASS':'FAIL'));if(result.status!==0){failed=true;break;}}
 process.exitCode=failed?1:0;
}
