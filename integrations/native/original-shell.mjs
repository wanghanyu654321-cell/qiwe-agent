import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
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

// A fixed read-only offline probe only. It cannot run the application, mount a
// host root, use a daemon socket, pull an image, or accept a shell command.
export function verifyOriginalShellImage({source,buildInput,image,docker,endpoint,runId,manifest,runnerHashes}){
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('ORIGINAL_SHELL_IMAGE_DIGEST_REQUIRED');
 const input=JSON.parse(fs.readFileSync(buildInput,'utf8')),container=path.resolve(source,'../container');
 if(fs.realpathSync(input.source)!==fs.realpathSync(container)||!path.isAbsolute(input.context))throw Error('ORIGINAL_SHELL_BUILD_SOURCE');
 const sourceHashes={...originalShellHelpers,Dockerfile:'fbc6077c10535cbc65e2f7d4815cdf00971be249adcac8dde2f7de8b14e7e61a',...Object.fromEntries(Object.entries(runnerHashes).map(([name,hash])=>['agent-runner/'+name,hash]))};
 for(const name of ['agent-runner/package.json','agent-runner/package-lock.json','agent-runner/tsconfig.json'])sourceHashes[name]=hashFile(path.join(container,name));
 for(const [name,hash]of Object.entries(sourceHashes)){
  if(input.files?.[name]!==hash||hashFile(path.join(container,name))!==hash||hashFile(path.join(input.context,name))!==hash)throw Error('ORIGINAL_SHELL_BUILD_INPUT: '+name);
 }
 const files=Object.fromEntries(Object.entries(sourceHashes).filter(([name])=>name!=='Dockerfile').map(([name,hash])=>[name.replace(/^agent-runner\//,''),hash]));
 const invoke=args=>{
  const result=spawnSync(docker,['--host',endpoint,...args],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true});
  if(result.status!==0)throw Error('ORIGINAL_SHELL_PREFLIGHT_FAILED: '+(result.error?.message??result.stderr));
  return result.stdout;
 };
 const inspection=JSON.parse(invoke(['image','inspect',image]))[0];
 if(inspection?.Id!==image||JSON.stringify(inspection.Config?.Entrypoint)!=='["/app/entrypoint.sh"]')throw Error('ORIGINAL_SHELL_IMAGE');
 const name='miniclaw-synthetic-image-'+runId;
 fs.appendFileSync(manifest,name+'\n');
 const program=`const fs=require('node:fs'),crypto=require('node:crypto');const names=${JSON.stringify(Object.keys(files))};const version=name=>JSON.parse(fs.readFileSync('/app/node_modules/'+name+'/package.json','utf8')).version;console.log(JSON.stringify({files:Object.fromEntries(names.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex')])),piVersion:version('@earendil-works/pi-coding-agent'),piAiVersions:{topLevel:version('@earendil-works/pi-ai'),nested:version('@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai')}}));`;
 const probe=JSON.parse(invoke(['run','--rm','--name',name,'--pull=never','--label','qiwe.verification-run='+runId,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--entrypoint','node',image,'-e',program]));
 return {...validateOriginalShellImage(inspection,probe,{image,files}),build:{inputHash:hashFile(buildInput),source:container,context:input.context,base:input.base,files:sourceHashes,provenance:input},inspection};
}

export function prepareOriginalShellCandidate(runner){
 // Import only the model-I/O fixture. The unchanged shell still compiles and
 // launches this candidate's original main; no alternate entrypoint is used.
 fs.writeFileSync(runner.entryFile,"await import('/verification/provider.mjs' as string);\n"+fs.readFileSync(runner.entryFile,'utf8'));
}
