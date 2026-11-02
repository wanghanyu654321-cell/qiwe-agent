import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {admitDockerRun,admitDockerControl,admitDockerShell} from './real-container-boundary.mjs';
const transport=vi.hoisted(()=>({runs:[] as any[],startupFailure:false,actual:undefined as any,expectedMounts:undefined as any}));
vi.mock('child_process',async importOriginal=>{
 const actual:any=await importOriginal();transport.actual=actual;
 const owned=()=>new Set(transport.runs.map(run=>run.name));
 const route=(command:string,args:string[])=>['--host','npipe:////./pipe/dockerDesktopLinuxEngine',...admitDockerControl(command,args,owned())];
 return {...actual,
 execFileSync:(command:string,args:string[],...rest:any[])=>actual.execFileSync(process.env.QIWE_REAL_CONTAINER_DOCKER!,route(command,args),...rest),
 execFile:(command:string,args:string[],...rest:any[])=>actual.execFile(process.env.QIWE_REAL_CONTAINER_DOCKER!,route(command,args),...rest),
 exec:(command:string,...rest:any[])=>actual.execFile(process.env.QIWE_REAL_CONTAINER_DOCKER!,['--host','npipe:////./pipe/dockerDesktopLinuxEngine',...admitDockerShell(command,owned())],...rest),
 spawn:(command:string,args:string[],options:any)=>{
  if(command!=='docker')throw Error('REAL_CONTAINER_UNEXPECTED_SPAWN '+command);
  const originalShell=process.env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL?JSON.parse(process.env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL):undefined;
  const admitted=admitDockerRun(args,{root:process.cwd(),runner:process.env.QIWE_REAL_CONTAINER_RUNNER!,deps:process.env.QIWE_REAL_CONTAINER_RUNNER_DEPS!,provider:path.resolve('real-container-provider.mjs'),image:process.env.QIWE_REAL_CONTAINER_IMAGE!,runId:process.env.QIWE_REAL_CONTAINER_RUN_ID!,expectedMounts:transport.expectedMounts,originalShell,startupFailure:transport.startupFailure});
  if(transport.startupFailure&&!originalShell)admitted.args[admitted.args.length-1]='/verification/intentionally-missing-startup.mjs';
  const manifest=process.env.QIWE_REAL_CONTAINER_OWNED_MANIFEST;if(!manifest)throw Error('REAL_CONTAINER_OWNED_MANIFEST_REQUIRED');
  fs.appendFileSync(manifest,admitted.name+'\n');
  const proc=actual.spawn(process.env.QIWE_REAL_CONTAINER_DOCKER!,['--host','npipe:////./pipe/dockerDesktopLinuxEngine',...admitted.args],options);
  const run={...admitted,pid:proc.pid,stderr:'',stdout:'',exitCode:null as number|null};transport.runs.push(run);
  proc.stdout.on('data',(bytes:Buffer)=>run.stdout+=bytes.toString());proc.stderr.on('data',(bytes:Buffer)=>run.stderr+=bytes.toString());
  proc.on('exit',(code:number)=>run.exitCode=code);return proc;
 }};
});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate:()=>any,label:string,timeoutMs=30000){const until=Date.now()+timeoutMs;while(Date.now()<until){if(predicate())return;await sleep(25);}throw Error('REAL_CONTAINER_WAIT '+label);}
const docker=(args:string[])=>transport.actual.execFileSync(process.env.QIWE_REAL_CONTAINER_DOCKER!,['--host','npipe:////./pipe/dockerDesktopLinuxEngine',...args],{encoding:'utf8',timeout:15000});
const originalShell=process.env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL?JSON.parse(process.env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL):undefined;

it('uses original runContainerAgent pipes and true main for mounts, warm IPC, abort, drain, close and actual startup failure',async()=>{
 const db=await import('../src/db.js'),config=await import('../src/config.js');db.initDatabase();
 const {runContainerAgent}=await import('../src/container-runner.js');
 const owner='synthetic-container-member',now=new Date().toISOString(),outputs:any[]=[],inspections:any[]=[],events:any[]=[],launches:any[]=[];let failure:string|undefined,passed=false;
 db.createUser({id:owner,username:owner,password_hash:'synthetic',display_name:'Synthetic member',role:'member',status:'active',must_change_password:false,created_at:now,updated_at:now});
 db.ensureUserHomeGroup(owner,'member',owner);
 const managed=path.join(config.DATA_DIR,'skills',owner,'beauty-local-content');fs.mkdirSync(managed,{recursive:true});
 fs.copyFileSync(path.resolve('skill-sources/beauty-local-content/SKILL.md'),path.join(managed,'SKILL.md'));
 const profile={id:'synthetic-container-profile',version:1,name:'Synthetic',identityPrompt:'Synthetic authorized local member',promptMode:'append',promptSchemaVersion:2,
  runtimePolicy:{context:{source:'managed',autoCompactWindow:0,autoCompactPercentage:0},skills:{mode:'inherit',ids:[],host:{mode:'disabled',ids:[]}},mcp:{mode:'disabled',ids:[]}}};
 const owned=new Set<string>();
 const foreign=path.join(config.GROUPS_DIR,'synthetic-other-user');fs.mkdirSync(foreign,{recursive:true});fs.writeFileSync(path.join(foreign,'private.txt'),'synthetic-other-user-canary');fs.writeFileSync(path.resolve('private.txt'),'synthetic-project-canary');
 function launch(suffix:string,prompt='[normal]'){
  const folder='synthetic-'+suffix,chatJid='web:'+folder;
  db.setRegisteredGroup(chatJid,{name:'Synthetic member',folder,added_at:now,created_by:owner,executionMode:'container',is_home:false} as any);
  const group=db.getRegisteredGroup(chatJid)!;
  expect(group.created_by).toBe(owner);expect(group.is_home).toBe(false);expect(db.getUserById(owner)?.role).toBe('member');
  const groupDir=path.join(config.GROUPS_DIR,folder);fs.mkdirSync(groupDir,{recursive:true});fs.writeFileSync(path.join(groupDir,'approved.txt'),'synthetic-approved-v1: 每场限额 12 人');
  const ipc=path.join(config.DATA_DIR,'ipc',folder),inputDir=path.join(ipc,'input');
  transport.expectedMounts=Object.freeze(Object.fromEntries([
   ['/workspace/group',groupDir,false],['/workspace/ipc',ipc,false],['/home/node/.claude',path.join(config.DATA_DIR,'sessions',folder,'.claude'),false],
   ['/home/node/.claude.json',path.join(config.DATA_DIR,'config','container-claude-json.json'),true],
   ['/workspace/effective-skills/beauty-local-content',managed,true],['/home/node/.feishu-cli',path.join(config.DATA_DIR,'config','user-cli',owner,'feishu-cli'),false],
   ['/workspace/plugins',path.join(config.DATA_DIR,'plugins','runtime',owner),true],['/workspace/env-dir',path.join(config.DATA_DIR,'env',folder,'default','main'),true],
   ['/workspace/extra',path.join(config.DATA_DIR,'extra',folder),false],
   ['/app/src',path.resolve('container/agent-runner/src'),true],['/app/prompts',path.resolve('container/agent-runner/prompts'),true],
  ].map(([destination,source,readonly])=>[destination,Object.freeze({source,readonly})])));
  const localOutputs:any[]=[];let proc:any,name='';const launchEvidence:any={suffix};launches.push(launchEvidence);
  const done=runContainerAgent(group as any,{prompt,chatJid,groupFolder:folder,isMain:false,isHome:false,isAdminHome:false,turnId:'initial-'+suffix,queryRunId:'query-'+suffix,agentProfile:profile} as any,
   (child:any,containerName:string)=>{proc=child;name=containerName;owned.add(name);launchEvidence.name=name;},async(output:any)=>{outputs.push(output);localOutputs.push(output);});
  void done.then(result=>{launchEvidence.result=result;launchEvidence.settled=true;},error=>{launchEvidence.error=String(error);launchEvidence.stack=error?.stack;launchEvidence.settled=true;});
  return {ipc,inputDir,localOutputs,done,launchEvidence,get proc(){return proc;},get name(){return name;},readEvents(){const file=path.join(ipc,'verification-events.ndjson');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];},
   sentinel(kind:string){fs.writeFileSync(path.join(inputDir,'_'+kind),'');},
   message(id:string,text:string,order=1,fileOrder=order){fs.writeFileSync(path.join(inputDir,`${String(fileOrder).padStart(3,'0')}-${id}.json`),JSON.stringify({type:'message',text,queryRunId:'query-'+id,sourceJid:chatJid,receipt:{deliveryId:id,chatJid,cursor:{timestamp:'2026-10-24T00:00:'+String(order).padStart(2,'0')+'Z',id}}}));}};
 }
 const completed=(run:any,id:string)=>run.localOutputs.find((output:any)=>output.inputTurnId===id&&output.inputTurnCompleted);
 async function inspect(run:any){
  await wait(()=>{if(run.launchEvidence.settled)throw Error('REAL_CONTAINER_EARLY_RETURN '+JSON.stringify(run.launchEvidence));return run.readEvents().some((event:any)=>event.type==='bootstrap');},'child bootstrap',originalShell?90000:30000);
  const value=JSON.parse(docker(['inspect',run.name]))[0];
  expect(value.Name).toBe('/'+run.name);expect(value.State.Running).toBe(true);expect(value.HostConfig.NetworkMode).toBe('none');expect(value.HostConfig.Privileged).toBe(false);expect(value.HostConfig.ReadonlyRootfs).toBe(true);
  expect(value.HostConfig.CapDrop).toContain('ALL');expect(value.Mounts.some((mount:any)=>mount.Destination.includes('docker.sock'))).toBe(false);
  if(originalShell){
   expect(value.Image).toBe(originalShell.image);expect(value.Config.Entrypoint).toEqual(['/app/entrypoint.sh']);
   expect(value.HostConfig.CapAdd.map((cap:string)=>cap.replace(/^CAP_/,'' )).sort()).toEqual(['CHOWN','DAC_OVERRIDE','FOWNER','KILL','SETGID','SETUID']);
   expect(value.HostConfig.Tmpfs?.['/run']).toBe('rw,nosuid,nodev');
   const bootstrap=run.readEvents().find((event:any)=>event.type==='bootstrap');
   expect(bootstrap.uid).toBe(1000);expect(bootstrap.gid).toBe(1000);expect(bootstrap.originalShellExecuted).toBe(true);expect(bootstrap.chromiumExecuted).toBe(true);expect(bootstrap.identityBridgeExecuted).toBe(true);
   expect(bootstrap.shellEvidence.mainEffectiveCaps).toBe('0000000000000000');expect(bootstrap.shellEvidence.shellEffectiveCaps).toBe('00000000000000eb');expect(bootstrap.shellEvidence.noNewPrivileges).toBe('1');
   expect(bootstrap.shellEvidence.piVersion).toBe('0.84.2');
   for(const [name,hash]of Object.entries(bootstrap.shellEvidence.helpers))expect(hash).toBe(originalShell.files[name]);
   expect(value.Mounts.some((mount:any)=>['/app','/app/node_modules'].includes(mount.Destination))).toBe(false);
  }else expect(value.HostConfig.Tmpfs?.['/home/node/.claude/skills']).toBe('rw,nosuid,nodev');
  expect(value.Config.Labels?.['qiwe.verification-run']).toBe(process.env.QIWE_REAL_CONTAINER_RUN_ID);
  const normalized=(source:string)=>source.replaceAll('\\','/').replace(/^\/run\/desktop\/mnt\/host\//,'').replace(/^\/host_mnt\//,'').replace(/^([A-Za-z]):\//,'$1/').toLowerCase();
  const planned=transport.runs.find(item=>item.name===run.name);
  for(const mount of planned.mounts){const inspected=value.Mounts.find((item:any)=>item.Destination===mount.destination);expect(normalized(inspected.Source)).toBe(normalized(mount.source));expect(inspected.RW).toBe(!mount.readonly);}
  const protectedSources=[path.resolve('private.txt'),foreign];
  for(const source of protectedSources)expect(value.Mounts.some((mount:any)=>{const base=normalized(mount.Source),target=normalized(source);return target===base||target.startsWith(base+'/');})).toBe(false);
  expect(value.Mounts.some((mount:any)=>mount.Destination==='/workspace/project')).toBe(false);
  for(const target of ['/workspace/group','/workspace/ipc','/home/node/.claude'])expect(value.Mounts.find((mount:any)=>mount.Destination===target)?.RW).toBe(true);
  expect(value.Mounts.find((mount:any)=>mount.Destination==='/workspace/effective-skills/beauty-local-content')?.RW).toBe(false);
  inspections.push(value);
  await wait(()=>{
   const events=run.readEvents(),error=events.find((event:any)=>event.type==='sdk-error');if(error)throw Error('REAL_CONTAINER_SDK_LOAD '+JSON.stringify(error));
   if(run.launchEvidence.settled)throw Error('REAL_CONTAINER_EARLY_RETURN '+JSON.stringify(run.launchEvidence));
   return events.some((event:any)=>event.type==='sdk-ready');
  },'original SDK ready (measured cold readonly import 30.464s)',60000);
  return value;
 }
 async function exited(run:any){await run.done;await wait(()=>run.proc.exitCode!==null,'actual docker exit');expect(run.proc.exitCode).toBe(0);expect(docker(['ps','-a','--filter','name=^/'+run.name+'$','--format','{{.ID}}']).trim()).toBe('');events.push(...run.readEvents());owned.delete(run.name);}
 try{
  const warm=launch('warm');const firstInspect=await inspect(warm);
  await wait(()=>completed(warm,'initial-warm'),'initial final');
  const first=completed(warm,'initial-warm');expect(first.result).toContain('synthetic-approved-v1');expect(first.result).toContain('"skillRead":true');expect(first.result).toContain('"denied":true');
  const firstToolRequest=warm.readEvents().find((event:any)=>event.type==='provider'&&event.messages.some((message:any)=>message.role==='toolResult'));
  const toolResults=firstToolRequest.messages.filter((message:any)=>message.role==='toolResult');
  expect(toolResults.map((message:any)=>message.toolCallId).sort()).toEqual(['approved','forbidden-project','forbidden-user','skill']);
  for(const id of ['approved','skill'])expect(toolResults.find((message:any)=>message.toolCallId===id).isError).not.toBe(true);
  for(const id of ['forbidden-project','forbidden-user'])expect(toolResults.find((message:any)=>message.toolCallId===id).isError).toBe(true);
  const text=(id:string)=>toolResults.find((message:any)=>message.toolCallId===id).content.map((part:any)=>part.text??'').join('').trim();
  expect(text('approved')).toBe('synthetic-approved-v1: 每场限额 12 人');expect(text('skill')).toBe(fs.readFileSync(path.join(managed,'SKILL.md'),'utf8').trim());
  expect(warm.proc.exitCode).toBe(null);
  warm.message('warm-delivery','[normal] Use the previous answer');await wait(()=>completed(warm,'warm-delivery'),'warm identity final');
  expect(completed(warm,'warm-delivery').result).toContain('"priorAnswer":true');expect(completed(warm,'warm-delivery').ipcReceipts?.map((receipt:any)=>receipt.deliveryId)).toContain('warm-delivery');
  expect(JSON.parse(docker(['inspect',warm.name]))[0].State.Pid).toBe(firstInspect.State.Pid);
  warm.message('interrupt-delivery','[hold-interrupt]',2);await wait(()=>warm.readEvents().some((event:any)=>event.type==='held'&&event.kind==='interrupt'),'active provider');
  warm.sentinel('interrupt');await wait(()=>warm.localOutputs.some(output=>output.inputTurnId==='interrupt-delivery'&&output.streamEvent?.statusText==='interrupted'),'precise original abort receipt');
  expect(warm.readEvents().some((event:any)=>event.type==='aborted'&&event.kind==='interrupt')).toBe(true);expect(completed(warm,'interrupt-delivery')).toBeUndefined();
  warm.message('successor-delivery','[normal] Continue after cancellation',3);await wait(()=>completed(warm,'successor-delivery'),'warm successor');
  warm.message('ordered-new','[normal] ordered-new',5,0);warm.message('ordered-old','[normal] ordered-old',4,999);
  await wait(()=>completed(warm,'ordered-new'),'receipt-ordered batch');
  expect(completed(warm,'ordered-new').ipcReceipts?.map((receipt:any)=>receipt.deliveryId)).toEqual(['ordered-old','ordered-new']);
  const orderedRequest=warm.readEvents().findLast((event:any)=>event.type==='provider'&&JSON.stringify(event.messages).includes('ordered-new'));
  const orderedUser=JSON.stringify(orderedRequest.messages.findLast((message:any)=>message.role==='user'));expect(orderedUser.indexOf('ordered-old')).toBeLessThan(orderedUser.indexOf('ordered-new'));
  warm.sentinel('drain');await exited(warm);
  const close=launch('close');await inspect(close);await wait(()=>completed(close,'initial-close'),'before close');close.sentinel('close');await exited(close);
  const drain=launch('drain','[hold-drain]');await inspect(drain);await wait(()=>drain.readEvents().some((event:any)=>event.type==='held'),'held drain');
  drain.sentinel('drain');await sleep(100);expect(drain.proc.exitCode).toBe(null);expect(drain.readEvents().some((event:any)=>event.type==='aborted')).toBe(false);
  fs.writeFileSync(path.join(drain.ipc,'release-drain'),'');await wait(()=>completed(drain,'initial-drain'),'active drain answer');await exited(drain);
  transport.startupFailure=true;const failure=launch('failure');const failed=await failure.done;await wait(()=>failure.proc.exitCode!==null,'nonzero startup exit');
  expect(failure.proc.exitCode).not.toBe(0);expect(failed.status).toBe('error');expect(transport.runs.at(-1).stderr).toContain(originalShell?'/verification/provider.mjs':'intentionally-missing-startup');expect(docker(['ps','-a','--filter','name=^/'+failure.name+'$','--format','{{.ID}}']).trim()).toBe('');owned.delete(failure.name);
  passed=true;
 }catch(error){failure=String(error);throw error;}finally{
  fs.writeFileSync(process.env.QIWE_REAL_CONTAINER_EVIDENCE!,JSON.stringify({status:passed?'passed':'failed',failure,hostPid:process.pid,launches,outputs,events,inspections,runs:transport.runs,remainingOwnedNames:[...owned],cleanupOwner:'outer verifier; validates immutable run label before removal',limitations:[originalShell?'Original shell and true main with test-candidate deterministic model I/O':'Reduced Node bootstrap; original shell/Chromium/identity bridge not executed','Independent transport evidence; restored-host conjunction unverified','Missing-path tool errors demonstrate absent mount visibility, not a general filesystem ACL']},null,2));
  db.closeDatabase();
 }
},originalShell?360000:180000);
