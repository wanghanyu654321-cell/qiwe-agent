import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync as defaultExec} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';
import {PILOT_PRIVATE_CONFIG_PATH,assertIsolatedSyntheticClosed,createPilotScratch,runContainerPrivateInstall,sealWindowsPlaceholder,stageWindowsPrivateFile} from './pilot-private-bootstrap.mjs';
import {assertRestagedCode,restageControlledCode,sealControlledLinuxCopy,verifyControlledLinuxCopy} from './linux-runtime.mjs';

export const PILOT_MAX_REQUESTS=8,PILOT_MAX_OUTPUT_TOKENS=1024,PILOT_MAX_DURATION_MS=30*60*1000;
export const RUNNER_IMAGE='sha256:092853e7a053fc50f84b8a6b6f7cabf4f1d52673718be4c3df10672a2f4fc187';
const sealedStage=path.join('.local','frontagent-r3-20261029');
function inside(root,target){
 const rel=path.relative(root,target);
 return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);
}
export function resolveSealedStage(cwd){
 const root=path.resolve(cwd);
 let rootReal;try{rootReal=fs.realpathSync(root);}catch{fail('PILOT_LAUNCH_STAGE_UNSAFE');}
 const stage=path.resolve(root,sealedStage,'input');
 if(!inside(root,stage))fail('PILOT_LAUNCH_STAGE_UNSAFE');
 let listed;try{listed=fs.lstatSync(stage);}catch{fail('PILOT_LAUNCH_STAGE_UNSAFE');}
 if(listed.isSymbolicLink()||!listed.isDirectory())fail('PILOT_LAUNCH_STAGE_UNSAFE');
 const real=fs.realpathSync(stage);
 if(!inside(rootReal,real))fail('PILOT_LAUNCH_STAGE_UNSAFE');
 return real;
}
function controlFile(file,socket){
 let listed;try{listed=fs.lstatSync(file);}catch{fail('PILOT_LAUNCH_CONTROL_UNSAFE');}
 if(listed.isSymbolicLink()||(socket?!listed.isSocket():!listed.isFile()))fail('PILOT_LAUNCH_CONTROL_UNSAFE');
 return fs.realpathSync(file);
}
function regularFile(file){try{const listed=fs.lstatSync(file);return listed.isFile()&&!listed.isSymbolicLink();}catch{return false;}}
function stageReason(code,reason){const error=Error(code);error.reason=reason;return error;}
function missingSource(kind,searched){
 const error=Error('PILOT_LAUNCH_SOURCE_MISSING');
 error.reason=kind;
 error.paths=[...new Set(searched.map(file=>path.resolve(file)))];
 return error;
}
function mainCheckout(cwd){
 const read=args=>{try{return defaultExec('git',args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();}catch{return '';}};
 let common=read(['-C',cwd,'rev-parse','--path-format=absolute','--git-common-dir']);
 if(!common){const relative=read(['-C',cwd,'rev-parse','--git-common-dir']);if(relative)common=path.resolve(cwd,relative);}
 if(!common)return undefined;
 return path.resolve(path.dirname(common));
}
export function pilotSourceRoots(cwd=process.cwd(),options={}){
 const env=options.env??process.env;
 const explicit=options.sourceRoot??env.QIWE_PILOT_SOURCE_ROOT;
 if(typeof explicit==='string'&&explicit.trim()){
  const root=path.resolve(explicit);
  if(!fs.existsSync(root)||!fs.statSync(root).isDirectory())throw missingSource('source-root',[root]);
  return [root];
 }
 const here=path.resolve(cwd),roots=[here];
 const main=mainCheckout(here);
 if(main&&path.resolve(main)!==here)roots.push(path.resolve(main));
 return roots;
}
function controlSources(roots,stageRoot,name){
 const found=[];
 const add=file=>{const resolved=path.resolve(file);if(!found.includes(resolved))found.push(resolved);};
 add(path.join(stageRoot,name));
 for(const root of roots){
  add(path.join(root,'.local','t7-runner-shell-20261024',name));
  add(path.join(root,'.local','frontagent-r3-20261029',name));
  add(path.join(root,'.local','frontagent-r3-20261029','rebuilt-runner',name));
 }
 return found;
}
function ensureStageFile(roots,stageRoot,name){
 const dest=path.join(stageRoot,name);
 if(regularFile(dest))return dest;
 const searched=controlSources(roots,stageRoot,name);
 const source=searched.find(file=>regularFile(file)&&path.resolve(file)!==path.resolve(dest));
 if(!source)throw missingSource(name==='docker'?'docker':'build-input',searched);
 fs.copyFileSync(source,dest);
 if(name==='docker')try{fs.chmodSync(dest,0o755);}catch{}
 return dest;
}
function requireStageDir(dir,reason){
 let listed;try{listed=fs.lstatSync(dir);}catch{throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING',reason);}
 if(listed.isSymbolicLink()||!listed.isDirectory())throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING',reason);
}
function existingLayout(dir){
 try{
  const listed=fs.lstatSync(dir);
  if(listed.isSymbolicLink()||!listed.isDirectory())return false;
  const names=fs.readdirSync(dir).sort();
  return names.join('\0')===['code','descriptor.json','state'].join('\0')&&regularFile(path.join(dir,'descriptor.json'))&&fs.lstatSync(path.join(dir,'code')).isDirectory()&&fs.lstatSync(path.join(dir,'state')).isDirectory();
 }catch{return false;}
}
function readableTree(dir){
 const listed=fs.lstatSync(dir);
 if(listed.isSymbolicLink()||!listed.isDirectory())throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
 try{fs.chmodSync(dir,0o755);}catch{}
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const target=path.join(dir,entry.name);
  if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
  if(entry.isDirectory())readableTree(target);
  else try{fs.chmodSync(target,0o644);}catch{}
 }
}
function fileSha256(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function listTreeFiles(dir,prefix=''){
 const files=[];
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const relative=prefix?prefix+'/'+entry.name:entry.name;
  if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
  if(entry.isDirectory())files.push(...listTreeFiles(path.join(dir,entry.name),relative));
  else files.push(relative);
 }
 return files;
}
function locateExistingSources(roots){
 const products=[],bootstraps=[];
 for(const root of roots){
  products.push(path.join(root,'.local','frontagent-product-host-r1-final'));
  bootstraps.push(path.join(root,'.local','frontagent-r3-20261029','bootstrap-input.private.json'));
 }
 return {product:products.find(dir=>fs.existsSync(path.join(dir,'state'))&&fs.existsSync(path.join(dir,'code'))),bootstrap:bootstraps.find(regularFile),products,bootstraps};
}
function publishTree(dest,fill){
 const parent=path.dirname(dest);
 fs.mkdirSync(parent,{recursive:true});
 const tmp=path.join(parent,`.${path.basename(dest)}.${randomBytes(4).toString('hex')}.tmp`);
 try{
  fill(tmp);
  if(fs.existsSync(dest)){
   const backup=path.join(parent,`.${path.basename(dest)}.${randomBytes(4).toString('hex')}.old`);
   fs.renameSync(dest,backup);
   try{fs.renameSync(tmp,dest);}catch(error){try{fs.renameSync(backup,dest);}catch{}throw error;}
   fs.rmSync(backup,{recursive:true,force:true});
  }else fs.renameSync(tmp,dest);
 }catch(error){fs.rmSync(tmp,{recursive:true,force:true});throw error;}
}
/** Read the product tree and bootstrap JSON in place. The private file is not copied; only descriptor.json is written. */
export function buildFrontagentExistingInput(product,bootstrapFile,dest){
 if(!regularFile(bootstrapFile))throw missingSource('bootstrap',[bootstrapFile]);
 requireStageDir(path.join(product,'state'),'product-host');
 requireStageDir(path.join(product,'code'),'product-host');
 let parsed;try{parsed=JSON.parse(fs.readFileSync(bootstrapFile,'utf8'));}catch{throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');}
 const descriptor=parsed?.descriptor??parsed,typeFiles=parsed?.typeFiles??descriptor?.typeFiles;
 if(!descriptor||typeof descriptor!=='object'||Array.isArray(descriptor)||!Array.isArray(descriptor.files))throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
 for(const name of ['product-web.d.mts','product-modules.d.mts'])if(typeof typeFiles?.[name]!=='string')throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
 publishTree(dest,directory=>{
  fs.mkdirSync(directory,{recursive:true});
  fs.cpSync(path.join(product,'state'),path.join(directory,'state'),{recursive:true});
  fs.cpSync(path.join(product,'code'),path.join(directory,'code'),{recursive:true});
  for(const name of ['product-web.d.mts','product-modules.d.mts'])fs.writeFileSync(path.join(directory,'code',name),typeFiles[name],{mode:0o644});
  readableTree(directory);
  const expected=new Map(descriptor.files.map(entry=>[entry?.path,entry?.sha256]));
  const copied=listTreeFiles(path.join(directory,'state'),'state').concat(listTreeFiles(path.join(directory,'code'),'code'));
  if(copied.length!==expected.size||copied.some(file=>!expected.has(file)))throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
  for(const [relative,sha] of expected){
   if(typeof relative!=='string'||typeof sha!=='string')throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
   const copy=path.join(directory,...relative.split('/'));
   const source=relative==='code/product-web.d.mts'||relative==='code/product-modules.d.mts'?null:path.join(product,...relative.split('/'));
   let sourceHash=sha;
   if(source){if(!regularFile(source))throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');sourceHash=fileSha256(source);}
   else sourceHash=createHash('sha256').update(typeFiles[relative.slice('code/'.length)]).digest('hex');
   if(sourceHash!==sha||fileSha256(copy)!==sha)throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
  }
  const published={...descriptor};delete published.typeFiles;
  const descriptorFile=path.join(directory,'descriptor.json');
  fs.writeFileSync(descriptorFile,JSON.stringify(published,null,2)+'\n',{mode:0o600});try{fs.chmodSync(descriptorFile,0o600);}catch{}
  if(fs.readdirSync(directory).sort().join('\0')!==['code','descriptor.json','state'].join('\0'))throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
 });
 return dest;
}
/** Copy docker, build-input, and the product snapshot from the data roots. Code is restaged from the checkout that contains cwd. */
export function prepareSealedStage(cwd=process.cwd(),options={}){
 const input=resolveSealedStage(cwd),stageRoot=path.dirname(input),roots=pilotSourceRoots(cwd,options);
 const docker=ensureStageFile(roots,stageRoot,'docker'),buildInput=ensureStageFile(roots,stageRoot,'build-input-linux.json');
 requireStageDir(path.join(input,'.local','full-instance','stage','app','src'),'full-instance');
 requireStageDir(path.join(input,'.local','core-fix','appointment-identity-candidate','src'),'core-fix');
 requireStageDir(path.join(input,'.local','d4-skills'),'d4-skills');
 const existing=path.join(input,'.local','frontagent-existing-input');
 const located=locateExistingSources(roots);
 if(located.bootstrap&&located.product)buildFrontagentExistingInput(located.product,located.bootstrap,existing);
 else if(!existingLayout(existing)){
  const premade=path.join(stageRoot,'frontagent-existing-input');
  if(existingLayout(premade))fs.cpSync(premade,existing,{recursive:true});
  else throw missingSource(located.product?'bootstrap':'product-host',[...located.products,...located.bootstraps]);
 }
 const repo=runningCheckout(cwd)??path.resolve(cwd);
 restageControlledCode(repo,input);
 const commit=gitHead(repo);
 sealControlledLinuxCopy(input,commit);
 return {docker,buildInput,existing,commit};
}
function gitRead(cwd,args){
 try{return defaultExec('git',['-C',cwd,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();}
 catch{return '';}
}
function runningCheckout(cwd){
 const top=gitRead(cwd,['rev-parse','--show-toplevel']);
 return top&&fs.existsSync(top)?path.resolve(top):undefined;
}
function gitHead(cwd){
 const commit=gitRead(cwd,['rev-parse','HEAD']);
 return /^[0-9a-f]{40}$/.test(commit)?commit:undefined;
}
export function assertStageSeal(copyRoot,commit,checkout){
 try{
  const result=verifyControlledLinuxCopy(copyRoot,commit);
  if(checkout)assertRestagedCode(checkout,copyRoot);
  return result;
 }
 catch(error){if(error?.message==='PILOT_LAUNCH_STAGE_SEAL')throw error;const wrapped=Error('PILOT_LAUNCH_STAGE_SEAL');wrapped.reason='contents';throw wrapped;}
}
function resolveHostControls(stageInput,options){
 const stageRoot=path.dirname(stageInput),cwd=options.cwd??process.cwd(),roots=pilotSourceRoots(cwd,options),remote=(options.platform??process.platform)==='win32'||Boolean(options.dockerContext);
 const socket=options.dockerSocket??'/var/run/docker.sock';
 const docker=options.dockerBin??ensureStageFile(roots,stageRoot,'docker');
 const buildInput=options.buildInput??ensureStageFile(roots,stageRoot,'build-input-linux.json');
 return {socket:remote&&options.dockerSocket===undefined?socket:controlFile(socket,true),docker:controlFile(docker,false),buildInput:controlFile(buildInput,false)};
}
export function assertRecordedHostBoundary(args){
 const at=(flag,value)=>{const index=args.indexOf(flag);if(args[index+1]!==value)fail('PILOT_LAUNCH_BOUNDARY');};
 at('--cap-drop','ALL');at('--security-opt','no-new-privileges');at('--user','1000:1000');at('--workdir','/tmp');at('--pids-limit','256');at('--memory','4g');at('--cpus','2');
 const group=args.indexOf('--group-add');if(group<0||!/^\d+$/.test(args[group+1]??''))fail('PILOT_LAUNCH_BOUNDARY');
 if(!args.includes('--read-only')||args.includes('--tmpfs'))fail('PILOT_LAUNCH_BOUNDARY');
 if(args.some(item=>typeof item==='string'&&(item.startsWith('QIWE_RESTORATION_RECEIPT=')||item.startsWith('QIWE_PILOT_READY_NONCE=')||item.includes(':/run/docker.sock')||item.includes(':/var/run/docker.sock'))))fail('PILOT_LAUNCH_BOUNDARY');
 const mounts=[];
 for(let index=0;index<args.length;index++)if(args[index]==='-v')mounts.push(args[index+1]??'');
 const byDest=new Map(mounts.map(item=>[item.endsWith(':ro')?item.slice(0,-3).slice(item.slice(0,-3).lastIndexOf(':')+1):item.slice(item.lastIndexOf(':')+1),item]));
 const wanted=['/input','/qiwe-control/build-input.json','/qiwe-control/docker','/qiwe-control/docker.sock','/tmp'];
 if(JSON.stringify([...byDest.keys()].sort())!==JSON.stringify([...wanted].sort()))fail('PILOT_LAUNCH_BOUNDARY');
 if(!byDest.get('/input').endsWith(':/input:ro')||!byDest.get('/qiwe-control/build-input.json').endsWith(':ro')||!byDest.get('/qiwe-control/docker').endsWith(':/qiwe-control/docker:ro'))fail('PILOT_LAUNCH_BOUNDARY');
 if(!/^qiwe-tmp-[a-z0-9-]+:\/tmp$/.test(byDest.get('/tmp'))||byDest.get('/tmp').endsWith(':ro'))fail('PILOT_LAUNCH_BOUNDARY');
 if(!args.some(item=>typeof item==='string'&&item.includes('exec node /input/qiwe-agent/integrations/native/verify-full-host.mjs /input/.local/full-instance/stage/app/src --host-overlay /input/.local/core-fix/appointment-identity-candidate/src --skill-root /input/.local/d4-skills')))fail('PILOT_LAUNCH_BOUNDARY');
 if(!args.some(item=>typeof item==='string'&&item.includes('--frontagent-existing-state /input/.local/frontagent-existing-input')))fail('PILOT_LAUNCH_BOUNDARY');
 if(args.some(item=>typeof item==='string'&&item.includes('cp -a /input/.local/frontagent-existing-input')))fail('PILOT_LAUNCH_BOUNDARY');
 if(!args.includes('HOME=/tmp')||!args.includes('TMPDIR=/tmp')||!args.includes('QIWE_EVIDENCE_ROOT=/tmp/qiwe-evidence'))fail('PILOT_LAUNCH_BOUNDARY');
 return true;
}
const noCredentialImage='node:22.19.0-alpine';
const fail=code=>{throw Error(code);};
const runIdOk=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value??'');
const entryToken=/^[A-Za-z0-9_./:@+-]+$/;
const secretArg=/(?:^|[A-Z0-9_])(?:API_KEY|_TOKEN|SECRET|SECRET_KEY|ACCESS_KEY_ID|PASSWORD|_API_BASE|_BASE_URL|CUSTOM_HEADERS)=/i;
const coded=value=>typeof value?.message==='string'&&/^[A-Z0-9_]{1,80}$/.test(value.message);
function placeholderFile(directory){
 const body=JSON.stringify(validatePilotPrivateInput({bot:{botId:'synthetic-bot',corpId:'synthetic-corp',secret:'synthetic-bot-secret'},model:{apiKey:'synthetic-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}));
 const file=path.join(directory,'synthetic-private.json');
 fs.writeFileSync(file,body,{mode:0o600});
 return file;
}
function pilotEnv(runId,network,expiresAt){
 return {QIWE_CONTROLLED_REAL_PILOT:'1',QIWE_PILOT_RUN_ID:runId,QIWE_LOCAL_DOCKER_RUN_ID:runId,QIWE_LOCAL_DOCKER_NETWORK:network,QIWE_PILOT_MODEL_REQUESTS:String(PILOT_MAX_REQUESTS),QIWE_PILOT_MODEL_OUTPUT_TOKENS:String(PILOT_MAX_OUTPUT_TOKENS),QIWE_PILOT_EXPIRES_AT:String(expiresAt),QIWE_PILOT_MODEL_EXPIRES_AT:String(expiresAt),WEB_PORT:'39130',MINICLAW_WEB_URL:'http://127.0.0.1:39130'};
}
function assertEntry(entryArgs){
 if(!Array.isArray(entryArgs)||entryArgs.length===0||entryArgs.some(item=>typeof item!=='string'||!entryToken.test(item)||secretArg.test(item)||item.includes('\n')))fail('PILOT_LAUNCH_ENTRY_INVALID');
}
const readyDir='/tmp/qiwe-ready',readyFlag=readyDir+'/flag';
function waiterLoop(){
 return `while true; do if [ -f ${readyFlag} ]; then owner=$(stat -c %u ${readyFlag}); mode=$(stat -c %a ${readyFlag}); if [ "$owner" = 0 ] && [ "$mode" = 644 ]; then break; fi; fi; sleep 0.1; done`;
}
const hostedSource='/input/.local/full-instance/stage/app/src',hostedOverlay='/input/.local/core-fix/appointment-identity-candidate/src',hostedSkillSource='/input/.local/d4-skills',hostedExistingSource='/input/.local/frontagent-existing-input';
function realHostEntry(given){
 const extra=Array.isArray(given)?given.filter(item=>item!=='verify-full-host.mjs'&&item!=='/input/qiwe-agent/integrations/native/verify-full-host.mjs'):[];
 const base=['/input/qiwe-agent/integrations/native/verify-full-host.mjs',hostedSource,'--host-overlay',hostedOverlay,'--skill-root',hostedSkillSource,'--full-host-conversations','--restoration-scenario','--restoration-real-container','--frontagent-existing-state',hostedExistingSource,'--typecheck','--controlled-real-pilot'];
 for(const item of extra)if(!base.includes(item))base.push(item);
 return base;
}
function hostedPrelude(){
 const missing=reason=>`{ echo PILOT_LAUNCH_STAGE_INPUT_MISSING ${reason}; exit 1; }`;
 return `[ -d ${hostedSource} ] || ${missing('full-instance')}
[ -d ${hostedOverlay} ] || ${missing('core-fix')}
[ -d ${hostedSkillSource} ] || ${missing('d4-skills')}
[ -d ${hostedExistingSource} ] && [ -f ${hostedExistingSource}/descriptor.json ] && [ -d ${hostedExistingSource}/code ] && [ -d ${hostedExistingSource}/state ] || ${missing('existing-input')}
`;
}
function waiterScript(entryArgs,prelude=''){
 return `${prelude}${waiterLoop()}; exec node ${entryArgs.join(' ')}`;
}
const evidenceProbe='for f in /tmp/qiwe-evidence/*/full-host-audit.json; do if [ -s "$f" ]; then echo QIWE_EVIDENCE_WRITTEN; exit 0; fi; done; exit 1';
function rehearsalPhase(output){
 return String(output??'').split(/\r?\n/).find(line=>{
  if(!line.startsWith('FULL_HOST_PHASE '))return false;
  try{const body=JSON.parse(line.slice('FULL_HOST_PHASE '.length));return body.phase==='controlled-real'&&body.status==='starting';}catch{return false;}
 })??'';
}
function sanitizeMessage(value){
 if(typeof value!=='string')return '';
 return value.replace(/[\r\n]+/g,' ').slice(0,300).replace(/(?:api[_-]?key|token|secret|password|adminCookie|miniclaw_session)\s*[:=]\s*\S+/gi,'[redacted]');
}
function failureText(error){
 const stderr=Buffer.isBuffer(error?.stderr)?error.stderr.toString('utf8'):typeof error?.stderr==='string'?error.stderr:'';
 return sanitizeMessage((stderr.trim()||(typeof error?.message==='string'?error.message:'')));
}
function publicFailure(error){
 if(coded(error))throw error;
 const wrapped=Error('PILOT_LAUNCH_FAILED');
 wrapped.causeName=/^[A-Za-z][A-Za-z0-9_]*$/.test(error?.name??'')?error.name:'Error';
 wrapped.causeMessage=failureText(error);
 if(typeof error?.reason==='string'&&/^[a-z0-9-]{1,40}$/.test(error.reason))wrapped.reason=error.reason;
 throw wrapped;
}
const placeholderScript=`${waiterLoop()}; exec node -e 'const fs=require("fs");const flag="${readyFlag}";const st=fs.statSync(flag);const body=fs.readFileSync(flag,"utf8");if(st.uid!==0||(st.mode&511)!==420||!/^[a-f0-9]{32}$/.test(body))process.exit(1);const p="${PILOT_PRIVATE_CONFIG_PATH}";const s=fs.statSync(p);if(!s.isFile()||s.uid!==1000||(s.mode&511)!==384||s.nlink!==1)process.exit(1);process.stdout.write("CONTROLLED_REAL_READY "+body+"\\n");'`;
function sleepMs(ms){defaultExec(process.execPath,['-e','Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,'+Number(ms)+')'],{timeout:ms+2000});}
export function launcherPlan(platform,args=[]){
 const dash=args.indexOf('--'),cli=dash>=0?args.slice(0,dash):args,synthetic=cli.includes('--synthetic'),noCredential=cli.includes('--no-credential'),rehearsal=cli.includes('--rehearsal');
 return {incremental:platform==='win32'?'per-file':'suite',mode:rehearsal?'rehearsal':noCredential?'no-credential':synthetic?'synthetic':'real',useRecordingDocker:synthetic&&!noCredential&&!rehearsal};
}
/** The container starts a waiter that has not read the private file. Install uses exec only after start. Domain allowlisting is not performed. 127.0.0.1 in MINICLAW_WEB_URL is the container loopback. */
export function runSupervisedPilot(options={}){
 const mode=options.mode;
 if(!['synthetic','no-credential','real','rehearsal'].includes(mode))fail('PILOT_LAUNCH_MODE_INVALID');
 const env=options.env??process.env;
 if(options.requests!=null&&options.requests!==PILOT_MAX_REQUESTS||options.outputTokens!=null&&options.outputTokens!==PILOT_MAX_OUTPUT_TOKENS)fail('PILOT_LAUNCH_BUDGET_CAP');
 if(options.durationMs!=null&&(!Number.isSafeInteger(options.durationMs)||options.durationMs<1||options.durationMs>PILOT_MAX_DURATION_MS))fail('PILOT_LAUNCH_BUDGET_CAP');
 if(mode!=='real')assertIsolatedSyntheticClosed(env,path.join(os.tmpdir(),'qiwe-launcher-absent-private.json'));
 if(options.mounts!=null)fail('PILOT_LAUNCH_MOUNTS_FORBIDDEN');
 if((mode==='real'||mode==='rehearsal')&&(mode==='real'&&(typeof options.privateFile!=='string'||!path.isAbsolute(options.privateFile))||!/^sha256:[a-f0-9]{64}$/.test(options.image??'')))fail('PILOT_LAUNCH_INPUT_REQUIRED');
 const entryArgs=options.entryArgs??['verify-full-host.mjs','--controlled-real-pilot'];
 if(mode==='no-credential'?options.entryArgs!==undefined:false)fail('PILOT_LAUNCH_ENTRY_INVALID');
 if(mode!=='no-credential')assertEntry(entryArgs);
 const context=options.dockerContext;
 if(context!==undefined&&!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(context))fail('PILOT_LAUNCH_CONTEXT_INVALID');
 if(options.publishWeb!==undefined&&options.publishWeb!==true)fail('PILOT_LAUNCH_PUBLISH_INVALID');
 const now=options.now??Date.now,started=now(),duration=options.durationMs??PILOT_MAX_DURATION_MS,expiresAt=started+duration,runId=options.runId??randomUUID(),nonce=randomBytes(16).toString('hex');
 if(!runIdOk(runId)||!/^[a-f0-9]{32}$/.test(nonce))fail('PILOT_LAUNCH_RUN_ID');
 const hosted=mode==='real'||mode==='rehearsal',network=hosted?'qiwe-pilot-'+runId:'none',hostName='qiwe-pilot-host-'+runId;
 const image=hosted?options.image:mode==='no-credential'?noCredentialImage:'sha256:'+'ab'.repeat(32);
 const scratch=createPilotScratch({platform:options.platform,homedir:options.homedir}),privateFile=mode==='real'?options.privateFile:sealWindowsPlaceholder(placeholderFile(scratch),{platform:options.platform,homedir:options.homedir,currentSid:options.currentSid,execFileSync:options.aclExec});
 const exec=options.execFileSync??defaultExec,docker='docker',prefix=context?['--context',context]:[];
 const wrapped=(command,args,opts)=>exec(command,[...prefix,...args],{stdio:['ignore','pipe','pipe'],...opts});
 const environment=pilotEnv(runId,network,expiresAt);
 const volume=hosted?'qiwe-tmp-'+runId:undefined;
 if(hosted)Object.assign(environment,{HOME:'/tmp',TMPDIR:'/tmp',QIWE_EVIDENCE_ROOT:'/tmp/qiwe-evidence',QIWE_LOCAL_DOCKER_VOLUME:volume,QIWE_LOCAL_DOCKER_HOST:hostName,QIWE_LOCAL_DOCKER_IMAGE:image,QIWE_LOCAL_DOCKER_DRIVER_IMAGE:RUNNER_IMAGE,QIWE_RESTORATION_REAL_CONTAINER:'1'});
 const stage=hosted?resolveSealedStage(options.cwd??process.cwd()):undefined;
 const controls=hosted?resolveHostControls(stage,options):undefined;
 const checkout=hosted?runningCheckout(options.cwd??process.cwd()):undefined;
 if(hosted)assertStageSeal(stage,gitHead(checkout??options.cwd??process.cwd()),checkout);
 const realMounts=hosted?[`${stage}:/input:ro`,`${volume}:/tmp`,`${controls.socket}:/qiwe-control/docker.sock`,`${controls.docker}:/qiwe-control/docker:ro`,`${controls.buildInput}:/qiwe-control/build-input.json:ro`]:[];
 const envArgs=Object.entries(environment).flatMap(([key,value])=>['-e',key+'='+value]);
 const publishArgs=options.publishWeb?['-p','127.0.0.1:39130:39130']:[];
 const script=mode==='no-credential'?placeholderScript:waiterScript(hosted?realHostEntry(options.entryArgs):entryArgs,hosted?hostedPrelude():'');
 const tagged=output=>String(output??'').split(/\r?\n/).filter(line=>line===`CONTROLLED_REAL_READY ${nonce}`);
 const dockerBin=context?`docker --context ${context}`:'docker';
 const stopCommand=hosted?`${dockerBin} rm -f ${hostName} && ${dockerBin} volume rm ${volume} && ${dockerBin} network rm ${network}`:`${dockerBin} rm -f ${hostName}`;
 let stopped=false,timer;
 const detach=()=>{process.off('SIGINT',onSigInt);process.off('SIGTERM',onSigTerm);if(timer!==undefined)clearTimeout(timer);};
 const removeOnce=(args)=>{let failed=false;for(let attempt=0;attempt<3;attempt++){try{wrapped(docker,args);return;}catch{failed=true;}}if(failed){const error=Error('PILOT_LAUNCH_CLEANUP_FAILED');error.stopCommand=stopCommand;throw error;}};
 const cleanup=()=>{if(stopped)return;stopped=true;detach();let failure;try{removeOnce(['rm','-f',hostName]);if(hosted){removeOnce(['volume','rm',volume]);removeOnce(['network','rm',network]);}}catch(error){failure=error;}fs.rmSync(scratch,{recursive:true,force:true});if(failure)throw failure;};
 const reportFailure=error=>{const text=`${error.message}\n${error.stopCommand??stopCommand}`;if(typeof options.report==='function')options.report(text);else console.error(text);};
 const finish=(code)=>{try{cleanup();(options.exit??process.exit)(code);}catch(error){reportFailure(error);(options.exit??process.exit)(1);}};
 const onSigInt=()=>finish(130);
 const onSigTerm=()=>finish(143);
 process.on('SIGINT',onSigInt);process.on('SIGTERM',onSigTerm);
 try{
  if(hosted){
   wrapped(docker,['network','create','--driver','bridge','--label','qiwe.verification-run='+runId,'--label','qiwe.controlled-real-pilot=local-test','--opt','com.docker.network.enable_ipv6=false',network]);
   wrapped(docker,['volume','create','--label','qiwe.verification-run='+runId,volume]);
   wrapped(docker,['run','--rm','--network','none','--user','0:0','--mount',`type=volume,source=${volume},target=/tmp`,'--entrypoint','chmod',image,'1777','/tmp']);
   const existingOnHost=path.join(stage,'.local','frontagent-existing-input');
   if(fs.existsSync(existingOnHost))wrapped(docker,['run','--rm','--network','none','--user','0:0','--mount',`type=bind,source=${existingOnHost},target=/existing`,'--entrypoint','sh',image,'-c','find /existing -type d -exec chmod 755 {} + && find /existing -type f ! -name descriptor.json -exec chmod 644 {} + && chown 1000:1000 /existing/descriptor.json && chmod 600 /existing/descriptor.json']);
  }
  const socketGroup=hosted&&!( (options.platform??process.platform)==='win32'||Boolean(context) )?(()=>{try{const gid=fs.statSync(controls.socket).gid;if(Number.isInteger(gid)&&gid>=0)return String(gid);}catch{}return '0';})():'0';
  const boundary=hosted?['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','4g','--cpus','2','--group-add',socketGroup,'--workdir','/tmp']:[];
  const scratchTmp=mode==='no-credential'?['--tmpfs','/tmp:rw,nosuid,nodev,mode=1777']:[];
  const createArgs=['create','--name',hostName,'--network',network,'--user','1000:1000',...boundary,...scratchTmp,...realMounts.flatMap(item=>['-v',item]),...publishArgs,...envArgs,'--entrypoint','/bin/sh',image,'-c',script];
  if(hosted)assertRecordedHostBoundary(createArgs);
  wrapped(docker,createArgs);
  try{wrapped(docker,['start',hostName]);}catch(error){publicFailure(error);}
  try{wrapped(docker,['exec','--user','0:0',hostName,'mkdir','-m','755',readyDir]);}catch{fail('PILOT_LAUNCH_READY_FLAG_EXISTS');}
  if(tagged(wrapped(docker,['logs',hostName])).length!==0)fail('PILOT_LAUNCH_NOT_READY');
  runContainerPrivateInstall({execFileSync:wrapped,docker,container:hostName,hostFile:privateFile,destination:PILOT_PRIVATE_CONFIG_PATH,platform:options.platform,homedir:options.homedir,acl:options.acl,user:options.user,realpath:options.realpath,aces:options.aces,currentSid:options.currentSid,reparsePoint:options.reparsePoint,aclExec:options.aclExec});
  wrapped(docker,['exec','--user','0:0',hostName,'sh','-c','umask 077; printf %s "$1" > /tmp/qiwe-ready/nonce && chmod 400 /tmp/qiwe-ready/nonce; umask 022; printf %s "$1" > /tmp/qiwe-ready/flag && chmod 644 /tmp/qiwe-ready/flag','sh',nonce]);
  const attempts=options.logAttempts??Math.max(1,Math.ceil((Number(environment.QIWE_PILOT_EXPIRES_AT)-Date.now())/100));let ready='',lastLog=null,lastChange=(options.now??Date.now)();
  const stallMs=options.stallMs??120000;
  const clock=()=>(options.now??Date.now)();
  const redactTail=text=>String(text??'').split(/\r?\n/).slice(-50).map(sanitizeMessage).filter(Boolean).join('\n');
  const containerStatus=()=>String(wrapped(docker,['inspect','-f','{{.State.Status}}',hostName])??'');
  const stoppedHost=status=>/\b(?:exited|dead)\b/.test(status);
  const captureHostExit=()=>{
   let exitCode=1,logTail='';
   try{exitCode=Number(String(wrapped(docker,['inspect','-f','{{.State.ExitCode}}',hostName])??'').trim());}catch{}
   try{logTail=String(wrapped(docker,['logs','--tail','50',hostName])??'');}catch{}
   const error=Error('PILOT_LAUNCH_HOST_EXITED');
   error.exitCode=Number.isInteger(exitCode)?exitCode:1;
   error.logTail=logTail.split(/\r?\n/).slice(-50).map(sanitizeMessage).filter(Boolean).join('\n');
   throw error;
  };
  for(let index=0;index<attempts;index++){
   const status=containerStatus();
   if(stoppedHost(status))captureHostExit();
   const logged=String(wrapped(docker,['logs',hostName])??'');
   const tick=clock();
   if(logged!==lastLog){lastLog=logged;lastChange=tick;}
   else if(tick-lastChange>=stallMs){const error=Error('PILOT_LAUNCH_HOST_STALLED');error.logTail=redactTail(logged);throw error;}
   if(mode==='rehearsal'){
    const phase=rehearsalPhase(logged);
    let evidence=false;
    if(phase){try{evidence=String(wrapped(docker,['exec','--user','1000:1000',hostName,'sh','-c',evidenceProbe])??'').includes('QIWE_EVIDENCE_WRITTEN');}catch(error){if(coded(error))throw error;}}
    if(phase&&evidence){ready=phase;break;}
   }else{
    const lines=tagged(logged);
    if(lines.length===1){ready=lines[0];break;}
    if(lines.length>1)fail('PILOT_LAUNCH_NOT_READY');
   }
   if(index===attempts-1)fail('PILOT_LAUNCH_NOT_READY');
   (options.sleep??sleepMs)(100);
  }
  const schedule=options.setTimeout??((fn,ms)=>{const handle=setTimeout(fn,ms);if(options.keepAlive!==true)handle.unref?.();return handle;});
  const delay=Number(environment.QIWE_PILOT_EXPIRES_AT)-now();
  if(!Number.isSafeInteger(delay)||delay<1)fail('PILOT_LAUNCH_EXPIRED');
  timer=schedule(()=>{try{cleanup();}catch(error){reportFailure(error);(options.exit??process.exit)(1);}},delay);
  const wait=()=>{const deadline=Number(environment.QIWE_PILOT_EXPIRES_AT);while((options.now??Date.now)()<deadline){const status=String(wrapped(docker,['inspect','-f','{{.State.Status}}',hostName])??'');if(/exited|dead/.test(status)){cleanup();return 'exited';}(options.sleep??sleepMs)(200);}cleanup();return 'expired';};
  const report={status:'controlled-real-launcher',mode,ready,runId,expiresAt,network,stopCommand,caps:{requests:PILOT_MAX_REQUESTS,outputTokens:PILOT_MAX_OUTPUT_TOKENS,durationMs:PILOT_MAX_DURATION_MS},web:{scope:'container-loopback',url:'http://127.0.0.1:39130',hostPublished:options.publishWeb===true,hostUrl:options.publishWeb?'http://127.0.0.1:39130':null},...(mode==='rehearsal'?{receipt:'supervisor-receipt-created',evidenceRoot:'/tmp/qiwe-evidence'}:{})};
  return {report,stop:cleanup,wait,privateFile};
 }catch(error){if(!stopped){try{cleanup();}catch(failure){if(failure?.message==='PILOT_LAUNCH_CLEANUP_FAILED')throw failure;}}publicFailure(error);}
}
function stdinBytes(options){return options?.stdio?.[0]==='pipe'?Buffer.from(options?.input??''):Buffer.alloc(0);}
export function createRecordingDocker(){
 const files=new Map();let running=false,nonce='',flagReady=false,logsServed=false;
 const execFileSync=(command,args,options)=>{
  if(args.includes('exec')&&!running){const error=Error('container is not running');error.status=1;throw error;}
  if(args.includes('inspect')&&args.includes('-f')){const format=args[args.indexOf('-f')+1]??'';if(String(format).includes('ExitCode'))return '1\n';return logsServed?'exited\n':'running\n';}
  if(args.includes('create')&&args.includes('--name'))running=false;
  if(args.includes('start')&&!args.includes('create')&&!args.includes('exec'))running=true;
  if(args.some(item=>String(item).includes('cat >'))){const dest=String(args.find(item=>String(item).includes('cat >'))).match(/\/tmp\/qiwe-private-[a-f0-9]{16}/)?.[0];if(dest)files.set(dest,stdinBytes(options));return '';}
  if(args.includes('exec')&&args.some(item=>item.includes('/tmp/qiwe-ready/flag')&&item.includes('printf'))){nonce=args.find(item=>/^[a-f0-9]{32}$/.test(item))??nonce;flagReady=true;}
  const op=args.find(item=>['cp','sha256sum','stat','ln','rm','logs'].includes(item));
  if(op==='logs'){const body=flagReady?`CONTROLLED_REAL_READY ${nonce}\n`:'waiting\n';if(body.includes('CONTROLLED_REAL_READY'))logsServed=true;return body;}
  if(op==='cp'){const host=args[args.indexOf('--')+1],dest=args.at(-1).slice(args.at(-1).indexOf(':')+1);files.set(dest,fs.readFileSync(host));return '';}
  if(op==='sha256sum'||op==='stat'){const target=args.at(-1),data=files.get(target);if(!data){const error=Error('missing');error.status=1;throw error;}if(op==='stat')return `1000 1000 600 1 ${data.length}\n`;return createHash('sha256').update(data).digest('hex')+'  '+target+'\n';}
  if(op==='ln'){const dest=args.at(-1),src=args.at(-2);if(files.has(dest)){const error=Error('File exists');error.status=1;throw error;}files.set(dest,Buffer.from(files.get(src)??''));return '';}
  return '';
 };
 return {execFileSync};
}
// Stage a Windows private file under the user profile. The grant is *SID:(R), not the display name:
// node integrations/native/controlled-real-launcher.mjs --stage-private-file C:\path\to\source.json
// Optional --destination must stay inside the user profile.
// Prepare from the checkout whose code should run. --source-root supplies only data
// (product host, bootstrap, docker, build-input). Code and the seal HEAD come from
// `git rev-parse --show-toplevel` of this process.
// node integrations/native/controlled-real-launcher.mjs --prepare-stage --source-root <data-checkout>
// QIWE_PILOT_SOURCE_ROOT is the same data override. Otherwise data falls back to dirname of `git rev-parse --git-common-dir`.
// $env:DOCKER_CONTEXT='desktop-linux'
// node integrations/native/controlled-real-launcher.mjs --rehearsal --docker-context desktop-linux --image sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
function main(){
 const args=process.argv.slice(2),plan=launcherPlan(process.platform,args),dash=args.indexOf('--'),cli=dash>=0?args.slice(0,dash):args;
 const fileAt=cli.indexOf('--private-file'),imageAt=cli.indexOf('--image'),contextAt=cli.indexOf('--docker-context'),stageAt=cli.indexOf('--stage-private-file'),destAt=cli.indexOf('--destination'),sourceAt=cli.indexOf('--source-root');
 const value=index=>cli[index+1];
 const sourceRoot=sourceAt>=0?path.resolve(value(sourceAt)):undefined;
 try{
  if(cli.includes('--prepare-stage')){
   const prepared=prepareSealedStage(process.cwd(),{sourceRoot,env:process.env});
   console.log(prepared.docker);
   console.log(prepared.buildInput);
   console.log(prepared.existing);
   return;
  }
  if(stageAt>=0){
   const staged=stageWindowsPrivateFile({source:path.resolve(value(stageAt)),destination:destAt>=0?path.resolve(value(destAt)):undefined});
   console.log(staged.destination);
   return;
  }
  if(plan.mode==='synthetic'&&(fileAt>=0||imageAt>=0))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  if(plan.mode==='no-credential'&&(fileAt>=0||imageAt>=0||dash>=0))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  if(plan.mode==='rehearsal'&&fileAt>=0)fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  const result=runSupervisedPilot({mode:plan.mode,env:process.env,sourceRoot,privateFile:fileAt>=0?path.resolve(value(fileAt)):undefined,image:imageAt>=0?value(imageAt):undefined,dockerContext:contextAt>=0?value(contextAt):undefined,entryArgs:dash>=0?args.slice(dash+1):undefined,publishWeb:cli.includes('--publish-web')?true:undefined,keepAlive:plan.mode!=='synthetic',...(plan.useRecordingDocker?{execFileSync:createRecordingDocker().execFileSync}:{})});
  console.log(result.report.ready);
  console.log(JSON.stringify(result.report));
  if(plan.mode==='synthetic')result.stop();
  else result.wait();
 }catch(error){
  if(error?.message==='PILOT_LAUNCH_HOST_EXITED'||error?.message==='PILOT_LAUNCH_HOST_STALLED'){
   console.error(error.message);
   if(error.message==='PILOT_LAUNCH_HOST_EXITED')console.error(String(error.exitCode??''));
   if(typeof error.logTail==='string'&&error.logTail)console.error(error.logTail);
   process.exitCode=1;
   return;
  }
  const code=coded(error)?error.message:'PILOT_LAUNCH_FAILED';
  console.error(code);
  if(code==='PILOT_LAUNCH_FAILED'&&error?.causeName){console.error(error.causeName);if(error.causeMessage)console.error(error.causeMessage);}
  else if(!coded(error)){console.error(/^[A-Za-z][A-Za-z0-9_]*$/.test(error?.name??'')?error.name:'Error');const message=failureText(error);if(message)console.error(message);}
  if(Array.isArray(error?.envNames))for(const name of error.envNames)if(/^[A-Za-z0-9_]+$/.test(name))console.error(name);
  if(typeof error?.reason==='string'&&/^[a-z0-9-]{1,40}$/.test(error.reason))console.error(error.reason);
  if(Array.isArray(error?.paths))for(const item of error.paths)if(typeof item==='string'&&item.startsWith(path.parse(item).root)&&!/[\r\n]/.test(item))console.error(item);
  if(error?.stopCommand)console.error(error.stopCommand);
  process.exitCode=1;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
