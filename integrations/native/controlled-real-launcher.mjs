import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync as defaultExec} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';
import {PILOT_PRIVATE_CONFIG_PATH,assertIsolatedSyntheticClosed,createPilotScratch,runContainerPrivateInstall,sealWindowsPlaceholder,stageWindowsPrivateFile} from './pilot-private-bootstrap.mjs';

export const PILOT_MAX_REQUESTS=8,PILOT_MAX_OUTPUT_TOKENS=1024,PILOT_MAX_DURATION_MS=30*60*1000;
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
const readyDir='/run/qiwe-ready',readyFlag=readyDir+'/flag';
function waiterLoop(){
 return `while true; do if [ -f ${readyFlag} ]; then owner=$(stat -c %u ${readyFlag}); body=$(cat ${readyFlag}); if [ "$owner" = 0 ] && [ "$body" = "$QIWE_PILOT_READY_NONCE" ]; then break; fi; fi; sleep 0.1; done`;
}
function waiterScript(entryArgs){
 return `${waiterLoop()}; exec node ${entryArgs.join(' ')}`;
}
const placeholderScript=`${waiterLoop()}; exec node -e 'const fs=require("fs");const flag="${readyFlag}";const st=fs.statSync(flag);const body=fs.readFileSync(flag,"utf8");if(st.uid!==0||body!==process.env.QIWE_PILOT_READY_NONCE)process.exit(1);const p="${PILOT_PRIVATE_CONFIG_PATH}";const s=fs.statSync(p);if(!s.isFile()||s.uid!==1000||(s.mode&511)!==384||s.nlink!==1)process.exit(1);process.stdout.write("CONTROLLED_REAL_READY "+process.env.QIWE_PILOT_READY_NONCE+"\\n");'`;
function sleepMs(ms){defaultExec(process.execPath,['-e','Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,'+Number(ms)+')'],{timeout:ms+2000});}
export function launcherPlan(platform,args=[]){
 const dash=args.indexOf('--'),cli=dash>=0?args.slice(0,dash):args,synthetic=cli.includes('--synthetic'),noCredential=cli.includes('--no-credential');
 return {incremental:platform==='win32'?'per-file':'suite',mode:noCredential?'no-credential':synthetic?'synthetic':'real',useRecordingDocker:synthetic&&!noCredential};
}
/** The container starts a waiter that has not read the private file. Install uses exec only after start. Domain allowlisting is not performed. 127.0.0.1 in MINICLAW_WEB_URL is the container loopback. */
export function runSupervisedPilot(options={}){
 const mode=options.mode;
 if(mode!=='synthetic'&&mode!=='no-credential'&&mode!=='real')fail('PILOT_LAUNCH_MODE_INVALID');
 const env=options.env??process.env;
 if(options.requests!=null&&options.requests!==PILOT_MAX_REQUESTS||options.outputTokens!=null&&options.outputTokens!==PILOT_MAX_OUTPUT_TOKENS)fail('PILOT_LAUNCH_BUDGET_CAP');
 if(options.durationMs!=null&&(!Number.isSafeInteger(options.durationMs)||options.durationMs<1||options.durationMs>PILOT_MAX_DURATION_MS))fail('PILOT_LAUNCH_BUDGET_CAP');
 if(mode!=='real')assertIsolatedSyntheticClosed(env,path.join(os.tmpdir(),'qiwe-launcher-absent-private.json'));
 if(mode==='real'&&(typeof options.privateFile!=='string'||!path.isAbsolute(options.privateFile)||!/^sha256:[a-f0-9]{64}$/.test(options.image??'')))fail('PILOT_LAUNCH_INPUT_REQUIRED');
 const entryArgs=options.entryArgs??['verify-full-host.mjs','--controlled-real-pilot'];
 if(mode==='no-credential'?options.entryArgs!==undefined:false)fail('PILOT_LAUNCH_ENTRY_INVALID');
 if(mode!=='no-credential')assertEntry(entryArgs);
 const context=options.dockerContext;
 if(context!==undefined&&!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(context))fail('PILOT_LAUNCH_CONTEXT_INVALID');
 if(options.publishWeb!==undefined&&options.publishWeb!==true)fail('PILOT_LAUNCH_PUBLISH_INVALID');
 const now=options.now??Date.now,started=now(),duration=options.durationMs??PILOT_MAX_DURATION_MS,expiresAt=started+duration,runId=options.runId??randomUUID(),nonce=randomBytes(16).toString('hex');
 if(!runIdOk(runId)||!/^[a-f0-9]{32}$/.test(nonce))fail('PILOT_LAUNCH_RUN_ID');
 const network=mode==='real'?'qiwe-pilot-'+runId:'none',hostName='qiwe-pilot-host-'+runId;
 const image=mode==='real'?options.image:mode==='no-credential'?noCredentialImage:'sha256:'+'ab'.repeat(32);
 const scratch=createPilotScratch({platform:options.platform,homedir:options.homedir}),privateFile=mode==='real'?options.privateFile:sealWindowsPlaceholder(placeholderFile(scratch),{platform:options.platform,homedir:options.homedir,currentSid:options.currentSid,execFileSync:options.aclExec});
 const exec=options.execFileSync??defaultExec,docker='docker',prefix=context?['--context',context]:[];
 const wrapped=(command,args,opts)=>exec(command,[...prefix,...args],opts);
 const environment=pilotEnv(runId,network,expiresAt,nonce);
 const envArgs=Object.entries(environment).flatMap(([key,value])=>['-e',key+'='+value]);
 const publishArgs=options.publishWeb?['-p','127.0.0.1:39130:39130']:[];
 const script=mode==='no-credential'?placeholderScript:waiterScript(entryArgs);
 const tagged=output=>String(output??'').split(/\r?\n/).filter(line=>line===`CONTROLLED_REAL_READY ${nonce}`);
 const dockerBin=context?`docker --context ${context}`:'docker';
 const stopCommand=mode==='real'?`${dockerBin} rm -f ${hostName} && ${dockerBin} network rm ${network}`:`${dockerBin} rm -f ${hostName}`;
 let stopped=false,timer;
 const detach=()=>{process.off('SIGINT',onSigInt);process.off('SIGTERM',onSigTerm);if(timer!==undefined)clearTimeout(timer);};
 const removeOnce=(args)=>{let failed=false;for(let attempt=0;attempt<3;attempt++){try{wrapped(docker,args);return;}catch{failed=true;}}if(failed){const error=Error('PILOT_LAUNCH_CLEANUP_FAILED');error.stopCommand=stopCommand;throw error;}};
 const cleanup=()=>{if(stopped)return;stopped=true;detach();let failure;try{removeOnce(['rm','-f',hostName]);if(mode==='real')removeOnce(['network','rm',network]);}catch(error){failure=error;}fs.rmSync(scratch,{recursive:true,force:true});if(failure)throw failure;};
 const reportFailure=error=>{const text=`${error.message}\n${error.stopCommand??stopCommand}`;if(typeof options.report==='function')options.report(text);else console.error(text);};
 const finish=(code)=>{try{cleanup();(options.exit??process.exit)(code);}catch(error){reportFailure(error);(options.exit??process.exit)(1);}};
 const onSigInt=()=>finish(130);
 const onSigTerm=()=>finish(143);
 process.on('SIGINT',onSigInt);process.on('SIGTERM',onSigTerm);
 try{
  if(mode==='real')wrapped(docker,['network','create','--driver','bridge','--label','qiwe.verification-run='+runId,'--label','qiwe.controlled-real-pilot=local-test','--opt','com.docker.network.enable_ipv6=false',network]);
  wrapped(docker,['create','--name',hostName,'--network',network,'--user','1000:1000',...(options.mounts??[]).flatMap(item=>['-v',item]),...publishArgs,...envArgs,'--entrypoint','/bin/sh',image,'-c',script]);
  try{wrapped(docker,['start',hostName]);}catch(error){if(coded(error))throw error;fail('PILOT_LAUNCH_FAILED');}
  try{wrapped(docker,['exec','--user','0:0',hostName,'sh','-c','if [ -e /run/qiwe-ready ]; then echo EXISTS; exit 1; fi']);}catch{fail('PILOT_LAUNCH_READY_FLAG_EXISTS');}
  wrapped(docker,['exec','--user','0:0',hostName,'mkdir','-m','755',readyDir]);
  wrapped(docker,['exec','--user','0:0',hostName,'chown','0:0',readyDir]);
  if(tagged(wrapped(docker,['logs',hostName])).length!==0)fail('PILOT_LAUNCH_NOT_READY');
  runContainerPrivateInstall({execFileSync:wrapped,docker,container:hostName,hostFile:privateFile,destination:PILOT_PRIVATE_CONFIG_PATH,platform:options.platform,homedir:options.homedir,acl:options.acl,user:options.user,realpath:options.realpath});
  wrapped(docker,['exec','--user','0:0',hostName,'sh','-c',`umask 022; printf %s "$QIWE_PILOT_READY_NONCE" > ${readyFlag} && chown 0:0 ${readyFlag} && chmod 644 ${readyFlag}`]);
  const attempts=options.logAttempts??Math.max(1,Math.ceil((Number(environment.QIWE_PILOT_EXPIRES_AT)-Date.now())/100));let ready='';
  for(let index=0;index<attempts;index++){
   const lines=tagged(wrapped(docker,['logs',hostName]));
   if(lines.length===1){ready=lines[0];break;}
   if(lines.length>1||index===attempts-1)fail('PILOT_LAUNCH_NOT_READY');
   (options.sleep??sleepMs)(100);
  }
  const schedule=options.setTimeout??((fn,ms)=>{const handle=setTimeout(fn,ms);if(options.keepAlive!==true)handle.unref?.();return handle;});
  const delay=Number(environment.QIWE_PILOT_EXPIRES_AT)-now();
  if(!Number.isSafeInteger(delay)||delay<1)fail('PILOT_LAUNCH_EXPIRED');
  timer=schedule(()=>{try{cleanup();}catch(error){reportFailure(error);(options.exit??process.exit)(1);}},delay);
  const report={status:'controlled-real-launcher',mode,ready,runId,expiresAt,network,stopCommand,caps:{requests:PILOT_MAX_REQUESTS,outputTokens:PILOT_MAX_OUTPUT_TOKENS,durationMs:PILOT_MAX_DURATION_MS},web:{scope:'container-loopback',url:'http://127.0.0.1:39130',hostPublished:options.publishWeb===true,hostUrl:options.publishWeb?'http://127.0.0.1:39130':null}};
  return {report,stop:cleanup,privateFile};
 }catch(error){if(!stopped){try{cleanup();}catch(failure){if(failure?.message==='PILOT_LAUNCH_CLEANUP_FAILED')throw failure;}}if(coded(error))throw error;fail('PILOT_LAUNCH_FAILED');}
}
export function createRecordingDocker(){
 const files=new Map();let running=false,nonce='',flagReady=false;
 const execFileSync=(command,args)=>{
  if(args.includes('exec')&&!running){const error=Error('container is not running');error.status=1;throw error;}
  if(args.includes('create')&&args.includes('--name')){running=false;nonce=args.find(item=>item.startsWith('QIWE_PILOT_READY_NONCE='))?.split('=')[1]??'';}
  if(args.includes('start')&&!args.includes('create'))running=true;
  if(args.includes('exec')&&args.some(item=>item.includes('/run/qiwe-ready/flag')&&item.includes('printf')))flagReady=true;
  const op=args.find(item=>['cp','sha256sum','stat','ln','rm','logs'].includes(item));
  if(op==='logs')return flagReady?`CONTROLLED_REAL_READY ${nonce}\n`:'waiting\n';
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
function main(){
 const args=process.argv.slice(2),plan=launcherPlan(process.platform,args),dash=args.indexOf('--'),cli=dash>=0?args.slice(0,dash):args;
 const fileAt=cli.indexOf('--private-file'),imageAt=cli.indexOf('--image'),contextAt=cli.indexOf('--docker-context'),stageAt=cli.indexOf('--stage-private-file'),destAt=cli.indexOf('--destination');
 const value=index=>cli[index+1];
 try{
  if(stageAt>=0){
   const staged=stageWindowsPrivateFile({source:path.resolve(value(stageAt)),destination:destAt>=0?path.resolve(value(destAt)):undefined});
   console.log(staged.destination);
   return;
  }
  if(plan.mode==='synthetic'&&(fileAt>=0||imageAt>=0))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  if(plan.mode==='no-credential'&&(fileAt>=0||imageAt>=0||dash>=0))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  const result=runSupervisedPilot({mode:plan.mode,env:process.env,privateFile:fileAt>=0?path.resolve(value(fileAt)):undefined,image:imageAt>=0?value(imageAt):undefined,dockerContext:contextAt>=0?value(contextAt):undefined,entryArgs:dash>=0?args.slice(dash+1):undefined,publishWeb:cli.includes('--publish-web')?true:undefined,keepAlive:plan.mode!=='synthetic',...(plan.useRecordingDocker?{execFileSync:createRecordingDocker().execFileSync}:{})});
  console.log(result.report.ready);
  console.log(JSON.stringify(result.report));
  if(plan.mode==='synthetic')result.stop();
 }catch(error){
  const code=coded(error)?error.message:'PILOT_LAUNCH_FAILED';
  console.error(code);
  if(Array.isArray(error?.envNames))for(const name of error.envNames)if(/^[A-Za-z0-9_]+$/.test(name))console.error(name);
  if(typeof error?.reason==='string'&&/^[a-z0-9-]{1,40}$/.test(error.reason))console.error(error.reason);
  if(error?.stopCommand)console.error(error.stopCommand);
  process.exitCode=1;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
