import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import ts from 'typescript';
import {nativeVerificationOptions} from './verification-options.mjs';
import {createFullHostCandidate} from './full-host-candidate.mjs';
import {createRestorationSupervisorReceipt} from './full-host-restoration-supervisor.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const fullHostConversationFlags=process.argv.slice(2).filter(value=>value==='--full-host-conversations');
if(fullHostConversationFlags.length>1)throw Error('Invalid duplicate full host conversation option');
const restorationFlags=process.argv.slice(2).filter(value=>value==='--restoration-scenario');
if(restorationFlags.length>1)throw Error('Invalid duplicate restoration scenario option');
const options={...nativeVerificationOptions(process.argv.slice(2).filter(value=>!['--full-host-conversations','--restoration-scenario'].includes(value))),fullHostConversations:fullHostConversationFlags.length===1,restorationScenario:restorationFlags.length===1},{source,overlay,driver}=options;
if(options.restorationScenario&&(!options.fullHostConversations||process.platform!=='linux'))throw Error('RESTORATION_SCENARIO_REQUIRES_COMPLETE_LINUX_HOST');
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
candidate=await createFullHostCandidate(source,overlay,options.fullHostConversations?{conversationIntake:true,fullHostConversationExecution:true}:undefined);
directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-full-host-'));
 for(const [name,value]of candidate.files){const target=path.join(directory,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 if(options.fullHostConversations&&!options.restorationScenario){
  const legacy=await createFullHostCandidate(source,overlay,{conversationIntake:true,conversationExecution:true});
  for(const [name,value]of legacy.files){const target=path.join(directory,'legacy-src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 }
 fs.mkdirSync(path.join(directory,'tests'));
 if(options.fullHostConversations&&!options.restorationScenario)fs.copyFileSync(path.join(here,'legacy-work-preservation-compatibility.test.mts'),path.join(directory,'tests/legacy-work-preservation-compatibility.test.mts'));
 if(options.restorationScenario)for(const name of ['full-host-restoration-seed.test.mts','full-host-restoration-flow.test.mts','full-host-restoration.fixture.mts','full-host-restoration-isolation.fixture.mts','full-host-restoration-employee.fixture.mts'])fs.copyFileSync(path.join(here,name),path.join(directory,'tests',name));
 fs.copyFileSync(path.join(here,'full-host.test.mts'),path.join(directory,'tests/full-host.test.mts'));
 fs.copyFileSync(path.join(here,'full-host-conversation.fixture.mts'),path.join(directory,'tests/full-host-conversation.fixture.mts'));
 fs.copyFileSync(path.join(here,'full-host-settlement.fixture.mts'),path.join(directory,'tests/full-host-settlement.fixture.mts'));
 fs.copyFileSync(path.join(here,'full-host-result-evidence.fixture.mts'),path.join(directory,'tests/full-host-result-evidence.fixture.mts'));
 if(options.fullHostConversations)for(const name of ['full-host-conversation-queue.test.mts','full-host-notification-fencing.test.mts','full-host-entry-fencing.test.mts','full-host-maintenance-writers.test.mts','legacy-work-preservation.test.mts','full-host-restoration-inline.test.mts','full-host-restoration-metadata.test.mts'])fs.copyFileSync(path.join(here,name),path.join(directory,'tests',name));
 if(options.fullHostConversations){
  for(const name of ['full-host-environment.test.mts','full-host-conversation-wrapper.test.mts'])fs.copyFileSync(path.join(here,name),path.join(directory,'tests',name));
  const emitted=ts.transpileModule(candidate.files.get('index.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const parsed=ts.createSourceFile('index.mjs',emitted,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  fs.writeFileSync(path.join(directory,'src/index-imports.mjs'),parsed.statements.filter(ts.isImportDeclaration).map(node=>node.getText(parsed)).join('\n'));
 }
 fs.copyFileSync(path.join(here,'project-residue.test.mts'),path.join(directory,'tests/project-residue.test.mts'));
 fs.copyFileSync(path.join(here,'queue-recovery.test.mts'),path.join(directory,'tests/queue-recovery.test.mts'));
 fs.copyFileSync(path.join(here,'bot-preparation-native.test.mts'),path.join(directory,'tests/bot-preparation-native.test.mts'));
 fs.copyFileSync(path.join(here,'role-workspace-candidate.test.mts'),path.join(directory,'tests/role-workspace-candidate.test.mts'));
 // Compile only the public test dependency closure. Never load original main/config here.
 fs.mkdirSync(path.join(directory,'test-support'));
 if(options.fullHostConversations){
  const parsed=ts.createSourceFile('index.ts',candidate.files.get('index.ts'),ts.ScriptTarget.Latest,true);
  const wrappers=parsed.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(parsed)==='d3Runner'));
  if(wrappers.length!==1)throw Error('FULL_HOST_WRAPPER_EXTRACTION_CHANGED');
  const extracted=`export function bindGeneratedWrapper(ports:any){const {runContainerAgent,conversationBatchActive,assertConversationBatchCurrent,noteConversationSession,finishConversationBatch,invalidateConversationProjection,logger}=ports;let d5OnCompleted=ports.onCompleted;${wrappers[0].getText(parsed)};return d3Runner;}`;
  fs.writeFileSync(path.join(directory,'test-support/full-host-generated-wrapper.mjs'),ts.transpileModule(extracted,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  const callbacks=[];
  function walk(node){
   if(ts.isCallExpression(node)&&node.expression.getText(parsed)==='setInterval'&&node.arguments[0]){
    const callback=node.arguments[0].getText(parsed);
    if(['deleteExpiredSessions','checkAndExpireSubscriptions','reconcileMonthlyUsage','cleanupOldDailyUsage'].some(marker=>callback.includes(marker)))callbacks.push(callback);
   }
   ts.forEachChild(node,walk);
  }
  walk(parsed);if(callbacks.length!==4)throw Error('FULL_HOST_MAINTENANCE_CALLBACK_EXTRACTION_CHANGED');
  const maintenance=`export function bindMaintenanceCallbacks(ports:any){const {appointmentBootGate,logger,getExpiredSessionIds,invalidateSessionCache,deleteExpiredSessions,checkAndExpireSubscriptions,isBillingEnabled,listUsers,reconcileMonthlyUsage,cleanupOldDailyUsage,cleanupOldBillingAuditLog}=ports;return [${callbacks.join(',\n')}];}`;
  fs.writeFileSync(path.join(directory,'test-support/full-host-maintenance-callbacks.mjs'),ts.transpileModule(maintenance,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 }
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
 compilePublic('workbench-opening');
 compilePublic('wecom-bot-task-store');
 fs.copyFileSync(path.join(here,'role-workspace-overlay.mjs'),path.join(directory,'test-support/role-workspace-overlay.mjs'));
 fs.copyFileSync(path.join(here,'conversation-overlay.mjs'),path.join(directory,'test-support/conversation-overlay.mjs'));
 compilePublic('offline-bot-sdk',path.join(project,'tests/fixtures/offline-bot-sdk.ts'));
 // Test-only observational exports. Original main() call and catch stay intact.
 fs.appendFileSync(path.join(directory,'src/index.ts'),'\nexport { queue as fullHostQueue, appointmentBootGate as fullHostBootGate };\n');
 fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module","private":true}');
 fs.writeFileSync(path.join(directory,'vitest.config.mts'),"export default {test:{include:['tests/*.test.mts'],exclude:['tests/role-workspace-candidate.test.mts','tests/full-host-environment.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 if(options.fullHostConversations)fs.writeFileSync(path.join(directory,'environment.vitest.config.mts'),"export default {test:{include:['tests/full-host-environment.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 fs.writeFileSync(path.join(directory,'role-workspace.vitest.config.mts'),"export default {test:{include:['tests/role-workspace-candidate.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 if(options.restorationScenario)for(const phase of ['seed','flow'])fs.writeFileSync(path.join(directory,`restoration-${phase}.vitest.config.mts`),`export default {test:{include:['tests/full-host-restoration-${phase}.test.mts'],fileParallelism:false,maxWorkers:1,testTimeout:120000,hookTimeout:120000}};`);
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
 env.QIWE_FULL_HOST_CONVERSATIONS=options.fullHostConversations?'1':'0';
 if(options.typecheck){
  fs.copyFileSync(path.resolve(source,'../tsconfig.json'),path.join(directory,'tsconfig.json'));
  const check=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false'],{cwd:directory,env,encoding:'utf8',timeout:60000});
  process.stdout.write(check.stdout??'');process.stderr.write(check.stderr??'');
  if(check.error)throw check.error;if(check.status!==0){process.exitCode=check.status??1;throw Error('FULL_HOST_TYPECHECK_FAILED');}
 }
 let environmentPhase;
 // The restoration scenario has its own fresh seed and two complete mains.
 // Import-order/role preparation regressions run in the ordinary suite.
 if(options.fullHostConversations&&!options.restorationScenario){
  fs.writeFileSync(path.join(directory,'.env'),'MINICLAW_EXECUTION_BOUNDARY=member-container-only\n');
  const {MINICLAW_EXECUTION_BOUNDARY:_explicit,...envOnly}=env;
  envOnly.QIWE_FULL_HOST_ENV_EVIDENCE=path.join(directory,'environment-evidence.json');
  const result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,'environment.vitest.config.mts')],{cwd:directory,env:envOnly,encoding:'utf8',timeout:180000});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  environmentPhase={status:result.status,stdout:result.stdout,stderr:result.stderr,evidence:fs.existsSync(envOnly.QIWE_FULL_HOST_ENV_EVIDENCE)?JSON.parse(fs.readFileSync(envOnly.QIWE_FULL_HOST_ENV_EVIDENCE,'utf8')):null};
  writeAudit({...candidate.audit,environmentPhase,status:result.status===0?'in_progress':'failed'});
  if(result.error)throw result.error;if(result.status!==0)throw Error('FULL_HOST_ENVIRONMENT_IMPORT_ORDER_FAILED');
  fs.unlinkSync(path.join(directory,'.env'));
 }
 let roleWorkspacePhase;
 if(!options.restorationScenario){
 const roleWorkspaceTest=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,'role-workspace.vitest.config.mts')],{cwd:directory,env,encoding:'utf8',timeout:180000});
 process.stdout.write(roleWorkspaceTest.stdout??'');process.stderr.write(roleWorkspaceTest.stderr??'');
 roleWorkspacePhase={status:roleWorkspaceTest.status,stdout:roleWorkspaceTest.stdout,stderr:roleWorkspaceTest.stderr};
 writeAudit({...candidate.audit,platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF',status:roleWorkspaceTest.status===0?'in_progress':'failed',roleWorkspacePhase});
 if(roleWorkspaceTest.error)throw roleWorkspaceTest.error;
 if(roleWorkspaceTest.status!==0){process.exitCode=roleWorkspaceTest.status??1;throw Error('ROLE_WORKSPACE_CANDIDATE_TEST_FAILED');}
 }
 let restorationSeedPhase;
 if(options.restorationScenario){
  const seeded=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,'restoration-seed.vitest.config.mts')],{cwd:directory,env,encoding:'utf8',timeout:180000});
  process.stdout.write(seeded.stdout??'');process.stderr.write(seeded.stderr??'');
  restorationSeedPhase={status:seeded.status,stdout:seeded.stdout,stderr:seeded.stderr};
  writeAudit({...candidate.audit,restorationSeedPhase,status:seeded.status===0?'in_progress':'failed'});
  if(seeded.error)throw seeded.error;if(seeded.status!==0)throw Error('RESTORATION_SEED_FAILED');
 }
 const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const conversationInstrumentation=options.fullHostConversations?{
  fullHostConversationFixtureHash:hashFile(path.join(directory,'tests/full-host-conversation.fixture.mts')),
  fullHostSettlementFixtureHash:hashFile(path.join(directory,'tests/full-host-settlement.fixture.mts')),
  fullHostResultEvidenceFixtureHash:hashFile(path.join(directory,'tests/full-host-result-evidence.fixture.mts')),
  resultEvidenceOverlayHash:hashFile(path.join(here,'conversation-result-evidence-overlay.mjs')),
  resultEvidenceFragmentHash:hashFile(path.join(here,'conversation-result-evidence.fragment')),
  fullHostConversationQueueTestHash:hashFile(path.join(directory,'tests/full-host-conversation-queue.test.mts')),
  fullHostNotificationFencingTestHash:hashFile(path.join(directory,'tests/full-host-notification-fencing.test.mts')),
  fullHostMaintenanceWritersTestHash:hashFile(path.join(directory,'tests/full-host-maintenance-writers.test.mts')),
  fullHostMaintenanceCallbacksHash:hashFile(path.join(directory,'test-support/full-host-maintenance-callbacks.mjs')),
  fullHostExecutionFencesOverlayHash:hashFile(path.join(here,'full-host-execution-fences-overlay.mjs')),
  fullHostEnvironmentTestHash:hashFile(path.join(directory,'tests/full-host-environment.test.mts')),
  fullHostImportSliceHash:hashFile(path.join(directory,'src/index-imports.mjs')),
  fullHostWrapperTestHash:hashFile(path.join(directory,'tests/full-host-conversation-wrapper.test.mts')),
  fullHostGeneratedWrapperHash:hashFile(path.join(directory,'test-support/full-host-generated-wrapper.mjs')),
  environmentPhase,
  conversationPortHash:hashFile(path.join(directory,'test-support/conversation-overlay.mjs')),
  executionOverlayHash:hashFile(path.join(here,'conversation-execution-overlay.mjs')),
  executionDbFragmentHash:hashFile(path.join(here,'conversation-execution-db.fragment')),
  executionIndexFragmentHash:hashFile(path.join(here,'conversation-execution-index.fragment')),
  fullHostConversationIndexFragmentHash:hashFile(path.join(here,'full-host-conversation-index.fragment')),
 }:{};
 const instrumentation={executedIndexHash:hashFile(path.join(directory,'src/index.ts')),testHash:hashFile(path.join(directory,'tests/full-host.test.mts')),projectResidueTestHash:hashFile(path.join(directory,'tests/project-residue.test.mts')),queueRecoveryTestHash:hashFile(path.join(directory,'tests/queue-recovery.test.mts')),botPreparationNativeTestHash:hashFile(path.join(directory,'tests/bot-preparation-native.test.mts')),roleWorkspaceCandidateTestHash:hashFile(path.join(directory,'tests/role-workspace-candidate.test.mts')),roleWorkspaceOverlayHash:hashFile(path.join(directory,'test-support/role-workspace-overlay.mjs')),roleWorkspaceConfigHash:hashFile(path.join(directory,'role-workspace.vitest.config.mts')),publicSupportHashes,configHash:hashFile(path.join(directory,'vitest.config.mts')),verifierHash:hashFile(fileURLToPath(import.meta.url)),candidateBuilderHash:hashFile(path.join(here,'full-host-candidate.mjs'))};
 const phases=[];
 if(options.fullHostConversations){
  conversationInstrumentation.restorationSources=Object.fromEntries(fs.readdirSync(here).filter(name=>/^(?:full-host-(?:restoration|entry-fencing|recovery-authority|execution-fences)|legacy-work-preservation)/.test(name)).map(name=>[name,hashFile(path.join(here,name))]));
  conversationInstrumentation.restorationScenario=options.restorationScenario;
  if(options.restorationScenario){conversationInstrumentation.restorationSeedPhase=restorationSeedPhase;conversationInstrumentation.restorationFlowConfigHash=hashFile(path.join(directory,'restoration-flow.vitest.config.mts'));}
 }
 for(const phase of ['boot','restart']){
  env.QIWE_FULL_HOST_PHASE=phase;env.QIWE_FULL_HOST_EVIDENCE=path.join(directory,'evidence-'+phase+'.json');
  env.QIWE_RESTORATION_FLOW_EVIDENCE=env.QIWE_FULL_HOST_EVIDENCE;
  const supervisor=options.restorationScenario?await createRestorationSupervisorReceipt({hostRoot:directory,dataDir:path.join(directory,'data'),runId:runId+'-'+phase,timeoutMs:5000}):undefined;
  if(supervisor)env.QIWE_RESTORATION_RECEIPT=supervisor.locator;
  console.log('FULL_HOST_PHASE',JSON.stringify({runId,phase,status:'starting'}));
  let result;
  try{result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,options.restorationScenario?'restoration-flow.vitest.config.mts':'vitest.config.mts')],{cwd:directory,env,encoding:'utf8',timeout:180000});}finally{supervisor?.close();}
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  const evidence=fs.existsSync(env.QIWE_FULL_HOST_EVIDENCE)?JSON.parse(fs.readFileSync(env.QIWE_FULL_HOST_EVIDENCE,'utf8')):null;
  phases.push({phase,status:result.status,evidence,stdout:result.stdout,stderr:result.stderr});
  writeAudit({...candidate.audit,instrumentation:{...instrumentation,...conversationInstrumentation},platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF',status:result.status===0?'in_progress':'failed',roleWorkspacePhase,phases});
  if(result.error)throw result.error;
  if(result.status!==0){process.exitCode=result.status??1;break;}
 }
 if(!process.exitCode){
  if(phases.length!==2||phases.some(phase=>!phase.evidence)||phases[0].evidence.processId===phases[1].evidence.processId)throw Error('FULL_HOST_DISTINCT_PROCESS_RESTART_NOT_PROVEN');
  const evidence={runId,status:'passed',restart:'two separate OS worker processes share exact original synthetic SQLite snapshot',phases:phases.map(({phase,evidence})=>({phase,...evidence}))};
  writeAudit({...candidate.audit,instrumentation:{...instrumentation,...conversationInstrumentation},platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF',status:'passed',roleWorkspacePhase,phases});
  // Linux tmpfs audit files disappear with the container. Persist enough exact
  // source/instrumentation identity in stdout to bind the retained host log.
  console.log('FULL_HOST_AUDIT_HASHES',JSON.stringify({runId,nativeTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree,composedHashesSha256:createHash('sha256').update(JSON.stringify(candidate.audit.composedHashes)).digest('hex'),instrumentation:{...instrumentation,...conversationInstrumentation},platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF'}));
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
