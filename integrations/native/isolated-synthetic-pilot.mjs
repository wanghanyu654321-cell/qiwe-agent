import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPilotRunLedger,openPilotRunLedger,openRestartLookup} from './controlled-real-run-budget.mjs';
import {disposeConfirmedNewPilotEnv,witnessPilotEnvAbsence} from './controlled-real-env-disposition.mjs';
import {assertIsolatedSyntheticClosed,PILOT_PRIVATE_CONFIG_PATH} from './pilot-private-bootstrap.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const runner=path.join(here,'isolated-synthetic-runner.mjs');
const entry=path.join(here,'frontagent-controlled-live-entry.mjs');
const childOrder=['env-witness','runner-spawn','runner-exit','env-dispose'];
const fail=code=>{throw Error(code);};
function defaultSpawn(command,args,options){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,options);
  child.once('error',reject);
  child.once('close',(code,signal)=>resolve({code:code??null,signal:signal??null}));
 });
}
export async function runIsolatedSyntheticWorker(options={}){
 const env=options.env??process.env,privateConfigPath=options.privateConfigPath??PILOT_PRIVATE_CONFIG_PATH;
 assertIsolatedSyntheticClosed(env,privateConfigPath);
 if(process.platform!=='linux')fail('ISOLATED_SYNTHETIC_LINUX_REQUIRED');
 const {dataDir,folder}=options;
 if(typeof dataDir!=='string'||!path.isAbsolute(dataDir)||typeof folder!=='string'||!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(folder))fail('ISOLATED_SYNTHETIC_INPUT_INVALID');
 const rootStat=fs.lstatSync(dataDir);
 if(rootStat.isSymbolicLink()||!rootStat.isDirectory())fail('ISOLATED_SYNTHETIC_INPUT_INVALID');
 const witness=witnessPilotEnvAbsence(dataDir,folder);
 if(witness.status!=='absent')fail('ISOLATED_SYNTHETIC_ENV_PRESENT');
 const order=['env-witness','runner-spawn'];
 const envFile=path.join(dataDir,'env',folder,'default','main','env');
 const exited=await (options.spawnImpl??defaultSpawn)(process.execPath,[runner,envFile],{stdio:'ignore',env:{PATH:typeof env.PATH==='string'?env.PATH:''}});
 order.push('runner-exit');
 if(!exited||exited.code!==0||exited.signal)fail('ISOLATED_SYNTHETIC_RUNNER_FAILED');
 const disposed=disposeConfirmedNewPilotEnv(dataDir,folder,witness,{state:'exited',exitCode:exited.code,signal:exited.signal??null});
 order.push('env-dispose');
 if(JSON.stringify(order)!==JSON.stringify(childOrder)||disposed.disposed!==true||disposed.reason!=='new_run_file_removed')fail('ISOLATED_SYNTHETIC_ENV_NOT_WRITTEN');
 fs.writeFileSync(path.join(dataDir,'synthetic-order.json'),JSON.stringify(order),{mode:0o600});
 return Object.freeze({order,disposed:disposed.reason});
}
function defaultSpawnEntry(childEnv){
 const result=spawnSync(process.execPath,[entry],{env:childEnv,encoding:'utf8',timeout:15000});
 return {status:result.status??1,stderr:result.stderr??''};
}
export async function runIsolatedSyntheticFormalPath(options={}){
 const args=options.args??[],env=options.env??process.env,privateConfigPath=options.privateConfigPath??PILOT_PRIVATE_CONFIG_PATH;
 if(args.includes('--controlled-real-pilot')||env.QIWE_CONTROLLED_REAL_PILOT==='1')fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
 if(args.length!==1||args[0]!=='--isolated-synthetic')fail('ISOLATED_SYNTHETIC_ARGUMENTS');
 assertIsolatedSyntheticClosed(env,privateConfigPath);
 if(process.platform!=='linux')fail('ISOLATED_SYNTHETIC_LINUX_REQUIRED');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-isolated-synthetic-')),dataDir=path.join(root,'data'),ledgerPath=path.join(root,'pilot-model-ledger.json');
 fs.mkdirSync(dataDir);
 const runId=randomUUID(),expiresAt=Date.now()+60_000;
 try{
  createPilotRunLedger(ledgerPath,{runId,maxRequests:8,expiresAt});
  const childEnv={PATH:typeof env.PATH==='string'?env.PATH:'',QIWE_PILOT_ENTRY_MODE:'isolated-synthetic',QIWE_SYNTHETIC_DATA_DIR:dataDir,QIWE_SYNTHETIC_FOLDER:'marketing'};
  const child=await (options.spawnEntry??defaultSpawnEntry)(childEnv,dataDir);
  if(!child||child.status!==0){const code=String(child?.stderr??'').trim();fail(/^[A-Z0-9_]{1,80}$/.test(code)?code:'ISOLATED_SYNTHETIC_RUNNER_FAILED');}
  const seen=JSON.parse(fs.readFileSync(path.join(dataDir,'synthetic-order.json'),'utf8'));
  if(JSON.stringify(seen)!==JSON.stringify(childOrder))fail('ISOLATED_SYNTHETIC_RUNNER_FAILED');
  const lookup=openRestartLookup(ledgerPath,runId);
  let restart,reserve;
  try{lookup.startRunner();fail('ISOLATED_SYNTHETIC_RESTART_RAN');}catch(error){if(!String(error?.message).includes('PILOT_RESTART_RUNNER_FORBIDDEN'))throw error;restart='PILOT_RESTART_RUNNER_FORBIDDEN';}
  try{lookup.reserve();fail('ISOLATED_SYNTHETIC_RESTART_RESERVED');}catch(error){if(!String(error?.message).includes('PILOT_RESTART_BUDGET_FORBIDDEN'))throw error;reserve='PILOT_RESTART_BUDGET_FORBIDDEN';}
  lookup.read(()=>undefined);
  const reserved=openPilotRunLedger(ledgerPath,{runId,maxRequests:8,expiresAt}).reserved;
  return {status:'isolated-synthetic-stopped',order:['ledger-create',...seen,'restart-lookup'],disposed:'new_run_file_removed',restart,reserve,reserved,ledgerPath,runId,expiresAt,root};
 }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
}
