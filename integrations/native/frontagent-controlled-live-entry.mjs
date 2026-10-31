import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function validatePilotPrivateInput(value){
 const invalid=()=>{throw Error('CONTROLLED_REAL_PRIVATE_INPUT_INVALID');};
 const bot=value?.bot,model=value?.model,valid=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\s\u0000]/.test(v);
 if(![bot?.botId,bot?.corpId,bot?.secret,model?.apiKey].every(valid)||model.baseUrl!=='https://api.deepseek.com/anthropic'||model.model!=='deepseek-flash')invalid();
 return {bot:{botId:bot.botId,corpId:bot.corpId,secret:bot.secret},model:{apiKey:model.apiKey,baseUrl:model.baseUrl,model:model.model}};
}

function readPrivateInput(){
 const fd=fs.openSync('/tmp/qiwe-live-pilot.private.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.uid!==1000||stat.nlink!==1||(stat.mode&0o077)!==0||stat.size>16384)throw Error('CONTROLLED_REAL_PRIVATE_INPUT_INVALID');return validatePilotPrivateInput(JSON.parse(fs.readFileSync(fd,'utf8')));}
 finally{fs.closeSync(fd);}
}

async function main(){
 // Isolated-synthetic is not a production switch. A real private file, real token, or controlled-real flag refuses this path.
 if(process.env.QIWE_PILOT_ENTRY_MODE==='isolated-synthetic'){
  if(process.env.QIWE_CONTROLLED_REAL_PILOT==='1')throw Error('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
  const {runIsolatedSyntheticWorker}=await import('./isolated-synthetic-pilot.mjs');
  await runIsolatedSyntheticWorker({dataDir:process.env.QIWE_SYNTHETIC_DATA_DIR,folder:process.env.QIWE_SYNTHETIC_FOLDER,privateConfigPath:'/tmp/qiwe-live-pilot.private.json',env:process.env});
  return;
 }
 if(process.platform!=='linux'||process.env.QIWE_CONTROLLED_REAL_PILOT!=='1')throw Error('CONTROLLED_REAL_ENTRY_FORBIDDEN');
 const scope=JSON.parse(process.env.QIWE_CONTROLLED_REAL_SCOPE??'null');
 if(!scope||scope.mode!=='controlled-real-pilot'||scope.environment!=='local-test'||scope.runId!==process.env.QIWE_LOCAL_DOCKER_RUN_ID||scope.networkName!==process.env.QIWE_LOCAL_DOCKER_NETWORK||!Number.isSafeInteger(scope.expiresAt)||scope.expiresAt<=Date.now()||scope.expiresAt>Date.now()+1800000)throw Error('CONTROLLED_REAL_ENTRY_FORBIDDEN');
 const privateInput=readPrivateInput(),root=process.cwd(),descriptor=JSON.parse(fs.readFileSync(path.join(process.env.QIWE_FRONTAGENT_EXISTING_INPUT,'descriptor.json'),'utf8'));
 const {startControlledLiveWorker}=await import('./frontagent-controlled-live-worker.mjs');
 const worker=await startControlledLiveWorker({root,descriptor,scope,base:'http://127.0.0.1:39130',readCredentials:()=>({...privateInput.bot}),readModelCredentials:()=>({...privateInput.model}),
  transportOptions:{root,folder:descriptor.folder,accountId:descriptor.accountId,image:process.env.MINICLAW_CONTAINER_IMAGE,originalShell:JSON.parse(process.env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL),controlledRealPilot:scope,manifest:process.env.QIWE_REAL_CONTAINER_OWNED_MANIFEST,preload:path.join(root,'controlled-real-preload.mjs'),modelModule:path.join(root,'controlled-real-model.ts')}});
 try{
  if(worker.activate()!==true)throw Error('CONTROLLED_REAL_ACTIVATION_FAILED');
  console.log('CONTROLLED_REAL_READY');
  await new Promise(resolve=>{const stop=()=>{clearTimeout(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};const timer=setTimeout(stop,Math.max(1,scope.expiresAt-Date.now()));process.once('SIGINT',stop);process.once('SIGTERM',stop);});
 }finally{await worker.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{const code=typeof error?.message==='string'&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'CONTROLLED_REAL_ENTRY_FAILED';console.error(code);process.exitCode=1;});
