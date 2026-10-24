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

export function admitDockerControl(command,args,owned){
 if(command!=='docker')throw Error('REAL_CONTAINER_CONTROL_COMMAND');
 if(args.length===3&&args[0]==='info'&&args[1]==='--format'&&args[2]==='{{json .SecurityOptions}}')return [...args];
 if(args.length===2&&args[0]==='stop'&&/^miniclaw-synthetic-[a-z0-9-]+$/.test(args[1])&&owned.has(args[1]))return [...args];
 throw Error('REAL_CONTAINER_CONTROL_ARGUMENT');
}
export function admitDockerShell(command,owned){
 const match=/^docker stop (miniclaw-synthetic-[a-z0-9-]+)$/.exec(command);
 if(!match)throw Error('REAL_CONTAINER_CONTROL_SHELL');
 return admitDockerControl('docker',['stop',match[1]],owned);
}

// The only admitted command is the original runner's docker run. No daemon
// socket or executable is exposed to the child; callers retain real pipes.
export function admitDockerRun(args,{root,runner,deps,provider,image,expectedMounts,runId,originalShell,startupFailure=false}){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId??''))throw Error('REAL_CONTAINER_RUN_ID');
 if(!expectedMounts||typeof expectedMounts!=='object')throw Error('REAL_CONTAINER_EXPECTED_MOUNTS');
 if(!/^(?:node@)?sha256:[a-f0-9]{64}$/.test(image)||args.at(-1)!==image)throw Error('REAL_CONTAINER_IMAGE');
 if(args[0]!=='run'||args[1]!=='-i'||args[2]!=='--rm'||args[3]!=='--name'||!/^miniclaw-synthetic-[a-z0-9-]+$/.test(args[4]??''))throw Error('REAL_CONTAINER_ARGUMENT');
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
  if(identities.length!==1||identities[0]!=='MINICLAW_HOST_IDENTITY_MODE=virtualized'||args.some(value=>/^MINICLAW_HOST_(UID|GID)=/.test(value)))throw Error('ORIGINAL_SHELL_IDENTITY');
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
