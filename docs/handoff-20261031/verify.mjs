import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export function windowsIncrementalSkip(platform){
 if(platform!=='win32')return '';
 return 'SKIP incremental: Windows node returns EPERM for directory fsync and symlink creation. CONTROLLED_REAL_TRANSPORT_SCOPE in that Windows run is the linux uid and realpath(cwd) gate failing in the test harness when the temp directory is reached through a symlink such as D:\\tmp. Inside the Linux container the same check is fail-closed scope enforcement, not a missing launch switch.';
}
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const names=['controlled-real-container-boundary','controlled-real-container-transport','controlled-real-preload','controlled-real-web','controlled-real-pi-retry','frontagent-controlled-live-entry','frontagent-controlled-live-worker','frontagent-controlled-pilot','frontagent-pilot-restoration','full-host-controlled-real-pilot','full-host-local-docker','real-container-boundary','controlled-real-env-disposition','controlled-real-run-budget','pi-session-recovery','full-host-local-residue'];
const commands=[['incremental',['--test',...names.map(n=>'integrations/native/'+n+'.test.mjs')]],['model',['node_modules/vitest/vitest.mjs','run','tests/native/controlled-real-model.test.ts']],['typecheck',['node_modules/typescript/bin/tsc','--noEmit']],['build',['node_modules/typescript/bin/tsc','-p','tsconfig.build.json']]];
const skip=windowsIncrementalSkip(process.platform);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(skip)console.log(skip);
 fs.mkdirSync(path.join(here,'logs'),{recursive:true});let failed=false;
 for(const [name,args]of commands){
  if(skip&&name==='incremental'){console.log('incremental: SKIP');continue;}
  const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000});const output='Command: node '+args.join(' ')+'\nExit: '+r.status+'\n'+(r.stdout??'')+(r.stderr??'');fs.writeFileSync(path.join(here,'logs','verification-'+name+'.txt'),output.replaceAll('\r\n','\n').replace(/[ \t]+$/gm,'').trimEnd()+'\n');console.log(name+': '+(r.status===0?'PASS':'FAIL'));if(r.status!==0){failed=true;break;}
 }
 process.exitCode=failed?1:0;
}
