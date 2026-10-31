import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {admitControlledRealDockerRun,admitDockerControl,admitDockerShell,admitLocalDockerSpawn} from './real-container-boundary.mjs';
import {inspectLocalDockerReceipt,translateLocalMounts,localDocker,localEndpoint} from './full-host-local-docker.mjs';

let transportInstalled=false;
// Installs the original Docker runner's transport only within the supervised
// local trial. No business result or child-process output is interpreted here.
export function installControlledRealContainerTransport(options){
 const fail=code=>{throw Error('CONTROLLED_REAL_TRANSPORT_'+code);};
 if(transportInstalled)fail('ALREADY_INSTALLED');
 const {root,folder,accountId,image,originalShell,manifest,preload,modelModule}=options;
 const scope=JSON.parse(JSON.stringify(options.controlledRealPilot??null));
 if(process.platform!=='linux'||process.getuid?.()!==1000||process.getgid?.()!==1000||
  !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(folder??'')||!/^\w[\w-]*$/.test(accountId??'')||
  !scope||scope.mode!=='controlled-real-pilot'||scope.environment!=='local-test'||
  scope.networkName!=='qiwe-pilot-'+scope.runId||!Number.isSafeInteger(scope.expiresAt)||scope.expiresAt<=Date.now()||scope.expiresAt>Date.now()+1800000||
  !/^\/proc\/1\/fd\/[0-9]+$/.test(process.env.QIWE_RESTORATION_RECEIPT??'')||
  typeof root!=='string'||!path.isAbsolute(root)||fs.realpathSync(root)!==process.cwd())fail('SCOPE');
 const inside=file=>typeof file==='string'&&path.isAbsolute(file)&&path.relative(root,file)!==''&&path.relative(root,file)!=='..'&&!path.relative(root,file).startsWith('..'+path.sep)&&!path.isAbsolute(path.relative(root,file));
 if(![manifest,preload,modelModule].every(inside))fail('SCOPE');
 const receipt=JSON.parse(fs.readFileSync(process.env.QIWE_RESTORATION_RECEIPT,'utf8'));
 if(receipt.version!==3||JSON.stringify(receipt.controlledRealPilot)!==JSON.stringify(scope))fail('SCOPE');
 const facts=inspectLocalDockerReceipt(receipt);
 const originals=Object.fromEntries(['spawn','exec','execFile','execFileSync','execSync','spawnSync','fork'].map(name=>[name,childProcess[name]]));
 const owned=new Set(),prefix='miniclaw-'+folder+'-';let expectedMounts,gate,started=false,active=false,exited=false,closed=false,child;
 const route=(command,args)=>['--host',localEndpoint,...admitDockerControl(command,args,owned,prefix)];
 const ports={
  execFileSync:(command,args,...rest)=>originals.execFileSync(localDocker,route(command,args),...rest),
  execFile:(command,args,...rest)=>originals.execFile(localDocker,route(command,args),...rest),
  exec:(command,...rest)=>originals.execFile(localDocker,['--host',localEndpoint,...admitDockerShell(command,owned,prefix)],...rest),
  spawn:(command,args,spawnOptions)=>{
   admitLocalDockerSpawn(command,args,spawnOptions,{ready:active&&gate?.phase()==='ready'&&Date.now()<scope.expiresAt,alreadyStarted:started,ownedContainerPrefix:prefix});
   const identity=JSON.parse(originals.execFileSync(localDocker,['--host',localEndpoint,'info','--format','{{json .SecurityOptions}}'],{encoding:'utf8',timeout:20000}));
   if(!Array.isArray(identity)||identity.some(value=>/rootless|userns/i.test(value)))fail('IDENTITY');
   const admitted=admitControlledRealDockerRun(args,{root,preload,modelModule,image,runId:scope.runId,controlledRealPilot:scope,maxRequests:8,maxOutputTokens:1024,originalShell,expectedMounts,expectedIdentity:'direct',expectedUid:1000,expectedGid:1000,ownedContainerPrefix:prefix});
   const translated=translateLocalMounts(admitted.args,facts.mountpoint);
   // Reserve the only runner before any daemon side effect; unknown failures
   // cannot become automatic retries or consume a fresh model allowance.
   started=true;
   const fd=fs.openSync(manifest,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW);
   try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)fail('MANIFEST');fs.writeSync(fd,admitted.name+'\n');}finally{fs.closeSync(fd);}
   owned.add(admitted.name);
   child=originals.spawn(localDocker,['--host',localEndpoint,...translated],spawnOptions);
   child.once('close',()=>{exited=true;owned.delete(admitted.name);});
   return child;
  },
 };
 transportInstalled=true;
 for(const name of Object.keys(originals))childProcess[name]=ports[name]??(()=>fail('CHILD_FORBIDDEN'));
 syncBuiltinESMExports();
 return Object.freeze({
  prepare(config){
   if(closed||expectedMounts||!config||![config.GROUPS_DIR,config.DATA_DIR].every(inside))fail('PREPARE');
   const group=path.join(config.GROUPS_DIR,folder),data=config.DATA_DIR,skills=['beauty-local-content','vendor-content-strategy','vendor-copywriting'];
   expectedMounts=Object.fromEntries([
    ['/workspace/group',group,false],['/workspace/ipc',path.join(data,'ipc',folder),false],['/home/node/.claude',path.join(data,'sessions',folder,'.claude'),false],
    ['/home/node/.claude.json',path.join(data,'config/container-claude-json.json'),true],
    ...skills.map(id=>['/workspace/effective-skills/'+id,path.join(data,'skills',accountId,id),true]),
    ['/home/node/.feishu-cli',path.join(data,'config/user-cli',accountId,'feishu-cli'),false],['/workspace/plugins',path.join(data,'plugins/runtime',accountId),true],
    ['/workspace/env-dir',path.join(data,'env',folder,'default/main'),true],['/workspace/extra',path.join(data,'extra',folder),false],
    ['/app/src',path.join(root,'container/agent-runner/src'),true],['/app/prompts',path.join(root,'container/agent-runner/prompts'),true],
   ].map(([destination,source,readonly])=>[destination,{source,readonly}]));
  },
  activate(value){if(!expectedMounts)fail('PREPARE');if(closed||active||!value||typeof value.phase!=='function'||value.phase()!=='ready'||Date.now()>=scope.expiresAt)fail('GATE');gate=value;active=true;},
  async close(){
   if(closed)return;active=false;
   if(child&&!exited){
    for(const name of owned)originals.execFileSync(localDocker,['--host',localEndpoint,...admitDockerControl('docker',['stop',name],owned,prefix)],{encoding:'utf8',timeout:20000});
    if(!exited)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CONTROLLED_REAL_TRANSPORT_CLOSE_UNKNOWN')),10000);child.once('close',()=>{clearTimeout(timer);resolve();});});
   }
   // Keep the deny-by-default routing installed through process exit. The
   // original host may still be shutting down even after our owned runner
   // stops; restoring unrestricted child_process here would reopen Docker.
   closed=true;
  },
 });
}
