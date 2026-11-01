import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
// Captured before the fixture denies general process creation. Fixed read-only observations only.
const execute=execFileSync;
export const localDocker='/qiwe-control/docker',localEndpoint='unix:///qiwe-control/docker.sock';
const fail=()=>{throw Error('LOCAL_DOCKER_BOUNDARY_UNVERIFIED');};
const sha=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value??'');
const overlaps=(a,b)=>a===b||a.startsWith(b==='/'?'/':b+'/')||b.startsWith(a==='/'?'/':a+'/');
function invoke(args){return execute(localDocker,['--host',localEndpoint,...args],{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});}
export function validateControlledRealPilotScope(scope,runId){
 if(!scope||JSON.stringify(Object.keys(scope).sort())!==JSON.stringify(['environment','expiresAt','mode','networkName','runId'])||
  scope.mode!=='controlled-real-pilot'||scope.environment!=='local-test'||!uuid(runId)||scope.runId!==runId||scope.networkName!=='qiwe-pilot-'+runId||
  !Number.isSafeInteger(scope.expiresAt)||scope.expiresAt<=Date.now()||scope.expiresAt>Date.now()+3600000)return fail();
 return Object.freeze({...scope});
}
function pilotEnvironment(scope){
 validateControlledRealPilotScope(scope,process.env.QIWE_LOCAL_DOCKER_RUN_ID);
 if(process.env.QIWE_CONTROLLED_REAL_PILOT!=='1'||process.env.QIWE_LOCAL_DOCKER_NETWORK!==scope.networkName||process.env.QIWE_RESTORATION_REAL_CONTAINER!=='1')return fail();
}
const networkIdentity=network=>Object.fromEntries(['Id','Name','Driver','Scope','Internal','Attachable','Ingress','EnableIPv6','Labels','Options','IPAM'].map(key=>[key,network?.[key]]));
const safeBridgeOptions=options=>!!options&&Object.entries(options).every(([key,value])=>
 (key==='com.docker.network.enable_ipv4'&&value==='true')||(key==='com.docker.network.enable_ipv6'&&value==='false'));
function validatePilotNetwork(facts,expected){
 const scope=validateControlledRealPilotScope(expected.controlledRealPilot,expected.runId),{host,network}=facts;
 if(!expected.network||JSON.stringify(networkIdentity(network))!==JSON.stringify(expected.network)||!/^([a-f0-9]{64})$/.test(network?.Id??'')||
  network.Name!==scope.networkName||network.Driver!=='bridge'||network.Scope!=='local'||network.Internal!==false||network.Attachable!==false||network.Ingress!==false||network.EnableIPv6!==false||
  network.Labels?.['qiwe.verification-run']!==scope.runId||network.Labels?.['qiwe.controlled-real-pilot']!=='local-test'||!safeBridgeOptions(network.Options)||
  !network.Containers||JSON.stringify(Object.keys(network.Containers))!==JSON.stringify([expected.hostId])||
  host.HostConfig.NetworkMode!==scope.networkName||host.HostConfig.PublishAllPorts!==false||!host.HostConfig.PortBindings||Object.keys(host.HostConfig.PortBindings).length||
  !host.NetworkSettings?.Networks||JSON.stringify(Object.keys(host.NetworkSettings.Networks))!==JSON.stringify([scope.networkName])||
  host.NetworkSettings.Networks[scope.networkName].NetworkID!==network.Id||
  !network.Containers[expected.hostId].EndpointID||network.Containers[expected.hostId].EndpointID!==host.NetworkSettings.Networks[scope.networkName].EndpointID||
  !host.NetworkSettings.Ports||Object.values(host.NetworkSettings.Ports).some(bindings=>bindings!==null))return fail();
}
export function validateLocalDockerFacts(facts,expected){
 if(!expected||!uuid(expected.runId)||!expected.daemonId||!expected.volume||!/^\/var\/lib\/docker\/volumes\/[^/]+\/_data$/.test(expected.mountpoint??'')||!Array.isArray(expected.hostMounts))return fail();
 const {host,volume,containers}=facts??{};
 if(facts.daemonId!==expected.daemonId||volume?.Name!==expected.volume||volume.Mountpoint!==expected.mountpoint||volume.Driver!=='local'||volume.Labels?.['qiwe.verification-run']!==expected.runId||
  host?.Id!==expected.hostId||host.Config?.User!=='1000:1000'||host.Config?.Labels?.['qiwe.verification-run']!==expected.runId||!host.State?.Running||!host.HostConfig||(!expected.controlledRealPilot&&host.HostConfig.NetworkMode!=='none')||!host.HostConfig.ReadonlyRootfs||host.HostConfig.Privileged||!host.HostConfig.CapDrop?.includes('ALL')||!host.HostConfig.SecurityOpt?.includes('no-new-privileges')||
  JSON.stringify(host.Mounts)!==JSON.stringify(expected.hostMounts)||!Array.isArray(containers))return fail();
 if(expected.controlledRealPilot)validatePilotNetwork(facts,expected);
 const mount=host.Mounts.find(m=>m.Destination==='/tmp');
 if(mount?.Type!=='volume'||mount.Name!==expected.volume||mount.Source!==expected.mountpoint||mount.RW!==true)return fail();
 const expectedTargets=['/input','/qiwe-control/build-input.json','/qiwe-control/docker','/qiwe-control/docker.sock','/tmp'];
 if(JSON.stringify(host.Mounts.map(m=>m.Destination).sort())!==JSON.stringify(expectedTargets)||volume.Options&&Object.keys(volume.Options).length)return fail();
 for(const target of expectedTargets.filter(v=>v!=='/tmp')){const m=host.Mounts.find(m=>m.Destination===target);if(m.Type!=='bind'||(target!=='/qiwe-control/docker.sock'&&m.RW!==false))return fail();}
 if(containers.filter(c=>c.Id===expected.hostId).length!==1)return fail();
 for(const container of containers){
  if(container.Id===expected.oldContainerId)return fail();
  if(container.Id===expected.hostId)continue;
  if(!Array.isArray(container.Mounts))return fail();
  if(container.Mounts.some(m=>m.Name===expected.volume||typeof m.Source==='string'&&overlaps(m.Source,expected.mountpoint)))return fail();
 }
 return true;
}
export function translateLocalMounts(args,mountpoint){
 if(args[0]!=='run'||!/^\/var\/lib\/docker\/volumes\/[^/]+\/_data$/.test(mountpoint??''))return fail();
 const result=[...args];
 for(let i=1;i<result.length;i++)if(result[i]==='-v'){
  const raw=result[++i],match=/^(\/tmp\/[^:]+):(\/[^:]+)(:ro)?$/.exec(raw??'');
  if(!match||path.posix.normalize(match[1])!==match[1]||match[1].includes('\\'))return fail();
  result[i]=mountpoint+match[1].slice(4)+':'+match[2]+(match[3]??'');
 }
 return result;
}
export function readLocalDockerFacts(){
 if(process.platform!=='linux'||process.getuid?.()!==1000||process.getgid?.()!==1000)return fail();
 const runId=process.env.QIWE_LOCAL_DOCKER_RUN_ID,volume=process.env.QIWE_LOCAL_DOCKER_VOLUME,host=process.env.QIWE_LOCAL_DOCKER_HOST;
 if(!uuid(runId)||!/^qiwe-[a-z0-9-]+$/.test(volume??'')||!/^qiwe-[a-z0-9-]+$/.test(host??''))return fail();
 const ids=invoke(['ps','-aq','--no-trunc']).trim().split(/\s+/).filter(Boolean);
 if(!ids.length||ids.length>256||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))return fail();
 const containers=invoke(['inspect','--format','{"Id":{{json .Id}},"Mounts":{{json .Mounts}}}',...ids]).trim().split('\n').map(line=>JSON.parse(line));
 const networkName=process.env.QIWE_LOCAL_DOCKER_NETWORK;
 if(process.env.QIWE_CONTROLLED_REAL_PILOT==='1'&&networkName!=='qiwe-pilot-'+runId)return fail();
 return {daemonId:JSON.parse(invoke(['info','--format','{{json .ID}}'])),volume:JSON.parse(invoke(['volume','inspect',volume]))[0],host:JSON.parse(invoke(['inspect',host]))[0],containers,
  ...(process.env.QIWE_CONTROLLED_REAL_PILOT==='1'?{network:JSON.parse(invoke(['network','inspect',networkName]))[0]}:{})};
}
export function inspectLocalDockerReceipt(receipt){
 if(![2,3].includes(receipt?.version)||process.env.QIWE_RESTORATION_REAL_CONTAINER!=='1'||receipt.docker?.runId!==process.env.QIWE_LOCAL_DOCKER_RUN_ID)return fail();
 if(receipt.version===3){
  pilotEnvironment(receipt.controlledRealPilot);
  if(JSON.stringify(receipt.controlledRealPilot)!==JSON.stringify(receipt.docker.controlledRealPilot))return fail();
 }else if(receipt.controlledRealPilot||receipt.docker.controlledRealPilot||process.env.QIWE_CONTROLLED_REAL_PILOT==='1')return fail();
 validateLocalDockerFacts(readLocalDockerFacts(),receipt.docker);
 verifyControlFiles(receipt.docker.controls);
 const canary=receipt.docker.canary;
 if(!canary||!canary.path.startsWith(receipt.hostRoot.path+'/')||path.posix.normalize(canary.path)!==canary.path)return fail();
 const stat=fs.lstatSync(canary.path,{bigint:true});
 if(!stat.isFile()||String(stat.dev)!==canary.dev||String(stat.ino)!==canary.ino||sha(fs.readFileSync(canary.path))!==canary.sha256)return fail();
 if(!/^[a-f0-9]{64}$/.test(receipt.docker.oldContainerId??'')||receipt.docker.oldWriter?.updateChanges!==1)return fail();
 const dbPath=path.join(receipt.dataRoot.path,'db/messages.db'),database=fs.lstatSync(dbPath,{bigint:true}),proof=receipt.docker.oldWriter;
 if(proof.dbPath!==dbPath||!database.isFile()||String(database.dev)!==proof.database?.dev||String(database.ino)!==proof.database?.ino||
  receipt.docker.probe?.[1]?.path!==dbPath||receipt.docker.probe[1].dev!==proof.database.dev||receipt.docker.probe[1].ino!==proof.database.ino)return fail();
 return receipt.docker;
}
function controlFiles(){return Object.fromEntries([localDocker,'/qiwe-control/docker.sock','/qiwe-control/build-input.json'].map(file=>{const stat=fs.lstatSync(file,{bigint:true});if(file.endsWith('.sock')?!stat.isSocket():!stat.isFile())fail();return [file,{dev:String(stat.dev),ino:String(stat.ino),...(stat.isFile()?{sha256:sha(fs.readFileSync(file))}:{})}];}));}
function verifyControlFiles(expected){if(!expected||JSON.stringify(controlFiles())!==JSON.stringify(expected))fail();}
export async function observeLocalDockerBoundary(input){
 if(process.pid!==1||process.env.QIWE_RESTORATION_REAL_CONTAINER!=='1')return fail();
 const scope=input.controlledRealPilot;
 if(scope)pilotEnvironment(scope);else if(process.env.QIWE_CONTROLLED_REAL_PILOT==='1')return fail();
 const initial=readLocalDockerFacts(),runId=process.env.QIWE_LOCAL_DOCKER_RUN_ID;
 const expected={runId,daemonId:initial.daemonId,volume:initial.volume.Name,mountpoint:initial.volume.Mountpoint,hostId:initial.host.Id,hostMounts:initial.host.Mounts,
  ...(scope?{controlledRealPilot:scope,network:networkIdentity(initial.network)}:{})};
 validateLocalDockerFacts(initial,expected);
 expected.controls=controlFiles();
 const canaryPath=path.join(input.hostRoot,'.docker-canary-'+randomUUID()),content=randomUUID();fs.writeFileSync(canaryPath,content,{flag:'wx',mode:0o600});
 const stat=fs.statSync(canaryPath,{bigint:true});expected.canary={path:canaryPath,dev:String(stat.dev),ino:String(stat.ino),sha256:sha(content)};
 const name='qiwe-old-writer-'+randomUUID(),proofPath=path.join(input.hostRoot,'.docker-writer-'+randomUUID()+'.json');
 const image=process.env.QIWE_LOCAL_DOCKER_DRIVER_IMAGE;
 if(!/^sha256:[a-f0-9]{64}$/.test(image??''))return fail();
 const probeProgram=`const fs=require('node:fs'),c=require('node:crypto');const names=${JSON.stringify([input.hostRoot,input.dbPath,canaryPath])};console.log(JSON.stringify(names.map(p=>{const s=fs.statSync(p,{bigint:true});return {path:p,dev:String(s.dev),ino:String(s.ino),...(p===names[2]?{sha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:{})}})));`;
 const probe=JSON.parse(invoke(['run','--rm','--name','qiwe-read-probe-'+randomUUID(),'--pull=never','--label','qiwe.verification-run='+runId,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','-v',expected.volume+':/tmp:ro','--entrypoint','node',image,'-e',probeProgram]));
 for(const [i,item] of [input.host,input.database,expected.canary].entries())if(probe[i]?.dev!==item.dev||probe[i]?.ino!==item.ino||i===2&&probe[i]?.sha256!==item.sha256)fail();
 expected.probe=probe;
 const program=`const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');const x=${JSON.stringify({dbPath:input.dbPath,canaryPath,proofPath,runId})};const db=new DatabaseSync(x.dbPath);const before=db.prepare("SELECT value FROM router_state WHERE key='schema_version'").get();if(!before)throw Error('schema');const result=db.prepare("UPDATE router_state SET value=? WHERE key='schema_version' AND value=?").run(before.value,before.value);if(db.prepare("SELECT value FROM router_state WHERE key='schema_version'").get().value!==before.value)throw Error('readback');const stat=fs.statSync(x.canaryPath,{bigint:true}),root=fs.statSync(${JSON.stringify(input.hostRoot)},{bigint:true}),database=fs.statSync(x.dbPath,{bigint:true});fs.writeFileSync(x.proofPath,JSON.stringify({runId:x.runId,dbPath:x.dbPath,updateChanges:Number(result.changes),dev:String(stat.dev),ino:String(stat.ino),sha256:crypto.createHash('sha256').update(fs.readFileSync(x.canaryPath)).digest('hex'),root:{dev:String(root.dev),ino:String(root.ino)},database:{dev:String(database.dev),ino:String(database.ino)}}),{flag:'wx',mode:384});setInterval(()=>{},1000);`;
 let id;
 try{
  id=invoke(['run','-d','--name',name,'--pull=never','--label','qiwe.verification-run='+runId,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','-v',expected.volume+':/tmp','--entrypoint','node',image,'--no-warnings','-e',program]).trim();
  if(!/^[a-f0-9]{64}$/.test(id))return fail();
  const until=Date.now()+10000;while(!fs.existsSync(proofPath)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  const proof=JSON.parse(fs.readFileSync(proofPath,'utf8'));
  if(proof.runId!==runId||proof.dbPath!==input.dbPath||proof.updateChanges!==1||proof.dev!==expected.canary.dev||proof.ino!==expected.canary.ino||proof.sha256!==expected.canary.sha256||proof.root.dev!==input.host.dev||proof.root.ino!==input.host.ino||proof.database.dev!==input.database.dev||proof.database.ino!==input.database.ino)return fail();
  expected.oldWriter=proof;expected.oldContainerId=id;
 }finally{
  const listed=invoke(['ps','-aq','--no-trunc','--filter','name=^/'+name+'$']).trim();
  if(listed){const own=JSON.parse(invoke(['inspect',listed]))[0];if(own.Id!==listed||id&&own.Id!==id||own.Name!=='/'+name||own.Config.Labels?.['qiwe.verification-run']!==runId)fail();invoke(['stop','--time','2',listed]);invoke(['rm',listed]);}
  if(fs.existsSync(proofPath))fs.unlinkSync(proofPath);
 }
 if(scope)pilotEnvironment(scope);
 validateLocalDockerFacts(readLocalDockerFacts(),expected);
 return expected;
}
