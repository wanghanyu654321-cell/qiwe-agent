import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync as defaultExec} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';
import {PILOT_PRIVATE_CONFIG_PATH,assertIsolatedSyntheticClosed,createPilotScratch,runContainerPrivateInstall,sealWindowsPlaceholder,stageWindowsPrivateFile} from './pilot-private-bootstrap.mjs';

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
function controlSources(cwd,stageRoot,name){
 return [path.join(stageRoot,name),path.join(cwd,'.local','t7-runner-shell-20261024',name),path.join(cwd,'.local','frontagent-r3-20261029','rebuilt-runner',name)];
}
function ensureStageFile(cwd,stageRoot,name){
 const dest=path.join(stageRoot,name);
 if(regularFile(dest))return dest;
 const source=controlSources(cwd,stageRoot,name).find(file=>regularFile(file)&&path.resolve(file)!==path.resolve(dest));
 if(!source)throw stageReason('PILOT_LAUNCH_CONTROL_UNSAFE',name==='docker'?'docker':'build-input');
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
function copyExistingInput(source,dest){
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');if(entry.isDirectory())walk(path.join(dir,entry.name));}};
 walk(source);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(source,dest,{recursive:true,errorOnExist:true});
}
/** Copy the Linux docker client and build-input-linux.json from the same local sources the sealed stage uses. */
export function prepareSealedStage(cwd=process.cwd()){
 const input=resolveSealedStage(cwd),stageRoot=path.dirname(input);
 const docker=ensureStageFile(cwd,stageRoot,'docker'),buildInput=ensureStageFile(cwd,stageRoot,'build-input-linux.json');
 requireStageDir(path.join(input,'.local','full-instance','stage','app','src'),'full-instance');
 requireStageDir(path.join(input,'.local','core-fix','appointment-identity-candidate','src'),'core-fix');
 requireStageDir(path.join(input,'.local','d4-skills'),'d4-skills');
 const existing=path.join(input,'.local','frontagent-existing-input');
 if(!existingLayout(existing)){
  const source=[path.join(stageRoot,'frontagent-existing-input'),path.join(cwd,'.local','frontagent-existing-input')].find(existingLayout);
  if(!source)throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING','existing-input');
  copyExistingInput(source,existing);
 }
 return {docker,buildInput,existing};
}
function resolveHostControls(stageInput,options){
 const stageRoot=path.dirname(stageInput),cwd=options.cwd??process.cwd(),remote=(options.platform??process.platform)==='win32'||Boolean(options.dockerContext);
 const socket=options.dockerSocket??'/var/run/docker.sock';
 const docker=options.dockerBin??ensureStageFile(cwd,stageRoot,'docker');
 const buildInput=options.buildInput??ensureStageFile(cwd,stageRoot,'build-input-linux.json');
 return {socket:remote&&options.dockerSocket===undefined?socket:controlFile(socket,true),docker:controlFile(docker,false),buildInput:controlFile(buildInput,false)};
}
export function assertRecordedHostBoundary(args){
 const at=(flag,value)=>{const index=args.indexOf(flag);if(args[index+1]!==value)fail('PILOT_LAUNCH_BOUNDARY');};
 at('--cap-drop','ALL');at('--security-opt','no-new-privileges');at('--user','1000:1000');at('--workdir','/tmp');
 if(!args.includes('--read-only')||args.includes('--tmpfs'))fail('PILOT_LAUNCH_BOUNDARY');
 if(args.some(item=>typeof item==='string'&&(item.startsWith('QIWE_RESTORATION_RECEIPT=')||item.includes(':/run/docker.sock')||item.includes(':/var/run/docker.sock'))))fail('PILOT_LAUNCH_BOUNDARY');
 const mounts=[];
 for(let index=0;index<args.length;index++)if(args[index]==='-v')mounts.push(args[index+1]??'');
 const byDest=new Map(mounts.map(item=>[item.endsWith(':ro')?item.slice(0,-3).slice(item.slice(0,-3).lastIndexOf(':')+1):item.slice(item.lastIndexOf(':')+1),item]));
 const wanted=['/input','/qiwe-control/build-input.json','/qiwe-control/docker','/qiwe-control/docker.sock','/tmp'];
 if(JSON.stringify([...byDest.keys()].sort())!==JSON.stringify([...wanted].sort()))fail('PILOT_LAUNCH_BOUNDARY');
 if(!byDest.get('/input').endsWith(':/input:ro')||!byDest.get('/qiwe-control/build-input.json').endsWith(':ro')||!byDest.get('/qiwe-control/docker').endsWith(':/qiwe-control/docker:ro'))fail('PILOT_LAUNCH_BOUNDARY');
 if(!/^qiwe-tmp-[a-z0-9-]+:\/tmp$/.test(byDest.get('/tmp'))||byDest.get('/tmp').endsWith(':ro'))fail('PILOT_LAUNCH_BOUNDARY');
 if(!args.some(item=>typeof item==='string'&&item.includes('exec node /input/qiwe-agent/integrations/native/verify-full-host.mjs /input/.local/full-instance/stage/app/src --host-overlay /input/.local/core-fix/appointment-identity-candidate/src --skill-root /tmp/qiwe-skill-root')))fail('PILOT_LAUNCH_BOUNDARY');
 if(!args.some(item=>typeof item==='string'&&item.includes('--frontagent-existing-state /tmp/qiwe-frontagent-input')))fail('PILOT_LAUNCH_BOUNDARY');
 if(!args.some(item=>typeof item==='string'&&item.includes('cp -a /input/.local/d4-skills /tmp/qiwe-skill-root')&&item.includes('cp -a /input/.local/frontagent-existing-input /tmp/qiwe-frontagent-input')))fail('PILOT_LAUNCH_BOUNDARY');
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
function pilotEnv(runId,network,expiresAt,nonce){
 return {QIWE_CONTROLLED_REAL_PILOT:'1',QIWE_PILOT_RUN_ID:runId,QIWE_LOCAL_DOCKER_RUN_ID:runId,QIWE_LOCAL_DOCKER_NETWORK:network,QIWE_PILOT_MODEL_REQUESTS:String(PILOT_MAX_REQUESTS),QIWE_PILOT_MODEL_OUTPUT_TOKENS:String(PILOT_MAX_OUTPUT_TOKENS),QIWE_PILOT_EXPIRES_AT:String(expiresAt),QIWE_PILOT_MODEL_EXPIRES_AT:String(expiresAt),QIWE_PILOT_READY_NONCE:nonce,WEB_PORT:'39130',MINICLAW_WEB_URL:'http://127.0.0.1:39130'};
}
function assertEntry(entryArgs){
 if(!Array.isArray(entryArgs)||entryArgs.length===0||entryArgs.some(item=>typeof item!=='string'||!entryToken.test(item)||secretArg.test(item)||item.includes('\n')))fail('PILOT_LAUNCH_ENTRY_INVALID');
}
const readyDir='/tmp/qiwe-ready',readyFlag=readyDir+'/flag';
function waiterLoop(){
 return `while true; do if [ -f ${readyFlag} ]; then owner=$(stat -c %u ${readyFlag}); body=$(cat ${readyFlag}); if [ "$owner" = 0 ] && [ "$body" = "$QIWE_PILOT_READY_NONCE" ]; then break; fi; fi; sleep 0.1; done`;
}
const hostedSource='/input/.local/full-instance/stage/app/src',hostedOverlay='/input/.local/core-fix/appointment-identity-candidate/src',hostedSkillSource='/input/.local/d4-skills',hostedSkillRoot='/tmp/qiwe-skill-root',hostedExistingSource='/input/.local/frontagent-existing-input',hostedExistingInput='/tmp/qiwe-frontagent-input';
function realHostEntry(given){
 const extra=Array.isArray(given)?given.filter(item=>item!=='verify-full-host.mjs'&&item!=='/input/qiwe-agent/integrations/native/verify-full-host.mjs'):[];
 const base=['/input/qiwe-agent/integrations/native/verify-full-host.mjs',hostedSource,'--host-overlay',hostedOverlay,'--skill-root',hostedSkillRoot,'--full-host-conversations','--restoration-scenario','--restoration-real-container','--frontagent-existing-state',hostedExistingInput,'--typecheck','--controlled-real-pilot'];
 for(const item of extra)if(!base.includes(item))base.push(item);
 return base;
}
function hostedPrelude(){
 const missing=reason=>`{ echo PILOT_LAUNCH_STAGE_INPUT_MISSING ${reason}; exit 1; }`;
 return `[ -d ${hostedSource} ] || ${missing('full-instance')}
[ -d ${hostedOverlay} ] || ${missing('core-fix')}
[ -d ${hostedSkillSource} ] || ${missing('d4-skills')}
[ -d ${hostedExistingSource} ] && [ -f ${hostedExistingSource}/descriptor.json ] || ${missing('existing-input')}
rm -rf ${hostedSkillRoot} ${hostedExistingInput}
cp -a ${hostedSkillSource} ${hostedSkillRoot} || ${missing('d4-skills')}
cp -a ${hostedExistingSource} ${hostedExistingInput} || ${missing('existing-input')}
[ -f ${hostedExistingInput}/descriptor.json ] && [ -d ${hostedExistingInput}/code ] && [ -d ${hostedExistingInput}/state ] && [ -f ${hostedSkillRoot}/beauty-local-content/SKILL.md ] || ${missing('existing-input')}
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
 return value.replace(/[\r\n]+/g,' ').slice(0,300).replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,'[redacted]');
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
const placeholderScript=`${waiterLoop()}; exec node -e 'const fs=require("fs");const flag="${readyFlag}";const st=fs.statSync(flag);const body=fs.readFileSync(flag,"utf8");if(st.uid!==0||body!==process.env.QIWE_PILOT_READY_NONCE)process.exit(1);const p="${PILOT_PRIVATE_CONFIG_PATH}";const s=fs.statSync(p);if(!s.isFile()||s.uid!==1000||(s.mode&511)!==384||s.nlink!==1)process.exit(1);process.stdout.write("CONTROLLED_REAL_READY "+process.env.QIWE_PILOT_READY_NONCE+"\\n");'`;
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
 const environment=pilotEnv(runId,network,expiresAt,nonce);
 const volume=hosted?'qiwe-tmp-'+runId:undefined;
 if(hosted)Object.assign(environment,{HOME:'/tmp',TMPDIR:'/tmp',QIWE_EVIDENCE_ROOT:'/tmp/qiwe-evidence',QIWE_LOCAL_DOCKER_VOLUME:volume,QIWE_LOCAL_DOCKER_HOST:hostName,QIWE_LOCAL_DOCKER_IMAGE:image,QIWE_LOCAL_DOCKER_DRIVER_IMAGE:RUNNER_IMAGE,QIWE_RESTORATION_REAL_CONTAINER:'1'});
 const stage=hosted?resolveSealedStage(options.cwd??process.cwd()):undefined;
 const controls=hosted?resolveHostControls(stage,options):undefined;
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
  }
  const boundary=hosted?['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--workdir','/tmp']:[];
  const scratchTmp=mode==='no-credential'?['--tmpfs','/tmp:rw,nosuid,nodev,mode=1777']:[];
  const createArgs=['create','--name',hostName,'--network',network,'--user','1000:1000',...boundary,...scratchTmp,...realMounts.flatMap(item=>['-v',item]),...publishArgs,...envArgs,'--entrypoint','/bin/sh',image,'-c',script];
  if(hosted)assertRecordedHostBoundary(createArgs);
  wrapped(docker,createArgs);
  try{wrapped(docker,['start',hostName]);}catch(error){publicFailure(error);}
  try{wrapped(docker,['exec','--user','0:0',hostName,'mkdir','-m','755',readyDir]);}catch{fail('PILOT_LAUNCH_READY_FLAG_EXISTS');}
  if(tagged(wrapped(docker,['logs',hostName])).length!==0)fail('PILOT_LAUNCH_NOT_READY');
  runContainerPrivateInstall({execFileSync:wrapped,docker,container:hostName,hostFile:privateFile,destination:PILOT_PRIVATE_CONFIG_PATH,platform:options.platform,homedir:options.homedir,acl:options.acl,user:options.user,realpath:options.realpath,aces:options.aces,currentSid:options.currentSid,reparsePoint:options.reparsePoint,aclExec:options.aclExec});
  wrapped(docker,['exec','--user','0:0',hostName,'sh','-c',`umask 022; printf %s "$QIWE_PILOT_READY_NONCE" > ${readyFlag} && chmod 644 ${readyFlag}`]);
  const attempts=options.logAttempts??Math.max(1,Math.ceil((Number(environment.QIWE_PILOT_EXPIRES_AT)-Date.now())/100));let ready='';
  const containerStatus=()=>String(wrapped(docker,['inspect','-f','{{.State.Status}}',hostName])??'');
  const stoppedHost=status=>/\b(?:exited|dead)\b/.test(status);
  for(let index=0;index<attempts;index++){
   const status=containerStatus();
   if(stoppedHost(status)){
    const output=String(wrapped(docker,['logs',hostName])??'');
    const reason=/PILOT_LAUNCH_STAGE_INPUT_MISSING ([a-z0-9-]+)/.exec(output);
    if(reason)throw stageReason('PILOT_LAUNCH_STAGE_INPUT_MISSING',reason[1]);
    fail('PILOT_LAUNCH_NOT_READY');
   }
   if(mode==='rehearsal'){
    const phase=rehearsalPhase(wrapped(docker,['logs',hostName]));
    let evidence=false;
    if(phase){try{evidence=String(wrapped(docker,['exec','--user','1000:1000',hostName,'sh','-c',evidenceProbe])??'').includes('QIWE_EVIDENCE_WRITTEN');}catch(error){if(coded(error))throw error;}}
    if(phase&&evidence){ready=phase;break;}
   }else{
    const lines=tagged(wrapped(docker,['logs',hostName]));
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
  if(args.includes('inspect')&&args.includes('-f'))return logsServed?'exited\n':'running\n';
  if(args.includes('create')&&args.includes('--name')){running=false;nonce=args.find(item=>item.startsWith('QIWE_PILOT_READY_NONCE='))?.split('=')[1]??'';}
  if(args.includes('start')&&!args.includes('create')&&!args.includes('exec'))running=true;
  if(args.some(item=>String(item).includes('cat >'))){const dest=String(args.find(item=>String(item).includes('cat >'))).match(/\/tmp\/qiwe-private-[a-f0-9]{16}/)?.[0];if(dest)files.set(dest,stdinBytes(options));return '';}
  if(args.includes('exec')&&args.some(item=>item.includes('/tmp/qiwe-ready/flag')&&item.includes('printf')))flagReady=true;
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
// Prepare the sealed stage's docker client and build-input-linux.json, then rehearse:
// node integrations/native/controlled-real-launcher.mjs --prepare-stage
// $env:DOCKER_CONTEXT='desktop-linux'
// node integrations/native/controlled-real-launcher.mjs --rehearsal --docker-context desktop-linux --image sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
function main(){
 const args=process.argv.slice(2),plan=launcherPlan(process.platform,args),dash=args.indexOf('--'),cli=dash>=0?args.slice(0,dash):args;
 const fileAt=cli.indexOf('--private-file'),imageAt=cli.indexOf('--image'),contextAt=cli.indexOf('--docker-context'),stageAt=cli.indexOf('--stage-private-file'),destAt=cli.indexOf('--destination');
 const value=index=>cli[index+1];
 try{
  if(cli.includes('--prepare-stage')){
   const prepared=prepareSealedStage(process.cwd());
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
  const result=runSupervisedPilot({mode:plan.mode,env:process.env,privateFile:fileAt>=0?path.resolve(value(fileAt)):undefined,image:imageAt>=0?value(imageAt):undefined,dockerContext:contextAt>=0?value(contextAt):undefined,entryArgs:dash>=0?args.slice(dash+1):undefined,publishWeb:cli.includes('--publish-web')?true:undefined,keepAlive:plan.mode!=='synthetic',...(plan.useRecordingDocker?{execFileSync:createRecordingDocker().execFileSync}:{})});
  console.log(result.report.ready);
  console.log(JSON.stringify(result.report));
  if(plan.mode==='synthetic')result.stop();
  else result.wait();
 }catch(error){
  const code=coded(error)?error.message:'PILOT_LAUNCH_FAILED';
  console.error(code);
  if(code==='PILOT_LAUNCH_FAILED'&&error?.causeName){console.error(error.causeName);if(error.causeMessage)console.error(error.causeMessage);}
  else if(!coded(error)){console.error(/^[A-Za-z][A-Za-z0-9_]*$/.test(error?.name??'')?error.name:'Error');const message=failureText(error);if(message)console.error(message);}
  if(Array.isArray(error?.envNames))for(const name of error.envNames)if(/^[A-Za-z0-9_]+$/.test(name))console.error(name);
  if(typeof error?.reason==='string'&&/^[a-z0-9-]{1,40}$/.test(error.reason))console.error(error.reason);
  if(error?.stopCommand)console.error(error.stopCommand);
  process.exitCode=1;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
