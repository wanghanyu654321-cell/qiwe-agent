import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync as defaultExec} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';
import {PILOT_PRIVATE_CONFIG_PATH,assertIsolatedSyntheticClosed,runContainerPrivateInstall} from './pilot-private-bootstrap.mjs';

export const PILOT_MAX_REQUESTS=8,PILOT_MAX_OUTPUT_TOKENS=1024,PILOT_MAX_DURATION_MS=30*60*1000;
const fail=code=>{throw Error(code);};
const runIdOk=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value??'');
function placeholderFile(directory){
 const body=JSON.stringify(validatePilotPrivateInput({bot:{botId:'synthetic-bot',corpId:'synthetic-corp',secret:'synthetic-bot-secret'},model:{apiKey:'synthetic-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}}));
 const file=path.join(directory,'synthetic-private.json');
 fs.writeFileSync(file,body,{mode:0o600});
 return file;
}
function pilotEnv(runId,network,expiresAt){
 return {QIWE_CONTROLLED_REAL_PILOT:'1',QIWE_PILOT_RUN_ID:runId,QIWE_LOCAL_DOCKER_RUN_ID:runId,QIWE_LOCAL_DOCKER_NETWORK:network,QIWE_PILOT_MODEL_REQUESTS:String(PILOT_MAX_REQUESTS),QIWE_PILOT_MODEL_OUTPUT_TOKENS:String(PILOT_MAX_OUTPUT_TOKENS),QIWE_PILOT_EXPIRES_AT:String(expiresAt),QIWE_PILOT_MODEL_EXPIRES_AT:String(expiresAt),WEB_PORT:'39130',MINICLAW_WEB_URL:'http://127.0.0.1:39130'};
}
/** Windows Docker drives this sequence. The container is created, the private file is installed, then the entry starts. Domain allowlisting is not performed here. */
export function runSupervisedPilot(options={}){
 const mode=options.mode;
 if(mode!=='synthetic'&&mode!=='real')fail('PILOT_LAUNCH_MODE_INVALID');
 const env=options.env??process.env;
 if(options.requests!=null&&options.requests!==PILOT_MAX_REQUESTS||options.outputTokens!=null&&options.outputTokens!==PILOT_MAX_OUTPUT_TOKENS)fail('PILOT_LAUNCH_BUDGET_CAP');
 if(options.durationMs!=null&&(!Number.isSafeInteger(options.durationMs)||options.durationMs<1||options.durationMs>PILOT_MAX_DURATION_MS))fail('PILOT_LAUNCH_BUDGET_CAP');
 if(mode==='synthetic')assertIsolatedSyntheticClosed(env,path.join(os.tmpdir(),'qiwe-launcher-absent-private.json'));
 if(mode==='real'&&(typeof options.privateFile!=='string'||!path.isAbsolute(options.privateFile)||!/^sha256:[a-f0-9]{64}$/.test(options.image??'')))fail('PILOT_LAUNCH_INPUT_REQUIRED');
 const now=options.now??Date.now,started=now(),duration=options.durationMs??PILOT_MAX_DURATION_MS,expiresAt=started+duration,runId=options.runId??randomUUID();
 if(!runIdOk(runId))fail('PILOT_LAUNCH_RUN_ID');
 const network=mode==='synthetic'?'none':'qiwe-pilot-'+runId,hostName='qiwe-pilot-host-'+runId,image=mode==='synthetic'?'sha256:'+'ab'.repeat(32):options.image;
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-launch-')),privateFile=mode==='synthetic'?placeholderFile(scratch):options.privateFile;
 const exec=options.execFileSync??defaultExec,context=options.dockerContext,docker='docker';
 const wrapped=(command,args,opts)=>exec(command,context?['--context',context,...args]:args,opts);
 const envArgs=Object.entries(pilotEnv(runId,network,expiresAt)).flatMap(([key,value])=>['-e',key+'='+value]);
 const entryArgs=options.entryArgs??['verify-full-host.mjs','--controlled-real-pilot'];
 if(entryArgs.some(item=>typeof item!=='string'||item.startsWith('-e')||item.includes('\n')||item.includes('API_KEY=')))fail('PILOT_LAUNCH_ENTRY_INVALID');
 if(mode==='real')wrapped(docker,['network','create','--driver','bridge','--label','qiwe.verification-run='+runId,'--label','qiwe.controlled-real-pilot=local-test','--opt','com.docker.network.enable_ipv6=false',network]);
 wrapped(docker,['create','--name',hostName,'--network',network,'--user','1000:1000',...(options.mounts??[]).flatMap(item=>['-v',item]),...envArgs,'--entrypoint','node',image,...entryArgs]);
 try{runContainerPrivateInstall({execFileSync:wrapped,docker,container:hostName,hostFile:privateFile,destination:PILOT_PRIVATE_CONFIG_PATH});}
 catch(error){try{wrapped(docker,['rm','-f',hostName]);}catch{}if(mode==='real')try{wrapped(docker,['network','rm',network]);}catch{}fs.rmSync(scratch,{recursive:true,force:true});throw error;}
 wrapped(docker,['start',hostName]);
 const stopCommand=mode==='real'?`docker rm -f ${hostName} && docker network rm ${network}`:`docker rm -f ${hostName}`;
 let stopped=false;
 const stop=()=>{if(stopped)return;stopped=true;try{wrapped(docker,['rm','-f',hostName]);}catch{}if(mode==='real')try{wrapped(docker,['network','rm',network]);}catch{}fs.rmSync(scratch,{recursive:true,force:true});};
 const report={status:'controlled-real-launcher',mode,ready:'CONTROLLED_REAL_READY',runId,expiresAt,network,stopCommand,caps:{requests:PILOT_MAX_REQUESTS,outputTokens:PILOT_MAX_OUTPUT_TOKENS,durationMs:PILOT_MAX_DURATION_MS}};
 return {report,stop,privateFile};
}
export function createRecordingDocker(){
 const files=new Map();
 const execFileSync=(command,args)=>{
  const op=args.find(item=>['cp','sha256sum','stat','ln','rm','create','start','network'].includes(item));
  if(op==='cp'){const host=args[args.indexOf('--')+1],dest=args.at(-1).slice(args.at(-1).indexOf(':')+1);files.set(dest,fs.readFileSync(host));return '';}
  if(op==='sha256sum'||op==='stat'){const target=args.at(-1),data=files.get(target);if(!data){const error=Error('missing');error.status=1;throw error;}if(op==='stat')return `1000 1000 600 1 ${data.length}\n`;return createHash('sha256').update(data).digest('hex')+'  '+target+'\n';}
  if(op==='ln'){const dest=args.at(-1),src=args.at(-2);if(files.has(dest)){const error=Error('File exists');error.status=1;throw error;}files.set(dest,Buffer.from(files.get(src)??''));return '';}
  return '';
 };
 return {execFileSync};
}
function main(){
 const args=process.argv.slice(2),dash=args.indexOf('--'),cli=dash>=0?args.slice(0,dash):args,synthetic=cli.includes('--synthetic'),fileAt=cli.indexOf('--private-file'),imageAt=cli.indexOf('--image'),contextAt=cli.indexOf('--docker-context');
  const value=index=>cli[index+1];
 try{
  if(synthetic&&(fileAt>=0||imageAt>=0))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  const result=runSupervisedPilot({mode:synthetic?'synthetic':'real',env:process.env,privateFile:fileAt>=0?path.resolve(value(fileAt)):undefined,image:imageAt>=0?value(imageAt):undefined,dockerContext:contextAt>=0?value(contextAt):undefined,entryArgs:dash>=0?args.slice(dash+1):undefined,...(synthetic?{execFileSync:createRecordingDocker().execFileSync}:{})});
  console.log('CONTROLLED_REAL_READY');
  console.log(JSON.stringify(result.report));
  if(synthetic)result.stop();
 }catch(error){
  const code=typeof error?.message==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'PILOT_LAUNCH_FAILED';
  console.error(code);process.exitCode=1;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
