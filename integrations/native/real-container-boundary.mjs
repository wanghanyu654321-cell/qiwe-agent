import fs from 'node:fs';
import path from 'node:path';

export const originalShellHelpers=Object.freeze({
 'entrypoint.sh':'7bf389abdba0a4206e097d4332d01a6bdb1bf9d73704756cde7d6fb66b4fbf8c',
 'session-generated-paths.mjs':'6f9d2d8e1b3f6ceb4f9d4650ea6664d6b13673d691ca95a2c629916ac00840b2',
 'session-permissions-mount.mjs':'a826dd07a4605ed16d34bd309492404c209de3bec36bcf03e536f655d4191bd0',
 'session-permissions-watcher.mjs':'3a21b99a060b300da30fb1aa1e63117f8fb1c2a68d5ef7facd52cbc7f6dd658c',
 'session-permissions.sh':'61b68087b41ff1cd65c01f6f2717d82258d15a27345e8d2a834b66c2a8d91b81',
 'session-prompts-copy.mjs':'636e94625735eccf5782a6a9b6b9755988b3309c2611b3b0f9231e758cb01aad',
});

export function validateOriginalShellImage(inspection,probe,{image,files}){
 if(!/^sha256:[a-f0-9]{64}$/.test(image)||inspection?.Id!==image||JSON.stringify(inspection.Config?.Entrypoint)!=='["/app/entrypoint.sh"]'||(inspection.Config?.Cmd!=null&&inspection.Config.Cmd.length!==0))throw Error('ORIGINAL_SHELL_IMAGE');
 if(probe?.piVersion!=='0.84.2')throw Error('ORIGINAL_SHELL_PI_VERSION');
 if(probe.piAiVersions?.topLevel!=='0.84.2'||probe.piAiVersions?.nested!=='0.84.2')throw Error('ORIGINAL_SHELL_PI_AI_VERSION');
 for(const [name,hash]of Object.entries(files))if(probe.files?.[name]!==hash)throw Error('ORIGINAL_SHELL_SOURCE: '+name);
 return Object.freeze({verified:true,image,entrypoint:[...inspection.Config.Entrypoint],piVersion:probe.piVersion,piAiVersions:{...probe.piAiVersions},files:{...probe.files}});
}

function admittedName(name,ownedContainerPrefix,defaultPattern){
 if(ownedContainerPrefix===undefined)return defaultPattern.test(name??'');
 return typeof ownedContainerPrefix==='string'&&/^miniclaw-[a-z0-9][a-z0-9_-]{0,127}-$/.test(ownedContainerPrefix)&&
  typeof name==='string'&&name.startsWith(ownedContainerPrefix)&&/^\d+$/.test(name.slice(ownedContainerPrefix.length));
}
export function admitDockerControl(command,args,owned,ownedContainerPrefix){
 if(command!=='docker')throw Error('REAL_CONTAINER_CONTROL_COMMAND');
 if(args.length===3&&args[0]==='info'&&args[1]==='--format'&&args[2]==='{{json .SecurityOptions}}')return [...args];
 if(args.length===2&&args[0]==='stop'&&admittedName(args[1],ownedContainerPrefix,/^miniclaw-synthetic-[a-z0-9-]+$/)&&owned.has(args[1]))return [...args];
 throw Error('REAL_CONTAINER_CONTROL_ARGUMENT');
}
export function admitDockerShell(command,owned,ownedContainerPrefix){
 const match=/^docker stop ([a-z0-9_-]+)$/.exec(command);
 if(!match)throw Error('REAL_CONTAINER_CONTROL_SHELL');
 return admitDockerControl('docker',['stop',match[1]],owned,ownedContainerPrefix);
}

export function admitLocalDockerSpawn(command,args,options,{ready,alreadyStarted,ownedContainerPrefix}){
 if(!ready||alreadyStarted||command!=='docker'||!admittedName(args?.[4],ownedContainerPrefix,/^miniclaw-synthetic-restoration-role-[a-z0-9-]+$/)||
  !options||Object.keys(options).join(',')!=='stdio'||JSON.stringify(options.stdio)!=='["pipe","pipe","pipe"]')throw Error('LOCAL_DOCKER_SPAWN_FORBIDDEN');
}

// The only admitted command is the original runner's docker run. No daemon
// socket or executable is exposed to the child; callers retain real pipes.
export function admitDockerRun(args,{root,runner,deps,provider,image,expectedMounts,runId,originalShell,startupFailure=false,expectedIdentity='virtualized',expectedUid,expectedGid,ownedContainerPrefix}){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId??''))throw Error('REAL_CONTAINER_RUN_ID');
 if(!expectedMounts||typeof expectedMounts!=='object')throw Error('REAL_CONTAINER_EXPECTED_MOUNTS');
 if(!/^(?:node@)?sha256:[a-f0-9]{64}$/.test(image)||args.at(-1)!==image)throw Error('REAL_CONTAINER_IMAGE');
 if(args[0]!=='run'||args[1]!=='-i'||args[2]!=='--rm'||args[3]!=='--name'||!admittedName(args[4],ownedContainerPrefix,/^miniclaw-synthetic-[a-z0-9-]+$/))throw Error('REAL_CONTAINER_ARGUMENT');
 const canonicalRoot=fs.realpathSync(root),mounts=[],destinations=new Set();
 for(let i=5;i<args.length-1;i+=2){
  const [flag,value]=args.slice(i,i+2);
  if(flag==='-e'){
   if(!/^(TZ=[A-Za-z0-9_/+:-]+|MINICLAW_HOST_IDENTITY_MODE=(direct|unknown|rootless|userns|host-root|virtualized)|MINICLAW_HOST_(UID|GID)=\d+)$/.test(value))throw Error('REAL_CONTAINER_ARGUMENT_ENV');
  }else if(flag==='-v'){
   if(typeof value!=='string')throw Error('REAL_CONTAINER_MOUNT');
   const readonly=value.endsWith(':ro'),volume=readonly?value.slice(0,-3):value,separator=volume.lastIndexOf(':');
   if(separator<1)throw Error('REAL_CONTAINER_MOUNT');
   const hostPath=volume.slice(0,separator),destination=volume.slice(separator+1);
   let source;try{source=fs.realpathSync(hostPath);}catch{throw Error('REAL_CONTAINER_MOUNT_MISSING '+JSON.stringify({source:hostPath,destination}));}
   const relative=path.relative(canonicalRoot,source);
   if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||destinations.has(destination)||!/^\/(workspace\/(group|ipc|extra|effective-skills\/[a-z0-9-]+|plugins|env-dir)|home\/node\/(\.claude(?:\.json)?|\.feishu-cli)|app\/(src|prompts))$/.test(destination))throw Error('REAL_CONTAINER_MOUNT_ESCAPE');
   if(['/app/src','/app/prompts','/home/node/.claude.json','/workspace/plugins','/workspace/env-dir'].includes(destination)||destination.startsWith('/workspace/effective-skills/'))if(!readonly)throw Error('REAL_CONTAINER_MOUNT_MODE');
   const expected=expectedMounts[destination];
   if(!expected||source!==fs.realpathSync(expected.source)||readonly!==expected.readonly)throw Error('REAL_CONTAINER_MOUNT_TARGET_MISMATCH '+JSON.stringify({source,destination,readonly,expected}));
   mounts.push({source,destination,readonly});destinations.add(destination);
  }else throw Error('REAL_CONTAINER_ARGUMENT');
 }
 if(originalShell){
  if(originalShell.verified!==true||originalShell.image!==image||JSON.stringify(originalShell.entrypoint)!=='["/app/entrypoint.sh"]')throw Error('ORIGINAL_SHELL_IMAGE_EVIDENCE');
  if(originalShell.piVersion!=='0.84.2'||Object.entries(originalShellHelpers).some(([name,hash])=>originalShell.files?.[name]!==hash))throw Error('ORIGINAL_SHELL_SOURCE_EVIDENCE');
  const identities=args.filter(value=>value.startsWith('MINICLAW_HOST_IDENTITY_MODE='));
  const ids=args.filter(value=>/^MINICLAW_HOST_(UID|GID)=/.test(value));
  const validIds=expectedIdentity==='direct'?Number.isSafeInteger(expectedUid)&&expectedUid>0&&Number.isSafeInteger(expectedGid)&&expectedGid>0&&ids.length===2&&ids.includes('MINICLAW_HOST_UID='+expectedUid)&&ids.includes('MINICLAW_HOST_GID='+expectedGid):ids.length===0;
  if(!['virtualized','host-root','direct'].includes(expectedIdentity)||identities.length!==1||identities[0]!=='MINICLAW_HOST_IDENTITY_MODE='+expectedIdentity||!validIds)throw Error('ORIGINAL_SHELL_IDENTITY');
  let resolvedProvider;try{resolvedProvider=fs.realpathSync(provider);}catch{throw Error('ORIGINAL_SHELL_PROVIDER');}
  const relative=path.relative(canonicalRoot,resolvedProvider);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!fs.statSync(provider).isFile())throw Error('ORIGINAL_SHELL_PROVIDER');
  const extra=['--pull=never','--label','qiwe.verification-run='+runId,'--network','none','--read-only','--cap-drop','ALL',
   ...['CHOWN','DAC_OVERRIDE','FOWNER','KILL','SETGID','SETUID'].flatMap(cap=>['--cap-add',cap]),
   '--security-opt','no-new-privileges','--user','0:0','--tmpfs','/tmp:rw,nosuid,nodev','--tmpfs','/run:rw,nosuid,nodev',
   '--tmpfs','/home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700',
   '-v',`${fs.realpathSync(provider)}:/verification/${startupFailure?'intentionally-missing-startup':'provider'}.mjs:ro`,
   '-e','HOME=/home/node','-e','MINICLAW_AGENT_RUNTIME=pi','-e','ANTHROPIC_API_KEY=synthetic-not-a-secret','-e','QIWE_ORIGINAL_SHELL=1'];
  return {name:args[4],mounts,args:[...args.slice(0,-1),...extra,image]};
 }
 const extra=['--pull=never','--label','qiwe.verification-run='+runId,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','0:0','--tmpfs','/tmp:rw,nosuid,nodev','--tmpfs','/home/node:rw,nosuid,nodev','--tmpfs','/home/node/.claude/skills:rw,nosuid,nodev',
  '-v',`${runner}:/app:ro`,'-v',`${deps}:/app/node_modules:ro`,'-v',`${provider}:/verification/provider.mjs:ro`,
  '-e','HOME=/home/node','-e','CLAUDE_CONFIG_DIR=/home/node/.claude','-e','MINICLAW_AGENT_RUNTIME=pi','-e','ANTHROPIC_API_KEY=synthetic-not-a-secret',
  '--workdir','/workspace/group','--entrypoint','node'];
 return {name:args[4],mounts,args:[...args.slice(0,-1),...extra,image,'/verification/provider.mjs']};
}

// Explicit opt-in for the local, time-limited pilot. The caller must still
// verify the live restoration receipt and invoke this only for its one runner.
// No credentials are accepted or constructed in the command-line arguments.
export function admitControlledRealDockerRun(args,options){
 const {root,preload,modelModule,image,runId,controlledRealPilot:scope,maxRequests,maxOutputTokens,originalShell,ownedContainerPrefix}=options;
 const bounded=(value,max)=>Number.isSafeInteger(value)&&value>0&&value<=max;
 if(!scope||Object.keys(scope).sort().join(',')!=='environment,expiresAt,mode,networkName,runId'||
  scope.mode!=='controlled-real-pilot'||scope.environment!=='local-test'||scope.runId!==runId||scope.networkName!=='qiwe-pilot-'+runId||
  !Number.isSafeInteger(scope.expiresAt)||scope.expiresAt<=Date.now()||scope.expiresAt>Date.now()+1800000||
  !bounded(maxRequests,8)||!bounded(maxOutputTokens,1024))throw Error('CONTROLLED_REAL_SCOPE');
 if(!originalShell||originalShell.piAiVersions?.topLevel!=='0.84.2'||originalShell.piAiVersions?.nested!=='0.84.2'||
  options.expectedIdentity!=='direct'||options.expectedUid!==1000||options.expectedGid!==1000||!ownedContainerPrefix)throw Error('CONTROLLED_REAL_IDENTITY');
 const canonicalRoot=fs.realpathSync(root);
 const regularFile=source=>{
  try{
   const resolved=fs.realpathSync(source),relative=path.relative(canonicalRoot,resolved),stat=fs.lstatSync(source);
   if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||
    path.resolve(source)!==resolved)throw Error();
   return resolved;
  }catch{throw Error('CONTROLLED_REAL_PRELOAD');}
 };
 const pinnedPreload=regularFile(preload),pinnedModel=regularFile(modelModule);
 // The existing original-shell admission validates the command, every mount,
 // user identity and image evidence. Only its offline-injected flags are discarded.
 const admitted=admitDockerRun(args,{...options,provider:pinnedPreload,startupFailure:false});
 const extra=['--pull=never','--label','qiwe.verification-run='+runId,'--network',scope.networkName,'--read-only','--cap-drop','ALL',
  ...['CHOWN','DAC_OVERRIDE','FOWNER','KILL','SETGID','SETUID'].flatMap(cap=>['--cap-add',cap]),
  '--security-opt','no-new-privileges','--user','0:0','--tmpfs','/tmp:rw,nosuid,nodev','--tmpfs','/run:rw,nosuid,nodev',
  '--tmpfs','/home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700',
  '-v',`${pinnedPreload}:/verification/controlled-real-preload.mjs:ro`,
  '-v',`${pinnedModel}:/verification/controlled-real-model.ts:ro`,
  '-e','HOME=/home/node','-e','MINICLAW_AGENT_RUNTIME=pi','-e','QIWE_PILOT_RUN_ID='+runId,
  '-e','QIWE_PILOT_MODEL_EXPIRES_AT='+scope.expiresAt,'-e','QIWE_PILOT_MODEL_REQUESTS='+maxRequests,
  '-e','QIWE_PILOT_MODEL_OUTPUT_TOKENS='+maxOutputTokens];
 return {name:admitted.name,mounts:admitted.mounts,args:[...args.slice(0,-1),...extra,image]};
}
