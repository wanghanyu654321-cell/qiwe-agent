import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';

// Own the verifier child tree, including Vitest workers and the Docker CLI.
export function runLocalVerification(command,args,{cwd,env,timeout,log}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let failure,settled=false,bytes=0;
  const finish=(error,status)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(status);};
  const stop=reason=>{
   if(failure)return;failure=Error(reason);
   const killed=spawnSync(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{encoding:'utf8',timeout:10000,windowsHide:true});
   if(killed.status!==0){failure.processTreeUnconfirmed=true;finish(failure);}
  };
  const timer=setTimeout(()=>stop('REAL_CONTAINER_PROCESS_TIMEOUT'),timeout);
  const output=data=>{bytes+=data.length;if(bytes>16*1024*1024){stop('REAL_CONTAINER_OUTPUT_LIMIT');return;}fs.appendFileSync(log,data);};
  fs.writeFileSync(log,'');child.stdout.on('data',output);child.stderr.on('data',output);
  child.on('error',error=>finish(error));child.on('close',status=>finish(failure,status));
 });
}

export function cleanupOwnedContainers({docker,endpoint,manifest,runId,ownedContainerPrefix}){
 if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('REAL_CONTAINER_CLEANUP_RUN_ID');
 if(ownedContainerPrefix!==undefined&&!/^miniclaw-[A-Za-z0-9][A-Za-z0-9_.-]{0,127}-$/.test(ownedContainerPrefix))throw Error('REAL_CONTAINER_CLEANUP_PREFIX');
 const namesAllowed=ownedContainerPrefix===undefined?/^miniclaw-synthetic-[a-z0-9-]+$/:new RegExp('^'+ownedContainerPrefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[a-z0-9-]+$');
 const names=fs.existsSync(manifest)?[...new Set(fs.readFileSync(manifest,'utf8').split(/\r?\n/).filter(Boolean))]:[];
 // The unchanged original-shell preflight records its exact per-run probe as
 // well as runner containers. It is normally already removed by --rm.
 if(names.some(name=>!namesAllowed.test(name)&&name!=='miniclaw-synthetic-image-'+runId))throw Error('REAL_CONTAINER_UNSAFE_OWNED_MANIFEST');
 const results=[];
 for(const name of names){
  const inspected=spawnSync(docker,['--host',endpoint,'inspect',name,'--format','{{json .Config.Labels}}'],{encoding:'utf8',timeout:15000,windowsHide:true});
  if(inspected.status===0){
   let labels;try{labels=JSON.parse(inspected.stdout);}catch{}
   if(labels?.['qiwe.verification-run']!==runId){results.push({name,absent:false,error:'ownership-mismatch'});continue;}
  }else{
   const absent=spawnSync(docker,['--host',endpoint,'ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}'],{encoding:'utf8',timeout:15000,windowsHide:true});
   results.push({name,absent:absent.status===0&&absent.stdout.trim()==='',removeStatus:null});continue;
  }
  const removed=spawnSync(docker,['--host',endpoint,'rm','-f',name],{encoding:'utf8',timeout:15000,windowsHide:true});
  const listed=spawnSync(docker,['--host',endpoint,'ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}'],{encoding:'utf8',timeout:15000,windowsHide:true});
  results.push({name,removeStatus:removed.status,absent:listed.status===0&&listed.stdout.trim()===''});
 }
 if(results.some(result=>!result.absent)){const error=Error('REAL_CONTAINER_CLEANUP_UNCONFIRMED');error.cleanup=results;throw error;}
 return results;
}
