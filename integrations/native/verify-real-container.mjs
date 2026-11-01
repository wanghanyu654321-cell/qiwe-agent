import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createFullHostCandidate} from './full-host-candidate.mjs';
import {nativeVerificationOptions} from './verification-options.mjs';
import {verifyPreparedNativeSqlite} from './prepare-native-sqlite.mjs';
import {prepareOriginalPiRunner} from './role-capabilities-runner.mjs';
import {applyFullHostPiDrain,applyFullHostPiAbort} from './full-host-restoration-pi-overlay.mjs';
import {linuxImage} from './linux-runtime.mjs';
import {runLocalVerification,cleanupOwnedContainers} from './real-container-cleanup.mjs';
import {verifyOriginalShellImage,prepareOriginalShellCandidate} from './original-shell.mjs';

// Deliberately separate from restoration: the existing confined Linux proof
// cannot authorize a Docker daemon or a sibling writer outside its namespace.
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const args=process.argv.slice(2);
function take(flag){
 const index=args.indexOf(flag);
 if(index<0||args.filter(item=>item===flag).length!==1||!args[index+1]||args[index+1].startsWith('--'))throw Error('REAL_CONTAINER_ARGUMENT_REQUIRED: '+flag);
 return args.splice(index,2)[1];
}
const skillRoot=take('--skill-root'),docker=take('--docker');
const originalShellImage=args.includes('--original-shell-image')?take('--original-shell-image'):undefined;
const originalShellBuildInput=args.includes('--original-shell-build-input')?take('--original-shell-build-input'):undefined;
if(!!originalShellImage!==!!originalShellBuildInput||(originalShellBuildInput&&!path.isAbsolute(originalShellBuildInput)))throw Error('ORIGINAL_SHELL_EXPLICIT_INPUTS_REQUIRED');
const {source,overlay,driver,typecheck,unpatched}=nativeVerificationOptions(args);
if(process.platform!=='win32'||!overlay||!driver||!typecheck||unpatched||![skillRoot,docker].every(path.isAbsolute))throw Error('REAL_CONTAINER_EXPLICIT_WINDOWS_INPUTS_REQUIRED');
verifyPreparedNativeSqlite(source,driver);
const localEndpoint='npipe:////./pipe/dockerDesktopLinuxEngine';
const context=spawnSync(docker,['--host',localEndpoint,'context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8',timeout:10000});
if(context.status!==0||context.stdout.trim()!==localEndpoint)throw Error('REAL_CONTAINER_LOCAL_DOCKER_REQUIRED');
if(originalShellImage&&!/^sha256:[a-f0-9]{64}$/.test(originalShellImage))throw Error('ORIGINAL_SHELL_IMAGE_DIGEST_REQUIRED');
const image=spawnSync(docker,['--host',localEndpoint,'image','inspect',originalShellImage??linuxImage,'--format','{{.Id}}'],{encoding:'utf8',timeout:10000});
if(image.status!==0||image.stdout.trim()!==(originalShellImage??'sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9'))throw Error('REAL_CONTAINER_CACHED_PINNED_IMAGE_REQUIRED');
const candidate=await createFullHostCandidate(source,overlay,{conversationIntake:true,fullHostConversationExecution:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-real-container-'));
const runId=randomUUID(),evidenceRoot=path.join(process.env.QIWE_EVIDENCE_ROOT??path.join(project,'.local/real-container'),runId);
fs.mkdirSync(evidenceRoot,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),hashFile=file=>hash(fs.readFileSync(file));
const sourceFiles=['verify-real-container.mjs','real-container-cleanup.mjs','role-capabilities-runner.mjs','full-host-restoration-pi-overlay.mjs','real-container.test.mts','real-container-boundary.mjs','real-container-provider.mjs','original-shell.mjs'];
const ownedManifest=path.join(evidenceRoot,'owned-containers.txt');
let processTreeUnconfirmed=false;
const audit={runId,status:'preparing',scope:originalShellImage?'original unchanged shell, Chromium, identity preparation and true Pi main; deterministic model I/O test candidate; restored-host conjunction remains blocked':'original Docker transport and true Pi main; not a restored-host or original shell-entrypoint acceptance',baselineImage:image.stdout.trim(),native:candidate.audit,phases:[]};
const save=()=>fs.writeFileSync(path.join(evidenceRoot,'audit.json'),JSON.stringify(audit,null,2)+'\n');
save();console.log('REAL_CONTAINER_RUN',JSON.stringify({runId,evidenceRoot,root,status:'preparing'}));
try{
 const runner=prepareOriginalPiRunner({source,root,skillRoot,trueMain:true});
 fs.writeFileSync(runner.entryFile,applyFullHostPiDrain(fs.readFileSync(runner.entryFile,'utf8')));
 const runtime=path.join(runner.runnerTarget,'src/runtime/pi/pi-runner.ts');
 fs.writeFileSync(runtime,applyFullHostPiAbort(fs.readFileSync(runtime,'utf8')));
 if(originalShellImage){
  audit.originalShell=verifyOriginalShellImage({source,buildInput:originalShellBuildInput,image:originalShellImage,docker,endpoint:localEndpoint,runId,manifest:ownedManifest,runnerHashes:runner.runnerSourceHashes});
  prepareOriginalShellCandidate(runner);save();
 }
 for(const [name,value] of candidate.files){const target=path.join(root,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 // Original buildVolumeMounts discovers this source layout. Keep its actual
 // hot-mount plan; don't substitute symlinks for child mounts.
 const hotRoot=path.join(root,'container/agent-runner');fs.mkdirSync(hotRoot,{recursive:true});
 for(const name of ['src','prompts'])fs.cpSync(path.join(runner.runnerTarget,name),path.join(hotRoot,name),{recursive:true});
 fs.mkdirSync(path.join(root,'tests'));
 for(const name of ['real-container.test.mts','real-container-boundary.mjs'])fs.copyFileSync(path.join(here,name),path.join(root,'tests',name));
 fs.copyFileSync(path.join(here,'real-container-provider.mjs'),path.join(root,'real-container-provider.mjs'));
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module","private":true}');
 fs.writeFileSync(path.join(root,'vitest.config.mts'),"export default {test:{include:['tests/real-container.test.mts'],fileParallelism:false,maxWorkers:1,testTimeout:120000,hookTimeout:30000}};\n");
 const dependencies=path.resolve(source,'../node_modules'),target=path.join(root,'node_modules');fs.mkdirSync(target);
 for(const entry of fs.readdirSync(dependencies,{withFileTypes:true})){
  if(['.bin','.vite','.vite-temp','better-sqlite3'].includes(entry.name))continue;
  const from=path.join(dependencies,entry.name),to=path.join(target,entry.name);
  if(entry.isDirectory()||entry.isSymbolicLink())fs.symlinkSync(from,to,'junction');else fs.copyFileSync(from,to);
 }
 fs.symlinkSync(fs.realpathSync(driver),path.join(target,'better-sqlite3'),'junction');
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),NODE_ENV:'test',TZ:'UTC',NO_COLOR:'1',WEB_PORT:'0',WEB_SESSION_SECRET:'synthetic-real-container-secret',PLUGIN_AUTO_SCAN:'false',MINICLAW_EXECUTION_BOUNDARY:'member-container-only',MINICLAW_WEB_URL:'http://127.0.0.1:19777',MINICLAW_CONTAINER_IMAGE:image.stdout.trim(),
  QIWE_REAL_CONTAINER_RUN_ID:runId,QIWE_REAL_CONTAINER_OWNED_MANIFEST:ownedManifest,QIWE_REAL_CONTAINER_IMAGE:image.stdout.trim(),QIWE_REAL_CONTAINER_DOCKER:docker,QIWE_REAL_CONTAINER_RUNNER:runner.runnerTarget,QIWE_REAL_CONTAINER_RUNNER_DEPS:path.resolve(source,'../container/agent-runner/node_modules'),QIWE_REAL_CONTAINER_EVIDENCE:path.join(evidenceRoot,'scenario.json'),
  ...(originalShellImage?{QIWE_REAL_CONTAINER_ORIGINAL_SHELL:JSON.stringify(Object.fromEntries(['verified','image','entrypoint','piVersion','files'].map(key=>[key,audit.originalShell[key]])))}:{})};
 fs.mkdirSync(env.HOME);
 function run(label,command,commandArgs,cwd,timeout){
  const result=spawnSync(command,commandArgs,{cwd,env,encoding:'utf8',timeout,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(evidenceRoot,label+'.log'),(result.stdout??'')+(result.stderr??''));
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  audit.phases.push({label,status:result.status,error:result.error?.message});save();
  if(result.error)throw result.error;if(result.status!==0)throw Error('REAL_CONTAINER_PHASE_FAILED: '+label);
 }
 const tsc=path.join(project,'node_modules/typescript/bin/tsc');
 fs.copyFileSync(path.resolve(source,'../tsconfig.json'),path.join(root,'tsconfig.json'));
 run('host-typecheck',process.execPath,[tsc,'--noEmit','--incremental','false'],root,60000);
 run('runner-build',process.execPath,[tsc,'--outDir','dist','--incremental','false'],runner.runnerTarget,60000);
 audit.sources=Object.fromEntries(sourceFiles.map(name=>[name,hashFile(path.join(here,name))]));
 audit.runner={tree:runner.runnerTree,originals:runner.runnerSourceHashes,entry:hashFile(runner.entryFile),runtime:hashFile(runtime),compiledEntry:hashFile(path.join(runner.runnerTarget,'dist/pi-index.js'))};save();
 const scenarioStatus=await runLocalVerification(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(root,'vitest.config.mts')],{cwd:root,env,timeout:480000,log:path.join(evidenceRoot,'scenario.log')});
 audit.phases.push({label:'scenario',status:scenarioStatus});save();
 if(scenarioStatus!==0)throw Error('REAL_CONTAINER_PHASE_FAILED: scenario');
 if(!fs.existsSync(env.QIWE_REAL_CONTAINER_EVIDENCE))throw Error('REAL_CONTAINER_SCENARIO_EVIDENCE_MISSING');
 audit.scenario=JSON.parse(fs.readFileSync(env.QIWE_REAL_CONTAINER_EVIDENCE,'utf8'));
 if(audit.scenario.status!=='passed')throw Error('REAL_CONTAINER_SCENARIO_NOT_PASSED');
 audit.status=originalShellImage?'local-original-shell-passed':'local-transport-passed';save();
}catch(error){processTreeUnconfirmed=!!error.processTreeUnconfirmed;audit.status='failed';audit.error=String(error);save();throw error;}
finally{
 try{
  audit.cleanup=cleanupOwnedContainers({docker,endpoint:localEndpoint,manifest:ownedManifest,runId});
  if(processTreeUnconfirmed)throw Error('REAL_CONTAINER_PROCESS_TREE_UNCONFIRMED');
  const resolved=fs.realpathSync(root),temporary=fs.realpathSync(os.tmpdir());
  if(path.dirname(resolved)!==temporary||!path.basename(resolved).startsWith('qiwe-real-container-'))throw Error('REAL_CONTAINER_UNSAFE_TEMP_CLEANUP');
  if(originalShellImage){audit.workspaceRemoved=false;audit.retainedRoot=root;audit.retentionReason='Fresh synthetic root intentionally retained: original shell creates skill symlinks on Windows binds; recursive reparse cleanup is not proven safe.';save();}
  else{fs.rmSync(resolved,{recursive:true,force:true});audit.workspaceRemoved=true;save();}
 }catch(error){audit.status='failed';if(error.cleanup)audit.cleanup=error.cleanup;audit.cleanupError=String(error);audit.retainedRoot=root;save();throw error;}
}
console.log('REAL_CONTAINER_AUDIT',JSON.stringify({runId,status:audit.status,evidenceRoot,phases:audit.phases,cleanup:audit.cleanup}));
