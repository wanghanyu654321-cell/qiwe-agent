import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {createFullHostCandidate} from './full-host-candidate.mjs';
import {verifyPreparedNativeSqlite} from './prepare-native-sqlite.mjs';
import {verifyOriginalLinuxSqlite} from './linux-runtime.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const [source,overlay,driver]=process.argv.slice(2);
const migration=process.env.QIWE_CONVERSATION_MIGRATION==='1';
if(![source,overlay].every(value=>value&&path.isAbsolute(value))||
  (process.platform==='win32'&&(!driver||!path.isAbsolute(driver)))||
  (driver&&(!path.isAbsolute(driver)||process.platform!=='win32')))
  throw Error('CONVERSATION_ABSOLUTE_SOURCE_OVERLAY_DRIVER_INVALID');
if(driver)verifyPreparedNativeSqlite(source,driver);else verifyOriginalLinuxSqlite(source);
const candidate=await createFullHostCandidate(source,overlay,{conversationIntake:true,conversationExecution:true});
if(candidate.audit.conversationIntake!==true||!candidate.files.get('db.ts')?.includes('CREATE TABLE IF NOT EXISTS wecom_conversation_receipts'))throw Error('CONVERSATION_CANDIDATE_OPT_IN_MISSING');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-conversation-'));
const runId=randomUUID(),evidenceRoot=path.join(process.env.QIWE_EVIDENCE_ROOT??path.join(project,'.local/d3-native'),runId);
fs.mkdirSync(evidenceRoot,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 for(const [name,value]of candidate.files){const target=path.join(root,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 fs.mkdirSync(path.join(root,'tests'));
 fs.copyFileSync(path.join(here,'conversation-execution-candidate.test.mts'),path.join(root,'tests/conversation-execution-candidate.test.mts'));
 fs.mkdirSync(path.join(root,'test-support'));
 const publicHashes={};
 function compilePublic(name,sourceFile=path.join(project,'src/role-eval',name+'.ts')){
  if(publicHashes[name])return;
  const bytes=fs.readFileSync(sourceFile);
  publicHashes[name]={sourceHash:digest(bytes)};
  let output=ts.transpileModule(bytes.toString('utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  output=output.replace(/from (['"])(\.\/([a-z0-9-]+)\.js)\1/g,(_all,quote,_relative,dependency)=>{compilePublic(dependency);return 'from '+quote+'./'+dependency+'.mjs'+quote;});
  for(const dependency of ['@wecom/aibot-node-sdk','adm-zip'])output=output.replaceAll("from '"+dependency+"'",'from '+JSON.stringify(import.meta.resolve(dependency))).replaceAll('from "'+dependency+'"','from '+JSON.stringify(import.meta.resolve(dependency)));
  publicHashes[name].compiledHash=digest(output);
  fs.writeFileSync(path.join(root,'test-support',name+'.mjs'),output);
 }
 for(const name of ['workbench-opening','wecom-bot-assembly','wecom-bot-sdk','manager-store','wecom-bot-task-store'])compilePublic(name);
 compilePublic('offline-bot-sdk',path.join(project,'tests/fixtures/offline-bot-sdk.ts'));
 for(const name of ['role-workspace-overlay.mjs','conversation-overlay.mjs'])fs.copyFileSync(path.join(here,name),path.join(root,'test-support',name));
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module","private":true}');
 fs.writeFileSync(path.join(root,'vitest.config.mts'),"export default {test:{include:['tests/conversation-execution-candidate.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 const dependencies=path.resolve(source,'../node_modules'),target=path.join(root,'node_modules');fs.mkdirSync(target);
 for(const entry of fs.readdirSync(dependencies,{withFileTypes:true})){
  if(['.bin','.vite','.vite-temp'].includes(entry.name)||entry.name==='better-sqlite3'&&driver)continue;
  const from=path.join(dependencies,entry.name),to=path.join(target,entry.name);
  if(entry.isDirectory()||entry.isSymbolicLink())fs.symlinkSync(from,to,process.platform==='win32'?'junction':'dir');else fs.copyFileSync(from,to);
 }
 if(driver)fs.symlinkSync(fs.realpathSync(driver),path.join(target,'better-sqlite3'),process.platform==='win32'?'junction':'dir');
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),NODE_ENV:'test',TZ:'UTC',NO_COLOR:'1',WEB_PORT:'0',WEB_SESSION_SECRET:'synthetic-conversation-secret-fixed-for-isolation-only',PLUGIN_AUTO_SCAN:'false',MINICLAW_EXECUTION_BOUNDARY:'member-container-only',MINICLAW_WEB_URL:'http://127.0.0.1:19777'};
 fs.mkdirSync(env.HOME);
 fs.copyFileSync(path.resolve(source,'../tsconfig.json'),path.join(root,'tsconfig.json'));
 const check=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false'],{cwd:root,env,encoding:'utf8',timeout:60000});
 process.stdout.write(check.stdout??'');process.stderr.write(check.stderr??'');
 if(check.error)throw check.error;if(check.status!==0)throw Error('CONVERSATION_CANDIDATE_TYPECHECK_FAILED');
 const phases=[];
 const migrationSeed=migration?await createFullHostCandidate(source,overlay,{conversationIntake:true}):undefined;
 for(const phase of ['boot','restart']){
  if(migration){
   const selected=phase==='boot'?migrationSeed:candidate;
   for(const [name,value]of selected.files)fs.writeFileSync(path.join(root,'src',name),value);
   fs.copyFileSync(path.join(here,phase==='boot'?'conversation-candidate.test.mts':'conversation-execution-migration.test.mts'),path.join(root,'tests/conversation-execution-candidate.test.mts'));
  }
  const file=path.join(evidenceRoot,phase+'.json');
  const result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(root,'vitest.config.mts'),'--reporter=dot'],{cwd:root,env:{...env,QIWE_CONVERSATION_PHASE:phase,QIWE_CONVERSATION_EVIDENCE:file},encoding:'utf8',timeout:180000});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  phases.push({phase,testHash:digest(fs.readFileSync(path.join(root,'tests/conversation-execution-candidate.test.mts'))),status:result.status,processEvidence:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error('CONVERSATION_'+phase.toUpperCase()+'_FAILED');
 }
 if(!phases.every(p=>p.processEvidence)||phases[0].processEvidence.processId===phases[1].processEvidence.processId)throw Error('CONVERSATION_DISTINCT_PROCESS_RESTART_NOT_PROVEN');
 const audit={runId,status:'passed',migration,migrationSeedHashes:migrationSeed?.audit.composedHashes,conversationExecution:candidate.audit.conversationExecution,composedHashes:candidate.audit.composedHashes,executionSourceHashes:Object.fromEntries(['conversation-execution-overlay.mjs','conversation-execution-index.fragment','conversation-execution-db.fragment','verify-conversation-execution.mjs'].map(name=>[name,digest(fs.readFileSync(path.join(here,name)))])),conversationIntake:candidate.audit.conversationIntake,scope:candidate.audit.scope,typecheck:{status:check.status},sourceTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree,dbHash:digest(candidate.files.get('db.ts')),testHash:digest(fs.readFileSync(path.join(root,'tests/conversation-execution-candidate.test.mts'))),overlayHash:digest(fs.readFileSync(path.join(root,'test-support/conversation-overlay.mjs'))),publicHashes,phases};
 fs.writeFileSync(path.join(evidenceRoot,'audit.json'),JSON.stringify(audit,null,2));
 console.log('CONVERSATION_AUDIT',JSON.stringify({runId,evidenceRoot,...audit}));
}finally{
 const resolved=fs.realpathSync(root),temporary=fs.realpathSync(os.tmpdir());
 if(path.dirname(resolved)!==temporary||!path.basename(resolved).startsWith('qiwe-conversation-'))throw Error('CONVERSATION_UNSAFE_TEMP_CLEANUP');
 fs.rmSync(resolved,{recursive:true,force:true});
}
