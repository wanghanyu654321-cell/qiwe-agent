import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createFullHostCandidate} from './full-host-candidate.mjs';
import {verifyPreparedNativeSqlite} from './prepare-native-sqlite.mjs';
import {verifyOriginalLinuxSqlite} from './linux-runtime.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const [source,overlay,driver]=process.argv.slice(2);
if(![source,overlay].every(v=>v&&path.isAbsolute(v))||process.platform==='win32'&&(!driver||!path.isAbsolute(driver))||driver&&process.platform!=='win32')throw Error('RECOVERY_ABSOLUTE_SOURCE_OVERLAY_DRIVER_REQUIRED');
if(driver)verifyPreparedNativeSqlite(source,driver);else verifyOriginalLinuxSqlite(source);
const digest=v=>createHash('sha256').update(v).digest('hex'),runId=randomUUID();
const evidenceRoot=path.join(process.env.QIWE_EVIDENCE_ROOT??path.join(project,'.local/t7a-native'),runId);
fs.mkdirSync(evidenceRoot,{recursive:true});
const sourceFiles=['full-host-candidate.mjs','conversation-recovery-overlay.mjs','conversation-overlay.mjs','conversation-execution-overlay.mjs','conversation-execution-db.fragment','verify-recovery-conversation-inventory.mjs','recovery-conversation-inventory.test.mts'];
const sourceHashes=Object.fromEntries(sourceFiles.map(name=>[name,digest(fs.readFileSync(path.join(here,name)))]));
const audit={runId,platform:process.platform,status:'in_progress',scope:'original synthetic DB initializer and composed metadata scanner only; no full host execution or recovery permission',sourceHashes,phases:[]};
const save=()=>fs.writeFileSync(path.join(evidenceRoot,'inventory-audit.json'),JSON.stringify(audit,null,2));save();
try{
 for(const mode of ['legacy','intake','execution']){
  const candidate=await createFullHostCandidate(source,overlay,{conversationIntake:mode!=='legacy',conversationExecution:mode==='execution'});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-recovery-inventory-'));
  try{
   for(const [name,value]of candidate.files){const target=path.join(root,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
   fs.mkdirSync(path.join(root,'tests'));fs.copyFileSync(path.join(here,'recovery-conversation-inventory.test.mts'),path.join(root,'tests/recovery-conversation-inventory.test.mts'));
   fs.writeFileSync(path.join(root,'package.json'),'{"type":"module","private":true}');
   fs.writeFileSync(path.join(root,'vitest.config.mts'),"export default {test:{include:['tests/recovery-conversation-inventory.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
   const dependencies=path.resolve(source,'../node_modules'),target=path.join(root,'node_modules');fs.mkdirSync(target);
   for(const entry of fs.readdirSync(dependencies,{withFileTypes:true})){
    if(['.bin','.vite','.vite-temp'].includes(entry.name)||entry.name==='better-sqlite3'&&driver)continue;
    const from=path.join(dependencies,entry.name),to=path.join(target,entry.name);
    if(entry.isDirectory()||entry.isSymbolicLink())fs.symlinkSync(from,to,process.platform==='win32'?'junction':'dir');else fs.copyFileSync(from,to);
   }
   if(driver)fs.symlinkSync(fs.realpathSync(driver),path.join(target,'better-sqlite3'),process.platform==='win32'?'junction':'dir');
   const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),NODE_ENV:'test',TZ:'UTC',NO_COLOR:'1',WEB_PORT:'0',WEB_SESSION_SECRET:'synthetic-recovery-inventory-only',PLUGIN_AUTO_SCAN:'false',MINICLAW_EXECUTION_BOUNDARY:'member-container-only',MINICLAW_WEB_URL:'http://127.0.0.1:19777',QIWE_RECOVERY_SCHEMA:mode};
   fs.mkdirSync(env.HOME);
   fs.copyFileSync(path.resolve(source,'../tsconfig.json'),path.join(root,'tsconfig.json'));
   const typecheck=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false'],{cwd:root,env,encoding:'utf8',timeout:60000});
   process.stdout.write(typecheck.stdout??'');process.stderr.write(typecheck.stderr??'');
   if(typecheck.error)throw typecheck.error;if(typecheck.status!==0)throw Error('RECOVERY_CANDIDATE_TYPECHECK_FAILED');
   const result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(root,'vitest.config.mts'),'--reporter=dot'],{cwd:root,env,encoding:'utf8',timeout:180000});
   process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
   const executedTestHash=digest(fs.readFileSync(path.join(root,'tests/recovery-conversation-inventory.test.mts')));
   if(executedTestHash!==sourceHashes['recovery-conversation-inventory.test.mts']||sourceFiles.some(name=>digest(fs.readFileSync(path.join(here,name)))!==sourceHashes[name]))throw Error('RECOVERY_SOURCES_CHANGED_DURING_VERIFICATION');
   audit.phases.push({mode,typecheck:typecheck.status,status:result.status,executedTestHash,nativeTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree,composedHashes:candidate.audit.composedHashes,stdout:result.stdout,stderr:result.stderr});save();
   if(result.error)throw result.error;if(result.status!==0)throw Error('RECOVERY_'+mode.toUpperCase()+'_INVENTORY_FAILED');
  }finally{
   const resolved=fs.realpathSync(root);
   if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-recovery-inventory-'))throw Error('RECOVERY_UNSAFE_TEMP_CLEANUP');
   fs.rmSync(resolved,{recursive:true,force:true});
  }
 }
 audit.status='passed';save();
}catch(error){audit.status='failed';audit.error=String(error);save();throw error;}
finally{console.log('RECOVERY_INVENTORY_AUDIT',JSON.stringify({...audit,phases:audit.phases.map(({stdout,stderr,composedHashes,...rest})=>({...rest,composedHashesSha256:digest(JSON.stringify(composedHashes)),dbHash:composedHashes['db.ts'],inventoryHash:composedHashes['appointment-boot-inventory.ts'],schemaHash:composedHashes['appointment-boot-inventory-schema.ts']})),evidenceRoot}));}
