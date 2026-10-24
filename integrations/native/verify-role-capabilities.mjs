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
import {d4OriginalHashes,d4SkillHashes} from './role-capabilities-overlay.mjs';
import {prepareOriginalPiRunner} from './role-capabilities-runner.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const args=process.argv.slice(2),skillFlag=args.indexOf('--skill-root');
if(args.filter(value=>value==='--skill-root').length!==1||skillFlag===args.length-1)throw Error('D4_SKILL_ROOT_REQUIRED_ONCE');
const skillRoot=args.splice(skillFlag,2)[1];
if(!skillRoot||!path.isAbsolute(skillRoot))throw Error('D4_SKILL_ROOT_ABSOLUTE_REQUIRED');
if(args.some(value=>value.startsWith('--'))||args.length!==(process.platform==='win32'?3:2))throw Error('D4_ARGUMENTS_INVALID');
const [source,overlay,driver]=args;
if(![source,overlay].every(value=>value&&path.isAbsolute(value))||
  (process.platform==='win32'&&(!driver||!path.isAbsolute(driver)))||
  (driver&&(!path.isAbsolute(driver)||process.platform!=='win32')))
  throw Error('CONVERSATION_ABSOLUTE_SOURCE_OVERLAY_DRIVER_INVALID');
if(driver)verifyPreparedNativeSqlite(source,driver);else verifyOriginalLinuxSqlite(source);
const candidate=await createFullHostCandidate(source,overlay,{conversationIntake:true,conversationExecution:true});
if(candidate.audit.conversationIntake!==true||!candidate.files.get('db.ts')?.includes('CREATE TABLE IF NOT EXISTS wecom_conversation_receipts'))throw Error('CONVERSATION_CANDIDATE_OPT_IN_MISSING');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-conversation-'));
const runId=randomUUID(),evidenceRoot=path.join(process.env.QIWE_EVIDENCE_ROOT??path.join(project,'.local/d4-native'),runId);
fs.mkdirSync(evidenceRoot,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const {runnerTarget,runnerTree,runnerSourceHashes,toolFile,entryFile}=prepareOriginalPiRunner({source,root,skillRoot});
 for(const [name,value]of candidate.files){const target=path.join(root,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 fs.appendFileSync(path.join(root,'src/container-runner.ts'),'\nexport {resolveAgentProfileUserSkillsPolicy,resolveAgentProfileMcpPolicy};\n');
 fs.mkdirSync(path.join(root,'tests'));
 fs.copyFileSync(path.join(here,'role-capabilities-candidate.test.mts'),path.join(root,'tests/role-capabilities-candidate.test.mts'));
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
 fs.writeFileSync(path.join(root,'vitest.config.mts'),"export default {test:{include:['tests/role-capabilities-candidate.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
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
 const runnerCheck=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false'],{cwd:runnerTarget,env,encoding:'utf8',timeout:60000});
 process.stdout.write(runnerCheck.stdout??'');process.stderr.write(runnerCheck.stderr??'');
 if(runnerCheck.error)throw runnerCheck.error;if(runnerCheck.status!==0)throw Error('D4_RUNNER_TYPECHECK_FAILED');
 const phases=[];
 for(const phase of ['boot']){
  const file=path.join(evidenceRoot,phase+'.json');
  const result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(root,'vitest.config.mts'),'--reporter=dot'],{cwd:root,env:{...env,QIWE_CONVERSATION_PHASE:phase,QIWE_CONVERSATION_EVIDENCE:file},encoding:'utf8',timeout:180000});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  phases.push({phase,testHash:digest(fs.readFileSync(path.join(root,'tests/role-capabilities-candidate.test.mts'))),status:result.status,processEvidence:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error('CONVERSATION_'+phase.toUpperCase()+'_FAILED');
 }

 if(!phases.every(phase=>phase.processEvidence))throw Error('D4_PROCESS_EVIDENCE_MISSING');
 // The host test-only export is distinct from the ordinary D3 composition.
 candidate.audit.composedHashes['container-runner.ts']=digest(fs.readFileSync(path.join(root,'src/container-runner.ts')));
 const audit={runId,status:'local-fragment-passed',scope:'Same SDK request through D1/D2/D3 original queue, Profile resolver and Pi runTurn; deterministic model I/O; test composition substitutes process launch and mounts. No production, full-host, live authorization, external MCP or real model proof.',runnerTree,runnerSourceHashes,originalHashes:d4OriginalHashes,skillHashes:d4SkillHashes,candidateToolHash:digest(fs.readFileSync(toolFile)),candidateEntryHash:digest(fs.readFileSync(entryFile)),sourceTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree,composedHashes:candidate.audit.composedHashes,executionSourceHashes:Object.fromEntries(['role-capabilities-overlay.mjs','role-capabilities-runner.mjs','verify-role-capabilities.mjs','role-capabilities-candidate.test.mts'].map(name=>[name,digest(fs.readFileSync(path.join(here,name)))])),typecheck:{host:check.status,runner:runnerCheck.status},publicHashes,phases};
 fs.writeFileSync(path.join(evidenceRoot,'audit.json'),JSON.stringify(audit,null,2));
 console.log('D4_AUDIT',JSON.stringify({runId,evidenceRoot,...audit}));
}finally{
 const resolved=fs.realpathSync(root),temporary=fs.realpathSync(os.tmpdir());
 if(path.dirname(resolved)!==temporary||!path.basename(resolved).startsWith('qiwe-conversation-'))throw Error('CONVERSATION_UNSAFE_TEMP_CLEANUP');
 fs.rmSync(resolved,{recursive:true,force:true});
}
