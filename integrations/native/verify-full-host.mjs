import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import ts from 'typescript';
import {nativeVerificationOptions} from './verification-options.mjs';
import {createFullHostCandidate} from './full-host-candidate.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const options=nativeVerificationOptions(process.argv.slice(2)),{source,overlay,driver}=options;
const runId=new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+randomUUID();
const evidenceRoot=path.join(process.env.QIWE_EVIDENCE_ROOT??path.join(project,'.local/t7d'),runId);
fs.mkdirSync(evidenceRoot,{recursive:true});
const writeAudit=value=>fs.writeFileSync(path.join(evidenceRoot,'full-host-audit.json'),JSON.stringify({runId,...value},null,2));
writeAudit({status:'preparing',events:[]});
console.log('FULL_HOST_RUN',JSON.stringify({runId,evidenceRoot,status:'preparing'}));
let candidate,directory;
try{
if(!overlay||options.unpatched)throw Error('FULL_HOST_EXPLICIT_OVERLAY_REQUIRED');
if(driver){const {verifyPreparedNativeSqlite}=await import('./prepare-native-sqlite.mjs');verifyPreparedNativeSqlite(source,driver);}
else{const {verifyOriginalLinuxSqlite}=await import('./linux-runtime.mjs');verifyOriginalLinuxSqlite(source);}
candidate=await createFullHostCandidate(source,overlay);
directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-full-host-'));
 for(const [name,value]of candidate.files){const target=path.join(directory,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 fs.mkdirSync(path.join(directory,'tests'));
 fs.copyFileSync(path.join(here,'full-host.test.mts'),path.join(directory,'tests/full-host.test.mts'));
 fs.copyFileSync(path.join(here,'project-residue.test.mts'),path.join(directory,'tests/project-residue.test.mts'));
 fs.copyFileSync(path.join(here,'queue-recovery.test.mts'),path.join(directory,'tests/queue-recovery.test.mts'));
 fs.copyFileSync(path.join(here,'bot-preparation-native.test.mts'),path.join(directory,'tests/bot-preparation-native.test.mts'));
 // Compile only the public test dependency closure. Never load original main/config here.
 fs.mkdirSync(path.join(directory,'test-support'));
 const publicSupportHashes={};
 function compilePublic(name,sourceFile=path.join(project,'src/role-eval',name+'.ts')){
  if(Object.hasOwn(publicSupportHashes,name))return;
  if(!/^[a-z0-9-]+$/.test(name))throw Error('FULL_HOST_INVALID_PUBLIC_SUPPORT_MODULE');
  const bytes=fs.readFileSync(sourceFile),sourceHash=createHash('sha256').update(bytes).digest('hex');
  publicSupportHashes[name]={sourceHash};
  let compiled=ts.transpileModule(bytes.toString('utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  compiled=compiled.replace(/from (['"])(\.\/([a-z0-9-]+)\.js)\1/g,(_all,quote,_relative,dependency)=>{
   compilePublic(dependency);return 'from '+quote+'./'+dependency+'.mjs'+quote;
  });
  for(const dependency of ['@wecom/aibot-node-sdk','adm-zip'])
   compiled=compiled.replaceAll("from '"+dependency+"'",'from '+JSON.stringify(import.meta.resolve(dependency))).replaceAll('from "'+dependency+'"','from '+JSON.stringify(import.meta.resolve(dependency)));
  publicSupportHashes[name].compiledHash=createHash('sha256').update(compiled).digest('hex');
  fs.writeFileSync(path.join(directory,'test-support',name+'.mjs'),compiled);
 }
 for(const name of ['wecom-bot-preparation','wecom-bot-assembly','wecom-bot-sdk','workbench-access','manager-store'])compilePublic(name);
 compilePublic('offline-bot-sdk',path.join(project,'tests/fixtures/offline-bot-sdk.ts'));
 // Test-only observational exports. Original main() call and catch stay intact.
 fs.appendFileSync(path.join(directory,'src/index.ts'),'\nexport { queue as fullHostQueue, appointmentBootGate as fullHostBootGate };\n');
 fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module","private":true}');
 fs.writeFileSync(path.join(directory,'vitest.config.mts'),"export default {test:{include:['tests/*.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 const dependencies=path.resolve(source,'../node_modules'),target=path.join(directory,'node_modules');
 fs.mkdirSync(target);
 for(const entry of fs.readdirSync(dependencies,{withFileTypes:true})){
  if(['.bin','.vite','.vite-temp'].includes(entry.name)||entry.name==='better-sqlite3'&&driver)continue;
  const from=path.join(dependencies,entry.name),to=path.join(target,entry.name);
  if(entry.isDirectory()||entry.isSymbolicLink())fs.symlinkSync(from,to,process.platform==='win32'?'junction':'dir');else fs.copyFileSync(from,to);
 }
 if(driver)fs.symlinkSync(fs.realpathSync(driver),path.join(target,'better-sqlite3'),process.platform==='win32'?'junction':'dir');
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:directory,TMP:directory,HOME:path.join(directory,'home'),USERPROFILE:path.join(directory,'home'),NODE_ENV:'test',TZ:'UTC',NO_COLOR:'1',WEB_PORT:'0',WEB_SESSION_SECRET:'synthetic-full-host-secret-fixed-for-isolation-only',PLUGIN_AUTO_SCAN:'false',MINICLAW_EXECUTION_BOUNDARY:'member-container-only',MINICLAW_WEB_URL:'http://127.0.0.1:19777',QIWE_FULL_HOST_EVIDENCE:path.join(directory,'evidence.json'),QIWE_FULL_HOST_SNAPSHOT:path.join(directory,'before-snapshot.json')};
 fs.mkdirSync(env.HOME);
 if(options.typecheck){
  fs.copyFileSync(path.resolve(source,'../tsconfig.json'),path.join(directory,'tsconfig.json'));
  const check=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false'],{cwd:directory,env,encoding:'utf8',timeout:60000});
  process.stdout.write(check.stdout??'');process.stderr.write(check.stderr??'');
  if(check.error)throw check.error;if(check.status!==0){process.exitCode=check.status??1;throw Error('FULL_HOST_TYPECHECK_FAILED');}
 }
 const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const instrumentation={executedIndexHash:hashFile(path.join(directory,'src/index.ts')),testHash:hashFile(path.join(directory,'tests/full-host.test.mts')),projectResidueTestHash:hashFile(path.join(directory,'tests/project-residue.test.mts')),queueRecoveryTestHash:hashFile(path.join(directory,'tests/queue-recovery.test.mts')),botPreparationNativeTestHash:hashFile(path.join(directory,'tests/bot-preparation-native.test.mts')),publicSupportHashes,configHash:hashFile(path.join(directory,'vitest.config.mts')),verifierHash:hashFile(fileURLToPath(import.meta.url)),candidateBuilderHash:hashFile(path.join(here,'full-host-candidate.mjs'))};
 const phases=[];
 for(const phase of ['boot','restart']){
  env.QIWE_FULL_HOST_PHASE=phase;env.QIWE_FULL_HOST_EVIDENCE=path.join(directory,'evidence-'+phase+'.json');
  console.log('FULL_HOST_PHASE',JSON.stringify({runId,phase,status:'starting'}));
  const result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,'vitest.config.mts')],{cwd:directory,env,encoding:'utf8',timeout:180000});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  const evidence=fs.existsSync(env.QIWE_FULL_HOST_EVIDENCE)?JSON.parse(fs.readFileSync(env.QIWE_FULL_HOST_EVIDENCE,'utf8')):null;
  phases.push({phase,status:result.status,evidence,stdout:result.stdout,stderr:result.stderr});
  writeAudit({...candidate.audit,instrumentation,platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF',status:result.status===0?'in_progress':'failed',phases});
  if(result.error)throw result.error;
  if(result.status!==0){process.exitCode=result.status??1;break;}
 }
 if(!process.exitCode){
  if(phases.length!==2||phases.some(phase=>!phase.evidence)||phases[0].evidence.processId===phases[1].evidence.processId)throw Error('FULL_HOST_DISTINCT_PROCESS_RESTART_NOT_PROVEN');
  const evidence={runId,status:'passed',restart:'two separate OS worker processes share exact original synthetic SQLite snapshot',phases:phases.map(({phase,evidence})=>({phase,...evidence}))};
  writeAudit({...candidate.audit,instrumentation,platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF',status:'passed',phases});
  // Linux tmpfs audit files disappear with the container. Persist enough exact
  // source/instrumentation identity in stdout to bind the retained host log.
  console.log('FULL_HOST_AUDIT_HASHES',JSON.stringify({runId,nativeTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree,composedHashesSha256:createHash('sha256').update(JSON.stringify(candidate.audit.composedHashes)).digest('hex'),instrumentation,platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF'}));
  fs.writeFileSync(path.join(evidenceRoot,'full-host-evidence.json'),JSON.stringify(evidence,null,2));console.log('FULL_HOST_EVIDENCE',JSON.stringify(evidence));
 }
}catch(error){writeAudit({...JSON.parse(fs.readFileSync(path.join(evidenceRoot,'full-host-audit.json'),'utf8')),...candidate?.audit,status:'failed',error:String(error)});throw error;
}finally{
 if(directory){
 const resolved=fs.realpathSync(directory);
 if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-full-host-'))throw Error('FULL_HOST_UNSAFE_TEMP_CLEANUP');
 fs.rmSync(resolved,{recursive:true,force:true});
 }
}
