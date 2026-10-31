import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {installControlledRealContainerTransport} from './controlled-real-container-transport.mjs';
import {restoreExistingFrontagentHost} from './frontagent-pilot-restoration.mjs';
import {prepareExistingFrontagentPilot} from './frontagent-controlled-pilot.mjs';

const fail=code=>{throw Error('FRONTAGENT_LIVE_'+code);};
function absent(file){
 try{fs.lstatSync(file);return false;}catch(error){if(error?.code==='ENOENT')return true;throw error;}
}
const scopeKeys=['mode','environment','runId','expiresAt','networkName'];
const sameScope=(a,b)=>!!a&&!!b&&scopeKeys.every(key=>a[key]===b[key]);
export async function preloadOriginalRestorationBoundary(root){
 return import(pathToFileURL(path.join(root,'src/full-host-local-docker.mjs')).href);
}
export function writeControlledLiveFailureMarker(root,runId,codes){
 if(!path.isAbsolute(root??'')||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId??'')||
    !Array.isArray(codes)||!codes.length||codes.some(code=>typeof code!=='string'||!/^FRONTAGENT_LIVE_(?:START_FAILED|CLEANUP_[A-Z]+_UNKNOWN)$/.test(code)))fail('MARKER_INPUT_INVALID');
 const fd=fs.openSync(path.join(root,'frontagent-live-cleanup-unknown.json'),'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify({runId,codes}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function createControlledLiveShutdown(resources){
 let once;
 return ()=>once??=(async()=>{
  const errors=resources.initialFailure?[Error('FRONTAGENT_LIVE_START_FAILED')]:[];
  const step=async(name,action)=>{try{await action();}catch{errors.push(Error('FRONTAGENT_LIVE_CLEANUP_'+name+'_UNKNOWN'));}};
  if(resources.pilot)await step('PILOT',async()=>{await resources.pilot.close();if(resources.pilot.status()!=='closed')throw Error('unknown');});
  if(resources.host?.fullHostQueue)await step('QUEUE',()=>resources.host.fullHostQueue.shutdown(15000));
  if(resources.transport)await step('TRANSPORT',()=>resources.transport.close());
  for(const [name,key]of [['TASKS','tasks'],['LEDGER','ledger'],['GRANTS','grants'],['SQL','sql']])if(resources[key])await step(name,()=>resources[key].close());
  await step('ENVIRONMENT',()=>resources.restoreEnvironment());
  let recorded=false,reportFailed=false;
  const report=()=>{
   try{if(typeof resources.reportUnknown!=='function')throw Error('missing');const result=resources.reportUnknown(errors.map(error=>error.message));if(result&&typeof result.then==='function')throw Error('async');recorded=true;}
   catch{errors.push(Error('FRONTAGENT_LIVE_CLEANUP_REPORT_UNKNOWN'));reportFailed=true;}
  };
  if(errors.length)report();
  if(!reportFailed)await step('SIGNAL',()=>resources.signalOriginal());
  if(errors.length&&!recorded&&!reportFailed)report();
  if(errors.length)throw new AggregateError(errors,'FRONTAGENT_LIVE_CLEANUP_UNKNOWN');
 })();
}

/** Called in the isolated supervised child; it never activates the channel. */
export async function startControlledLiveWorker(options){
 const {root,base,readCredentials,readModelCredentials}=options,descriptor=structuredClone(options.descriptor),scope=structuredClone(options.scope),transportOptions=options.transportOptions;
 if(!path.isAbsolute(root??'')||!descriptor||!/^\w[\w-]*$/.test(descriptor.accountId??'')||! /^[a-z0-9][a-z0-9_-]{0,127}$/.test(descriptor.folder??'')||
    !scope||scope.mode!=='controlled-real-pilot'||scope.environment!=='local-test'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(scope.runId??'')||
    scope.networkName!=='qiwe-pilot-'+scope.runId||!Number.isSafeInteger(scope.expiresAt)||scope.expiresAt<=Date.now()||scope.expiresAt>Date.now()+1800000||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(base??'')||!new URL(base).port||
    !transportOptions||transportOptions.root!==root||transportOptions.folder!==descriptor.folder||transportOptions.accountId!==descriptor.accountId||!sameScope(transportOptions.controlledRealPilot,scope)||
    typeof readCredentials!=='function'||typeof readModelCredentials!=='function')fail('INPUT_INVALID');
 const marker=path.join(root,'frontagent-live-cleanup-unknown.json');
 if(!absent(marker))fail('CLEANUP_MARKER_PRESENT');
 const configDir=path.join(root,'data/config'),providerFile=path.join(configDir,'claude-provider.json'),folderFile=path.join(configDir,'container-env',descriptor.folder+'.json');
 const checkProvider=()=>{if(!absent(providerFile)||!absent(folderFile))fail('PROVIDER_CONFIG_PRESENT');};
 checkProvider();
 const model=readModelCredentials(),bot=readCredentials();
 if(!model||typeof model.apiKey!=='string'||!model.apiKey.trim()||model.baseUrl!=='https://api.deepseek.com/anthropic'||model.model!=='deepseek-flash'||
    !bot||!bot.botId||!bot.corpId||typeof bot.secret!=='string'||!bot.secret.trim())fail('CREDENTIAL_CONFIG_INVALID');
 if(fs.realpathSync(root)!==process.cwd())fail('ROOT_MISMATCH');
 const controlledEnv={ANTHROPIC_API_KEY:model.apiKey,ANTHROPIC_BASE_URL:model.baseUrl,ANTHROPIC_MODEL:model.model,MINICLAW_AGENT_RUNTIME:'pi',WEB_PORT:new URL(base).port};
 const clearKeys=['ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'],keys=[...Object.keys(controlledEnv),...clearKeys];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 for(const key of clearKeys)delete process.env[key];for(const [key,value]of Object.entries(controlledEnv))process.env[key]=value;
 let transport,host,sql,grants,ledger,tasks,pilot,timer,startupFailed=false;
 const restoreEnvironment=()=>{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];};
 const closeResources=createControlledLiveShutdown({
  get initialFailure(){return startupFailed;},get pilot(){return pilot;},get host(){return host;},get transport(){return transport;},
  get tasks(){return tasks;},get ledger(){return ledger;},get grants(){return grants;},get sql(){return sql;},
  restoreEnvironment,
  reportUnknown:codes=>writeControlledLiveFailureMarker(root,scope.runId,codes),
  // The original main owns scheduler, Web, native DB and final process exit.
  signalOriginal:()=>{if(host){if(!process.listenerCount('SIGTERM'))throw Error('missing original handler');process.emit('SIGTERM');}}
 });
 const shutdown=()=>{if(timer)clearTimeout(timer);return closeResources();};
 try{
  checkProvider();
  await preloadOriginalRestorationBoundary(root);
  transport=installControlledRealContainerTransport(transportOptions);
  const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
  const db=await load('src/db.js'),config=await load('src/config.js'),context=await load('src/web-context.js');
  await load('src/web.js');
  if(path.resolve(config.DATA_DIR)!==path.join(root,'data')||path.resolve(config.STORE_DIR)!==path.join(root,'data/db'))fail('DATA_ROOT_MISMATCH');
  host=await load('src/index.js');
  const end=Date.now()+15000;
  while(!context.getWebDeps()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));
  if(!context.getWebDeps()||context.getWebDeps().queue!==host.fullHostQueue||host.fullHostBootGate.phase()!=='paused')fail('ORIGINAL_HOST_NOT_PAUSED');
  // Authentication is attempted only against the same loopback listener.
  while(Date.now()<end){try{const response=await fetch(base+'/api/auth/me',{headers:{cookie:descriptor.adminCookie},redirect:'error',signal:AbortSignal.timeout(500)});if(response.status>0)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  if(Date.now()>=end)fail('ORIGINAL_WEB_NOT_READY');
  const auth=await load('src/auth.js'),classifier=await load('src/full-host-restoration-classifier.js');
  const Database=createRequire(path.join(root,'package.json'))('better-sqlite3');
  sql=new Database(path.join(config.STORE_DIR,'messages.db'),{readonly:true,fileMustExist:true});
  const restoration=await restoreExistingFrontagentHost({sql,host,db,auth,base,adminCookie:descriptor.adminCookie,classifyRestorationRow:classifier.classifyRestorationRow});
  if(!restoration.restored||host.fullHostBootGate.phase()!=='ready')fail('RESTORE_UNPROVEN');
  checkProvider();transport.prepare(config);transport.activate(host.fullHostBootGate);
  const [access,manager,taskStore,bindings,botContext,botPilot,roleOverlay,conversationOverlay]=await Promise.all([
   load('test-support/workbench-access.mjs'),load('test-support/manager-store.mjs'),load('test-support/wecom-bot-task-store.mjs'),
   load('test-support/wecom-bot-bindings.mjs'),load('test-support/wecom-bot-context.mjs'),load('test-support/wecom-bot-pilot.mjs'),
   load('test-support/role-workspace-overlay.mjs'),load('test-support/conversation-overlay.mjs')]);
  const bindingFile=path.join(config.DATA_DIR,'frontagent-wecom-bindings.json'),approvedFile=path.join(config.DATA_DIR,'frontagent-approved-roles.json');
  const grantFile=path.join(config.DATA_DIR,'frontagent-workbench-access.sqlite'),ledgerFile=path.join(root,'manager/reports.sqlite');
  if(!fs.existsSync(grantFile)||!fs.existsSync(ledgerFile))fail('ORIGINAL_STORE_MISSING');
  grants=new access.WorkbenchAccessStore(grantFile);ledger=new manager.ManagerStore(ledgerFile);tasks=new taskStore.BotTaskStore(ledgerFile);
  const checkedCredentials=()=>{checkProvider();const current=readCredentials(),currentModel=readModelCredentials();
   if(!currentModel||currentModel.apiKey!==model.apiKey||currentModel.baseUrl!==model.baseUrl||currentModel.model!==model.model)fail('MODEL_CREDENTIAL_CHANGED');
   return current;};
  const modules={...bindings,...botContext,...botPilot,...roleOverlay,...conversationOverlay};
  pilot=await prepareExistingFrontagentPilot({descriptor,gate:host.fullHostBootGate,db,host,grants,ledger,tasks,
   readBindings:()=>JSON.parse(fs.readFileSync(bindingFile,'utf8')),readApproved:()=>JSON.parse(fs.readFileSync(approvedFile,'utf8')),
   readCredentials:checkedCredentials,runId:scope.runId,expiresAt:scope.expiresAt,journalDirectory:path.join(root,'unused-existing-role-journal'),modules,
   ...(options.onDelivery?{onDelivery:(_id,result)=>options.onDelivery({states:(result.deliveries??[]).map(delivery=>delivery.state),deferred:!!result.deferred})}:{}),
   ...(options.onOutcome?{onOutcome:()=>options.onOutcome()}:{}),
  });
  timer=setTimeout(()=>{void shutdown().catch(()=>{console.error('FRONTAGENT_LIVE_CLEANUP_UNKNOWN');try{options.onFailure?.('FRONTAGENT_LIVE_CLEANUP_UNKNOWN');}catch{}});},Math.max(1,scope.expiresAt-Date.now()));timer.unref();
  return Object.freeze({activate:()=>{checkProvider();return pilot.activate();},status:()=>pilot.status(),idle:()=>pilot.idle(),close:shutdown});
 }catch(error){
  startupFailed=true;
  try{await shutdown();}catch(cleanupError){
   const failure=new AggregateError(cleanupError.errors??[Error('FRONTAGENT_LIVE_START_FAILED')],'FRONTAGENT_LIVE_START_OR_CLEANUP_FAILED');
   Object.defineProperty(failure,'originalError',{value:error,enumerable:false});throw failure;
  }
  throw error;
 }
}
