import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {validateOriginalShellImage,originalShellHelpers} from './real-container-boundary.mjs';
export {originalShellHelpers};
const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Local build candidate only: originals, lock and runtime helpers stay intact. */
export function createOriginalShellDockerfileCandidate(source){
 const sourceHash=createHash('sha256').update(source).digest('hex');
 if(sourceHash!=='fbc6077c10535cbc65e2f7d4815cdf00971be249adcac8dde2f7de8b14e7e61a')throw Error('ORIGINAL_SHELL_DOCKERFILE_SOURCE');
 const changes=[
  {before:'&& apt-get update && apt-get install -y --no-install-recommends \\',after:'&& apt-get -o Acquire::Retries=5 update && ( attempt=0; until apt-get install -y --no-install-recommends \\'},
  {before:'    locales \\\n    && rm -rf /var/lib/apt/lists/*',after:'    locales; do attempt=$((attempt + 1)); [ "$attempt" -lt 3 ] || exit 100; done ) \\\n    && rm -rf /var/lib/apt/lists/*'},
  {before:'    && npm install --no-save --package-lock=false \\\n      "agent-browser@${AGENT_BROWSER_VERSION}" \\\n',after:'    && node -e "const fs=require(\'node:fs\'); const actual=JSON.parse(fs.readFileSync(\'/app/node_modules/agent-browser/package.json\',\'utf8\')).version; if(actual!==process.argv[1]) throw Error(\'LOCKED_AGENT_BROWSER_VERSION_MISMATCH: \'+actual);" "${AGENT_BROWSER_VERSION}" \\\n'},
 ];
 let dockerfile=source;
 for(const {before,after}of changes){if(dockerfile.split(before).length!==2)throw Error('ORIGINAL_SHELL_DOCKERFILE_ANCHOR');dockerfile=dockerfile.replace(before,after);}
 return {dockerfile,sourceHash,candidateHash:createHash('sha256').update(dockerfile).digest('hex'),changes};
}

function stepTimeout(step){const error=Error('FULL_HOST_STEP_TIMEOUT');error.step=step;return error;}
function hostStep(step,phase){console.log('FULL_HOST_STEP',JSON.stringify({step,phase}));}
export function socketPathFromEndpoint(endpoint){
 const match=/^unix:\/\/(\/.*)$/.exec(endpoint??'');
 if(!match)throw Error('FULL_HOST_DOCKER_SOCKET');
 return match[1];
}
/** Talk to the Engine API directly. A pinned version avoids the CLI negotiation that can stall on the Docker Desktop proxy socket. */
export function probeDockerSocket(socketPath,timeoutMs=60000){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(socketPath);
  let buf='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(value);};
  const timer=setTimeout(()=>finish(stepTimeout('docker-socket')),timeoutMs);
  socket.on('connect',()=>{socket.write('GET /v1.41/version HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');});
  socket.on('data',chunk=>{buf+=chunk;});
  socket.on('error',error=>{const wrapped=Error('FULL_HOST_DOCKER_SOCKET');wrapped.causeMessage=String(error?.code??error?.message??'');finish(wrapped);});
  socket.on('end',()=>{
   const split=buf.indexOf('\r\n\r\n');
   if(split<0||!buf.slice(0,split).includes(' 200 ')){finish(Error('FULL_HOST_DOCKER_SOCKET'));return;}
   try{const body=JSON.parse(buf.slice(split+4));if(typeof body.ApiVersion!=='string'||!/^\d+\.\d+$/.test(body.ApiVersion))finish(Error('FULL_HOST_DOCKER_SOCKET'));else finish(null,body);}
   catch{finish(Error('FULL_HOST_DOCKER_SOCKET'));}
  });
 });
}
export function runBoundedCommand(command,args,{timeoutMs=90000,step='docker-preflight',env}={}){
 return new Promise(resolve=>{
  const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='',settled=false;
  const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
  const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}child.unref();child.stdout?.destroy();child.stderr?.destroy();finish({status:null,stdout,stderr,timedOut:true,step});},timeoutMs);
  child.stdout.on('data',chunk=>{if(stdout.length<4*1024*1024)stdout+=chunk;});
  child.stderr.on('data',chunk=>{if(stderr.length<1024*1024)stderr+=chunk;});
  child.on('error',error=>finish({status:null,stdout,stderr:String(error?.message??''),timedOut:false,step}));
  child.on('close',status=>finish({status,stdout,stderr,timedOut:false,step}));
 });
}
// A fixed read-only offline probe only. It cannot run the application, mount a
// host root, use a daemon socket beyond this probe, pull an image, or accept a shell command.
export async function verifyOriginalShellImage({source,buildInput,image,docker,endpoint,runId,manifest,runnerHashes,probeTimeoutMs=60000,commandTimeoutMs=90000}={}){
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('ORIGINAL_SHELL_IMAGE_DIGEST_REQUIRED');
 hostStep('original-shell-input','start');
 const input=JSON.parse(fs.readFileSync(buildInput,'utf8')),container=path.resolve(source,'../container');
 if(fs.realpathSync(input.source)!==fs.realpathSync(container)||!path.isAbsolute(input.context))throw Error('ORIGINAL_SHELL_BUILD_SOURCE');
 const sourceHashes={...originalShellHelpers,Dockerfile:'fbc6077c10535cbc65e2f7d4815cdf00971be249adcac8dde2f7de8b14e7e61a',...Object.fromEntries(Object.entries(runnerHashes).map(([name,hash])=>['agent-runner/'+name,hash]))};
 for(const name of ['agent-runner/package.json','agent-runner/package-lock.json','agent-runner/tsconfig.json'])sourceHashes[name]=hashFile(path.join(container,name));
 for(const [name,hash]of Object.entries(sourceHashes)){
  if(input.files?.[name]!==hash||hashFile(path.join(container,name))!==hash||hashFile(path.join(input.context,name))!==hash)throw Error('ORIGINAL_SHELL_BUILD_INPUT: '+name);
 }
 hostStep('original-shell-input','done');
 const files=Object.fromEntries(Object.entries(sourceHashes).filter(([name])=>name!=='Dockerfile').map(([name,hash])=>[name.replace(/^agent-runner\//,''),hash]));
 const socketPath=socketPathFromEndpoint(endpoint);
 hostStep('docker-socket','start');
 const version=await probeDockerSocket(socketPath,probeTimeoutMs);
 hostStep('docker-socket','done');
 const configDir=path.join(process.env.TMPDIR??'/tmp','qiwe-docker-config');
 fs.mkdirSync(configDir,{recursive:true});
 fs.writeFileSync(path.join(configDir,'config.json'),'{}\n');
 const env={PATH:process.env.PATH??'',HOME:process.env.HOME??'/tmp',TMPDIR:process.env.TMPDIR??'/tmp',DOCKER_HOST:endpoint,DOCKER_API_VERSION:version.ApiVersion,DOCKER_CONFIG:configDir,DOCKER_CLI_HINTS:'false'};
 const invoke=async(args,step)=>{
  hostStep(step,'start');
  const result=await runBoundedCommand(docker,['--host',endpoint,...args],{timeoutMs:commandTimeoutMs,step,env});
  if(result.timedOut)throw stepTimeout(step);
  if(result.status!==0)throw Error('ORIGINAL_SHELL_PREFLIGHT_FAILED');
  hostStep(step,'done');
  return result.stdout;
 };
 const inspection=JSON.parse(await invoke(['image','inspect',image],'docker-image'))[0];
 if(inspection?.Id!==image||JSON.stringify(inspection.Config?.Entrypoint)!=='["/app/entrypoint.sh"]')throw Error('ORIGINAL_SHELL_IMAGE');
 const name='miniclaw-synthetic-image-'+runId;
 fs.appendFileSync(manifest,name+'\n');
 const program=`const fs=require('node:fs'),crypto=require('node:crypto');const names=${JSON.stringify(Object.keys(files))};const version=name=>JSON.parse(fs.readFileSync('/app/node_modules/'+name+'/package.json','utf8')).version;console.log(JSON.stringify({files:Object.fromEntries(names.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex')])),piVersion:version('@earendil-works/pi-coding-agent'),piAiVersions:{topLevel:version('@earendil-works/pi-ai'),nested:version('@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai')}}));`;
 const probe=JSON.parse(await invoke(['run','--rm','--name',name,'--pull=never','--label','qiwe.verification-run='+runId,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--entrypoint','node',image,'-e',program],'docker-probe'));
 return {...validateOriginalShellImage(inspection,probe,{image,files}),build:{inputHash:hashFile(buildInput),source:container,context:input.context,base:input.base,files:sourceHashes,provenance:input},inspection};
}

export function prepareOriginalShellCandidate(runner){
 // Import only the model-I/O fixture. The unchanged shell still compiles and
 // launches this candidate's original main; no alternate entrypoint is used.
 fs.writeFileSync(runner.entryFile,"await import('/verification/provider.mjs' as string);\n"+fs.readFileSync(runner.entryFile,'utf8'));
}
