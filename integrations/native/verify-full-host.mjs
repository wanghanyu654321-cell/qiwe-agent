import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
function reportFullHostExit(error){
 if(reportFullHostExit.reported)return;
 reportFullHostExit.reported=true;
 const message=typeof error?.message==='string'?error.message:'';
 const matched=/^([A-Z0-9_]{1,80})(?:[:\s]+([\s\S]*))?$/.exec(message);
 const code=matched?matched[1]:'FULL_HOST_FAILED';
 console.error(code);
 if(typeof error?.step==='string'&&/^[a-z0-9-]{1,40}$/.test(error.step))console.error(error.step);
 const detail=(matched?matched[2]:message).replace(/[\r\n]+/g,' ').slice(0,300).replace(/(?:api[_-]?key|token|secret|password|adminCookie|miniclaw_session)\s*[:=]\s*\S+/gi,'[redacted]');
 if(detail&&detail!==code)console.error(detail);
 else if(!matched)console.error(/^[A-Za-z][A-Za-z0-9_]*$/.test(error?.name??'')?error.name:'Error');
}
process.on('uncaughtException',error=>{reportFullHostExit(error);process.exit(1);});
process.on('unhandledRejection',error=>{reportFullHostExit(error);process.exit(1);});
if(process.argv.slice(2).includes('--isolated-synthetic')){
 const {runIsolatedSyntheticFormalPath}=await import('./isolated-synthetic-pilot.mjs');
 try{
  const result=await runIsolatedSyntheticFormalPath({args:process.argv.slice(2),env:process.env});
  console.log(JSON.stringify({status:result.status,order:result.order,restart:result.restart,reserve:result.reserve,disposed:result.disposed,reserved:result.reserved}));
  fs.rmSync(result.root,{recursive:true,force:true});
 }catch(error){
  const code=typeof error?.message==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'ISOLATED_SYNTHETIC_FAILED';
  console.error(code);process.exitCode=1;
 }
 process.exit(process.exitCode??0);
}
const {nativeVerificationOptions}=await import('./verification-options.mjs');
const {createFullHostCandidate}=await import('./full-host-candidate.mjs');
const {createRestorationSupervisorReceipt}=await import('./full-host-restoration-supervisor.mjs');
const {prepareOriginalPiRunner}=await import('./role-capabilities-runner.mjs');
const {d4OriginalHashes,d4SkillHashes}=await import('./role-capabilities-overlay.mjs');
const {applyFullHostPiDrain,applyFullHostPiAbort}=await import('./full-host-restoration-pi-overlay.mjs');
const {verifyOriginalShellImage,prepareOriginalShellCandidate}=await import('./original-shell.mjs');
const {cleanupOwnedContainers}=await import('./real-container-cleanup.mjs');
const {prepareExistingFrontagentState,parseExistingFrontagentStateOption,disableExistingPilotPluginScan,restrictExistingPilotSessionKey,restrictExistingPilotSettings}=await import('./frontagent-existing-state.ts');
const {originalProductWeb}=await import('./local-pilot-host.mjs');
const {restrictPilotWebLoopback}=await import('./controlled-real-web.mjs');
const {validateControlledRealPilotScope}=await import('./full-host-local-docker.mjs');
const {createPilotRunLedger,openRestartLookup}=await import('./controlled-real-run-budget.mjs');
const {disableControlledRealPiRetries}=await import('./controlled-real-pi-retry.mjs');
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const existingInput=parseExistingFrontagentStateOption(process.argv.slice(2));
const inputArgs=existingInput.args,piFlags=inputArgs.filter(value=>value==='--restoration-pi-scenario');
const liveFlags=inputArgs.filter(value=>value==='--controlled-real-pilot');
if(liveFlags.length>1)throw Error('CONTROLLED_REAL_DUPLICATE_OPTION');
const realFlags=inputArgs.filter(value=>value==='--restoration-real-container');
const c4Flags=inputArgs.filter(value=>value==='--c4-synthetic-case'),c4Index=inputArgs.indexOf('--c4-synthetic-case');
const c4SyntheticCase=c4Index>=0?inputArgs.splice(c4Index,2)[1]:undefined;
if(c4Flags.length>1||c4Flags.length&&(!['grounded','missing-evidence'].includes(c4SyntheticCase)||realFlags.length!==1))throw Error('Invalid C4 synthetic case option');
if(realFlags.length>1||realFlags.length&&piFlags.length)throw Error('Invalid restoration real container option');
if(piFlags.length>1)throw Error('Invalid duplicate restoration Pi scenario option');
const skillFlags=inputArgs.filter(value=>value==='--skill-root'),skillIndex=inputArgs.indexOf('--skill-root');
if(skillFlags.length>1)throw Error('Invalid duplicate skill root');
const skillRoot=skillIndex>=0?inputArgs.splice(skillIndex,2)[1]:undefined;
if(piFlags.length+realFlags.length!==Number(!!skillRoot)||skillRoot&&!path.isAbsolute(skillRoot))throw Error('RESTORATION_PI_ABSOLUTE_SKILL_ROOT_REQUIRED');
const fullHostConversationFlags=process.argv.slice(2).filter(value=>value==='--full-host-conversations');
if(fullHostConversationFlags.length>1)throw Error('Invalid duplicate full host conversation option');
const restorationFlags=process.argv.slice(2).filter(value=>value==='--restoration-scenario');
if(restorationFlags.length>1)throw Error('Invalid duplicate restoration scenario option');
const options={...nativeVerificationOptions(inputArgs.filter(value=>!['--full-host-conversations','--restoration-scenario','--restoration-pi-scenario','--restoration-real-container','--controlled-real-pilot'].includes(value))),fullHostConversations:fullHostConversationFlags.length===1,restorationScenario:restorationFlags.length===1,restorationPiScenario:piFlags.length===1,restorationRealContainer:realFlags.length===1,controlledRealPilot:liveFlags.length===1,c4SyntheticCase,frontagentExistingInput:existingInput.inputRoot},{source,overlay,driver}=options;
if(options.controlledRealPilot&&(!options.restorationRealContainer||!options.restorationScenario||!options.fullHostConversations||!options.frontagentExistingInput||options.c4SyntheticCase||process.platform!=='linux'||process.env.QIWE_CONTROLLED_REAL_PILOT!=='1'))throw Error('CONTROLLED_REAL_EXPLICIT_EXISTING_LINUX_HOST_REQUIRED');
if(options.restorationRealContainer&&!options.restorationScenario)throw Error('RESTORATION_REAL_CONTAINER_REQUIRES_RESTORATION');
if(options.restorationRealContainer)process.env.QIWE_RESTORATION_REAL_CONTAINER='1';
if(options.restorationPiScenario&&!options.restorationScenario)throw Error('RESTORATION_PI_REQUIRES_RESTORATION_SCENARIO');
if(options.restorationScenario&&(!options.fullHostConversations||process.platform!=='linux'))throw Error('RESTORATION_SCENARIO_REQUIRES_COMPLETE_LINUX_HOST');
const runId=new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+randomUUID();
const evidenceRoot=path.join(process.env.QIWE_EVIDENCE_ROOT??path.join(project,'.local/t7d'),runId);
const {loadVerifierTypescript}=await import('./full-host-typescript.mjs');
let ts;try{ts=await loadVerifierTypescript();}catch(error){console.error(error?.message==='FULL_HOST_TYPESCRIPT_UNAVAILABLE'?error.message:'FULL_HOST_TYPESCRIPT_UNAVAILABLE');process.exit(1);}
fs.mkdirSync(evidenceRoot,{recursive:true});
let candidate,directory,ownedManifest,frontagentExistingState;
const writeAudit=value=>fs.writeFileSync(path.join(evidenceRoot,'full-host-audit.json'),JSON.stringify({runId,...value,...(frontagentExistingState?{frontagentExistingState:frontagentExistingState.audit}:{})},null,2));
writeAudit({status:'preparing',events:[]});
console.log('FULL_HOST_RUN',JSON.stringify({runId,evidenceRoot,status:'preparing'}));
const mark=(step,phase)=>console.log('FULL_HOST_STEP',JSON.stringify({step,phase}));
try{
if(!overlay||options.unpatched)throw Error('FULL_HOST_EXPLICIT_OVERLAY_REQUIRED');
mark('sqlite','start');
if(driver){const {verifyPreparedNativeSqlite}=await import('./prepare-native-sqlite.mjs');verifyPreparedNativeSqlite(source,driver);}
else{const {verifyOriginalLinuxSqlite}=await import('./linux-runtime.mjs');verifyOriginalLinuxSqlite(source);}
mark('sqlite','done');
mark('candidate','start');
candidate=await createFullHostCandidate(source,overlay,options.fullHostConversations?{conversationIntake:true,fullHostConversationExecution:true}:undefined);
mark('candidate','done');
mark('retained-volume','start');
directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-full-host-'));
mark('retained-volume','done');
 if(options.frontagentExistingInput){
  mark('existing-state','start');
  frontagentExistingState=prepareExistingFrontagentState({inputRoot:options.frontagentExistingInput,hostRoot:directory});
  frontagentExistingState.audit.localSessionKeyMode=restrictExistingPilotSessionKey(directory);
  writeAudit({status:'preparing',events:['local_session_key_permissions']});
  frontagentExistingState.audit.localPluginScan=disableExistingPilotPluginScan(directory);
  writeAudit({status:'preparing',events:['local_plugin_scan_configuration'],frontagentExistingState:frontagentExistingState.audit});
  frontagentExistingState.audit.localSettingsMode=restrictExistingPilotSettings(directory);
  writeAudit({status:'preparing',events:['local_settings_permissions']});
  let web=originalProductWeb(candidate.files.get('web.ts'),frontagentExistingState.ownerId,{codeRoot:frontagentExistingState.codeRoot,jobRoot:frontagentExistingState.jobRoot});
  if(options.controlledRealPilot)web=restrictPilotWebLoopback(web);
  candidate.files.set('web.ts',web);candidate.audit.composedHashes['web.ts']=createHash('sha256').update(web).digest('hex');
  mark('existing-state','done');
 }
 mark('pi-runner','start');
 const piRunner=options.restorationPiScenario||options.restorationRealContainer?prepareOriginalPiRunner({source,root:directory,skillRoot,trueMain:options.restorationRealContainer}):undefined;
 if(piRunner)fs.writeFileSync(piRunner.entryFile,applyFullHostPiDrain(fs.readFileSync(piRunner.entryFile,'utf8')));
 if(piRunner){const runtimeFile=path.join(piRunner.runnerTarget,'src/runtime/pi/pi-runner.ts');fs.writeFileSync(runtimeFile,applyFullHostPiAbort(fs.readFileSync(runtimeFile,'utf8')));}
 if(options.controlledRealPilot){const runtime=path.join(piRunner.runnerTarget,'src/runtime/pi/pi-runtime.ts');fs.writeFileSync(runtime,disableControlledRealPiRetries(fs.readFileSync(runtime,'utf8')));}
 mark('pi-runner','done');
 let originalShell;
 if(options.restorationRealContainer){
  ownedManifest=path.join(directory,'owned-containers.txt');
  mark('docker-preflight','start');
  originalShell=await verifyOriginalShellImage({source,buildInput:'/qiwe-control/build-input.json',image:process.env.QIWE_LOCAL_DOCKER_IMAGE,docker:'/qiwe-control/docker',endpoint:'unix:///qiwe-control/docker.sock',runId:process.env.QIWE_LOCAL_DOCKER_RUN_ID,manifest:ownedManifest,runnerHashes:piRunner.runnerSourceHashes});
  mark('docker-preflight','done');
  if(options.controlledRealPilot){
   fs.writeFileSync(piRunner.entryFile,"await (await import('/verification/controlled-real-preload.mjs' as string)).installControlledRealModelFetch();\n"+fs.readFileSync(piRunner.entryFile,'utf8'));
   for(const name of ['controlled-real-preload.mjs','controlled-real-model.ts'])fs.copyFileSync(path.join(here,name),path.join(directory,name));
  }else prepareOriginalShellCandidate(piRunner);
  const hotRoot=path.join(directory,'container/agent-runner');fs.mkdirSync(hotRoot,{recursive:true});
  for(const name of ['src','prompts'])fs.cpSync(path.join(piRunner.runnerTarget,name),path.join(hotRoot,name),{recursive:true});
  fs.copyFileSync(path.join(here,'real-container-provider.mjs'),path.join(directory,'real-container-provider.mjs'));
 }
 for(const [name,value]of candidate.files){const target=path.join(directory,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 if(piRunner)fs.appendFileSync(path.join(directory,'src/container-runner.ts'),'\nexport {resolveAgentProfileUserSkillsPolicy};\n');
 if(options.fullHostConversations&&!options.restorationScenario){
  const legacy=await createFullHostCandidate(source,overlay,{conversationIntake:true,conversationExecution:true});
  for(const [name,value]of legacy.files){const target=path.join(directory,'legacy-src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 }
 fs.mkdirSync(path.join(directory,'tests'));
 if(options.fullHostConversations&&!options.restorationScenario)fs.copyFileSync(path.join(here,'legacy-work-preservation-compatibility.test.mts'),path.join(directory,'tests/legacy-work-preservation-compatibility.test.mts'));
 if(options.restorationScenario)for(const name of [...(options.frontagentExistingInput?['frontagent-existing-flow.test.mts']:['full-host-restoration-seed.test.mts','full-host-restoration-flow.test.mts']),'full-host-restoration.fixture.mts','full-host-restoration-isolation.fixture.mts','full-host-restoration-employee.fixture.mts','full-host-local-container.fixture.mts','real-container-boundary.mjs'])fs.copyFileSync(path.join(here,name),path.join(directory,'tests',name));
 if(options.restorationScenario)for(const name of ['full-host-restoration-pi.fixture.mts','full-host-restoration-pi-scenario.fixture.mts'])fs.copyFileSync(path.join(here,name),path.join(directory,'tests',name));
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
 for(const name of ['wecom-bot-pilot','wecom-bot-preparation','wecom-bot-assembly','wecom-bot-sdk','workbench-access','manager-store'])compilePublic(name);
 compilePublic('workbench-opening');
 compilePublic('wecom-bot-task-store');
 if(options.frontagentExistingInput)for(const name of ['wecom-bot-bindings','native-bot-identity','wecom-bot-context'])compilePublic(name);
 fs.copyFileSync(path.join(here,'role-workspace-overlay.mjs'),path.join(directory,'test-support/role-workspace-overlay.mjs'));
 fs.copyFileSync(path.join(here,'conversation-overlay.mjs'),path.join(directory,'test-support/conversation-overlay.mjs'));
 if(options.controlledRealPilot)for(const name of ['frontagent-controlled-pilot.mjs','frontagent-pilot-restoration.mjs','frontagent-controlled-live-worker.mjs','frontagent-controlled-live-entry.mjs','controlled-real-container-transport.mjs','real-container-boundary.mjs','full-host-local-docker.mjs'])fs.copyFileSync(path.join(here,name),path.join(directory,'test-support',name));
 compilePublic('offline-bot-sdk',path.join(project,'tests/fixtures/offline-bot-sdk.ts'));
 // Test-only observational exports. Original main() call and catch stay intact.
 fs.appendFileSync(path.join(directory,'src/index.ts'),'\nexport { queue as fullHostQueue, appointmentBootGate as fullHostBootGate };\n');
 fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module","private":true}');
 fs.writeFileSync(path.join(directory,'vitest.config.mts'),"export default {test:{include:['tests/*.test.mts'],exclude:['tests/role-workspace-candidate.test.mts','tests/full-host-environment.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 if(options.fullHostConversations)fs.writeFileSync(path.join(directory,'environment.vitest.config.mts'),"export default {test:{include:['tests/full-host-environment.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 fs.writeFileSync(path.join(directory,'role-workspace.vitest.config.mts'),"export default {test:{include:['tests/role-workspace-candidate.test.mts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}};");
 if(options.restorationScenario)for(const phase of options.frontagentExistingInput?['flow']:['seed','flow'])fs.writeFileSync(path.join(directory,`restoration-${phase}.vitest.config.mts`),`export default {test:{include:['tests/${options.frontagentExistingInput?'frontagent-existing-flow':'full-host-restoration-'+phase}.test.mts'],fileParallelism:false,maxWorkers:1,testTimeout:${options.restorationRealContainer?300000:120000},hookTimeout:120000}};`);
 const dependencies=path.resolve(source,'../node_modules'),target=path.join(directory,'node_modules');
 fs.mkdirSync(target);
 for(const entry of fs.readdirSync(dependencies,{withFileTypes:true})){
  if(['.bin','.vite','.vite-temp'].includes(entry.name)||entry.name==='better-sqlite3'&&driver)continue;
  const from=path.join(dependencies,entry.name),to=path.join(target,entry.name);
  if(entry.isDirectory()||entry.isSymbolicLink())fs.symlinkSync(from,to,process.platform==='win32'?'junction':'dir');else fs.copyFileSync(from,to);
 }
 if(driver)fs.symlinkSync(fs.realpathSync(driver),path.join(target,'better-sqlite3'),process.platform==='win32'?'junction':'dir');
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:directory,TMP:directory,HOME:path.join(directory,'home'),USERPROFILE:path.join(directory,'home'),NODE_ENV:'test',TZ:'UTC',NO_COLOR:'1',WEB_PORT:'0',WEB_SESSION_SECRET:'synthetic-full-host-secret-fixed-for-isolation-only',PLUGIN_AUTO_SCAN:'false',MINICLAW_EXECUTION_BOUNDARY:'member-container-only',MINICLAW_WEB_URL:'http://127.0.0.1:19777',QIWE_FULL_HOST_EVIDENCE:path.join(directory,'evidence.json'),QIWE_FULL_HOST_SNAPSHOT:path.join(directory,'before-snapshot.json')};
 if(options.frontagentExistingInput){
  delete env.WEB_SESSION_SECRET;
  env.QIWE_FRONTAGENT_EXISTING_INPUT=options.frontagentExistingInput;
  env.QIWE_FRONTAGENT_EXISTING_FOLDER=frontagentExistingState.containerPrefix.slice('miniclaw-'.length,-1);
  env.MINICLAW_WEB_URL='http://127.0.0.1:39130';env.CORS_ALLOW_LOCALHOST='false';env.CORS_ALLOWED_ORIGINS='http://127.0.0.1:39130';
  env.ALLOW_LEGACY_UNSIGNED_COOKIE='false';env.TRUST_PROXY='false';
  // Reuse only the deterministic fake-provider three-skill protocol; this run remains R3 existing-state, not C4.
  if(!options.controlledRealPilot)env.QIWE_C4_SYNTHETIC_CASE='grounded';
 }
 fs.mkdirSync(env.HOME);
 env.QIWE_FULL_HOST_CONVERSATIONS=options.fullHostConversations?'1':'0';
 env.QIWE_RESTORATION_PI=options.restorationPiScenario?'1':'0';
 if(options.restorationRealContainer){
  env.QIWE_RESTORATION_REAL_CONTAINER='1';
  if(c4SyntheticCase)env.QIWE_C4_SYNTHETIC_CASE=c4SyntheticCase;
  for(const key of ['QIWE_LOCAL_DOCKER_RUN_ID','QIWE_LOCAL_DOCKER_VOLUME','QIWE_LOCAL_DOCKER_HOST','QIWE_LOCAL_DOCKER_IMAGE','QIWE_LOCAL_DOCKER_DRIVER_IMAGE'])env[key]=process.env[key];
  env.MINICLAW_CONTAINER_IMAGE=process.env.QIWE_LOCAL_DOCKER_IMAGE;env.QIWE_REAL_CONTAINER_OWNED_MANIFEST=ownedManifest;
  env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL=JSON.stringify(Object.fromEntries(['verified','image','entrypoint','piVersion','files'].map(key=>[key,originalShell[key]])));
  if(options.controlledRealPilot){
   env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL=JSON.stringify(Object.fromEntries(['verified','image','entrypoint','piVersion','piAiVersions','files'].map(key=>[key,originalShell[key]])));
   env.QIWE_CONTROLLED_REAL_PILOT='1';env.QIWE_LOCAL_DOCKER_NETWORK=process.env.QIWE_LOCAL_DOCKER_NETWORK;
   env.WEB_PORT='39130';
  }
 }
 if(piRunner){
  const check=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false'],{cwd:piRunner.runnerTarget,env,encoding:'utf8',timeout:60000});
  process.stdout.write(check.stdout??'');process.stderr.write(check.stderr??'');
  if(check.error)throw check.error;if(check.status!==0)throw Error('RESTORATION_PI_RUNNER_TYPECHECK_FAILED');
 }
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
 if(options.restorationScenario&&!options.frontagentExistingInput){
  const seeded=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,'restoration-seed.vitest.config.mts')],{cwd:directory,env,encoding:'utf8',timeout:180000});
  process.stdout.write(seeded.stdout??'');process.stderr.write(seeded.stderr??'');
  restorationSeedPhase={status:seeded.status,stdout:seeded.stdout,stderr:seeded.stderr};
  writeAudit({...candidate.audit,restorationSeedPhase,status:seeded.status===0?'in_progress':'failed'});
  if(seeded.error)throw seeded.error;if(seeded.status!==0)throw Error('RESTORATION_SEED_FAILED');
 }
 const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const conversationInstrumentation=options.fullHostConversations?{
  ...(piRunner?{piRunner:{runnerTree:piRunner.runnerTree,runnerSourceHashes:piRunner.runnerSourceHashes,originalHashes:d4OriginalHashes,skillHashes:d4SkillHashes,preparationHash:hashFile(path.join(here,'role-capabilities-runner.mjs')),candidateToolHash:hashFile(piRunner.toolFile),candidateEntryHash:hashFile(piRunner.entryFile),candidateRuntimeHash:hashFile(path.join(piRunner.runnerTarget,'src/runtime/pi/pi-runner.ts')),candidateHostRunnerHash:hashFile(path.join(directory,'src/container-runner.ts'))}}:{}),
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
 if(frontagentExistingState)instrumentation.frontagentExistingState={...frontagentExistingState.audit,helperHash:hashFile(path.join(here,'frontagent-existing-state.ts')),flowTestHash:hashFile(path.join(directory,'tests/frontagent-existing-flow.test.mts')),webAdapterHash:hashFile(path.join(here,'local-pilot-host.mjs'))};
 if(options.restorationRealContainer)instrumentation.localDocker={originalShell,runId:process.env.QIWE_LOCAL_DOCKER_RUN_ID,fixtureHash:hashFile(path.join(directory,'tests/full-host-local-container.fixture.mts')),providerHash:hashFile(path.join(directory,'real-container-provider.mjs')),admissionHash:hashFile(path.join(directory,'tests/real-container-boundary.mjs')),helperHash:hashFile(path.join(directory,'src/full-host-local-docker.mjs')),limitations:options.controlledRealPilot?['Local controlled real pilot; not production','Network is not an operating-system-level domain allowlist']:['Controlled local Desktop daemon; concurrent independent Docker administrators are outside this proof','Deterministic ModelRuntime I/O is not evidence of model semantic quality','No production, external message, external model, or deployment']};
 const phases=[];
 if(options.fullHostConversations){
  conversationInstrumentation.restorationSources=Object.fromEntries(fs.readdirSync(here).filter(name=>/^(?:full-host-(?:restoration|entry-fencing|recovery-authority|execution-fences)|legacy-work-preservation)/.test(name)).map(name=>[name,hashFile(path.join(here,name))]));
  conversationInstrumentation.restorationScenario=options.restorationScenario;
  if(options.restorationScenario){conversationInstrumentation.restorationSeedPhase=restorationSeedPhase;conversationInstrumentation.restorationFlowConfigHash=hashFile(path.join(directory,'restoration-flow.vitest.config.mts'));}
 }
 if(options.controlledRealPilot){
  const deadline=Number(process.env.QIWE_PILOT_EXPIRES_AT),scope=validateControlledRealPilotScope({mode:'controlled-real-pilot',environment:'local-test',runId:process.env.QIWE_LOCAL_DOCKER_RUN_ID,expiresAt:deadline,networkName:process.env.QIWE_LOCAL_DOCKER_NETWORK},process.env.QIWE_LOCAL_DOCKER_RUN_ID);
  if(deadline>Date.now()+1800000)throw Error('CONTROLLED_REAL_DURATION_INVALID');
  for(const [name]of candidate.files)if(name.endsWith('.ts')&&!name.endsWith('.d.ts')){
   const target=path.join(directory,'src',name.replace(/\.ts$/,'.js'));
   fs.writeFileSync(target,ts.transpileModule(fs.readFileSync(path.join(directory,'src',name),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  }
  env.QIWE_CONTROLLED_REAL_SCOPE=JSON.stringify(scope);
  // The durable model ledger stays on the supervisor host, outside every
  // runner mount. QIWE_PILOT_MODEL_LEDGER is deliberately not forwarded.
  delete env.QIWE_PILOT_MODEL_LEDGER;
  const ledgerPath=path.join(evidenceRoot,'pilot-model-ledger.json');
  createPilotRunLedger(ledgerPath,{runId:process.env.QIWE_LOCAL_DOCKER_RUN_ID,maxRequests:8,expiresAt:deadline});
  const supervisor=await createRestorationSupervisorReceipt({hostRoot:directory,dataDir:path.join(directory,'data'),runId:runId+'-live',timeoutMs:5000,controlledRealPilot:scope});
  env.QIWE_RESTORATION_RECEIPT=supervisor.locator;
  console.log('FULL_HOST_PHASE',JSON.stringify({runId,phase:'controlled-real',status:'starting'}));
  let result;
  try{result=spawnSync(process.execPath,[path.join(directory,'test-support/frontagent-controlled-live-entry.mjs')],{cwd:directory,env,stdio:'inherit',timeout:Math.max(1,deadline-Date.now()+30000)});}finally{supervisor.close();}
  if(fs.existsSync(path.join(directory,'frontagent-live-cleanup-unknown.json')))throw Error('CONTROLLED_REAL_CLEANUP_UNKNOWN');
  if(result.error)throw result.error;
  if(result.status!==0)throw Error('CONTROLLED_REAL_WORKER_FAILED');
  const restartLookup=spawnSync(process.execPath,['--input-type=module','-e',`import {openRestartLookup} from ${JSON.stringify(pathToFileURL(path.join(here,'controlled-real-run-budget.mjs')).href)}; const lookup=openRestartLookup(process.argv[1], process.argv[2]); try{lookup.startRunner();}catch(error){if(!String(error.message).includes('PILOT_RESTART_RUNNER_FORBIDDEN'))throw error;} lookup.read(()=>undefined);`,ledgerPath,process.env.QIWE_LOCAL_DOCKER_RUN_ID],{encoding:'utf8'});
  if(restartLookup.status!==0)throw Error('CONTROLLED_REAL_RESTART_LOOKUP_FAILED');
  const hostedLookup=openRestartLookup(ledgerPath,process.env.QIWE_LOCAL_DOCKER_RUN_ID);
  try{hostedLookup.startRunner();throw Error('CONTROLLED_REAL_RESTART_RUNNER_STARTED');}catch(error){if(!String(error?.message).includes('PILOT_RESTART_RUNNER_FORBIDDEN'))throw error;}
  writeAudit({...candidate.audit,status:'controlled-real-worker-stopped',limitations:[...instrumentation.localDocker.limitations,'Restart lookup refuses a new runner; this source path has not been executed as a live pilot']});
 }else{
 for(const phase of ['boot','restart']){
  env.QIWE_FULL_HOST_PHASE=phase;env.QIWE_FULL_HOST_EVIDENCE=path.join(directory,'evidence-'+phase+'.json');
  env.QIWE_RESTORATION_FLOW_EVIDENCE=env.QIWE_FULL_HOST_EVIDENCE;
  const supervisor=options.restorationScenario?await createRestorationSupervisorReceipt({hostRoot:directory,dataDir:path.join(directory,'data'),runId:runId+'-'+phase,timeoutMs:5000}):undefined;
  if(supervisor)env.QIWE_RESTORATION_RECEIPT=supervisor.locator;
  console.log('FULL_HOST_PHASE',JSON.stringify({runId,phase,status:'starting'}));
  let result;
  try{result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,options.restorationScenario?'restoration-flow.vitest.config.mts':'vitest.config.mts')],{cwd:directory,env,encoding:'utf8',timeout:options.restorationRealContainer?360000:180000,maxBuffer:16*1024*1024});}finally{supervisor?.close();}
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  const evidence=fs.existsSync(env.QIWE_FULL_HOST_EVIDENCE)?JSON.parse(fs.readFileSync(env.QIWE_FULL_HOST_EVIDENCE,'utf8')):null;
  phases.push({phase,status:result.status,evidence,...(supervisor?{supervisorReceipt:supervisor.receipt}:{}),stdout:result.stdout,stderr:result.stderr});
  writeAudit({...candidate.audit,instrumentation:{...instrumentation,...conversationInstrumentation},platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF',status:result.status===0?'in_progress':'failed',roleWorkspacePhase,phases});
  if(result.error)throw result.error;
  if(result.status!==0){process.exitCode=result.status??1;break;}
 }
 if(!process.exitCode){
  if(phases.length!==2||phases.some(phase=>!phase.evidence)||phases[0].evidence.processId===phases[1].evidence.processId)throw Error('FULL_HOST_DISTINCT_PROCESS_RESTART_NOT_PROVEN');
  const evidence={runId,status:'passed',restart:frontagentExistingState?'two separate OS worker processes share the restored existing Frontagent state':'two separate OS worker processes share exact original synthetic SQLite snapshot',phases:phases.map(({phase,evidence})=>({phase,...evidence}))};
  writeAudit({...candidate.audit,instrumentation:{...instrumentation,...conversationInstrumentation},platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF',status:'passed',roleWorkspacePhase,phases});
  // Linux tmpfs audit files disappear with the container. Persist enough exact
  // source/instrumentation identity in stdout to bind the retained host log.
  console.log('FULL_HOST_AUDIT_HASHES',JSON.stringify({runId,nativeTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree,composedHashesSha256:createHash('sha256').update(JSON.stringify(candidate.audit.composedHashes)).digest('hex'),instrumentation:{...instrumentation,...conversationInstrumentation},platform:process.platform,node:process.version,driver:driver?'prepared-adapter':'original-linux-ELF'}));
  fs.writeFileSync(path.join(evidenceRoot,'full-host-evidence.json'),JSON.stringify(evidence,null,2));console.log('FULL_HOST_EVIDENCE',JSON.stringify(evidence));
 }
 }
}catch(error){
 const failed=/^[A-Z0-9_]{1,80}/.exec(error?.message??'')?.[0]??'FULL_HOST_FAILED';
 try{writeAudit({...JSON.parse(fs.readFileSync(path.join(evidenceRoot,'full-host-audit.json'),'utf8')),...candidate?.audit,status:'failed',error:failed});}
 catch{try{fs.writeFileSync(path.join(evidenceRoot,'full-host-audit.json'),JSON.stringify({runId,status:'failed',error:failed},null,2));}catch{console.error('FULL_HOST_AUDIT_UNWRITTEN');}}
 throw error;
}finally{
 if(directory){
 if(ownedManifest)cleanupOwnedContainers({docker:'/qiwe-control/docker',endpoint:'unix:///qiwe-control/docker.sock',manifest:ownedManifest,runId:process.env.QIWE_LOCAL_DOCKER_RUN_ID,...(frontagentExistingState?{ownedContainerPrefix:frontagentExistingState.containerPrefix}:{})});
 const resolved=fs.realpathSync(directory);
 if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-full-host-'))throw Error('FULL_HOST_UNSAFE_TEMP_CLEANUP');
 if(options.restorationRealContainer)console.log('FULL_HOST_RETAINED_VOLUME_ROOT',resolved);
 else fs.rmSync(resolved,{recursive:true,force:true});
 }
}
