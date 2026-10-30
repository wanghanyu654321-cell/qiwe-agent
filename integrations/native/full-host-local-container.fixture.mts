import {expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {admitDockerRun,admitDockerControl,admitDockerShell,admitLocalDockerSpawn} from './real-container-boundary.mjs';
import {translateLocalMounts,inspectLocalDockerReceipt,localDocker,localEndpoint} from '../src/full-host-local-docker.mjs';
import {actor,folder} from './full-host-restoration.fixture.mts';
const actual={spawn:childProcess.spawn,execFile:childProcess.execFile,execFileSync:childProcess.execFileSync};
const skillIds=['beauty-local-content','vendor-content-strategy','vendor-copywriting'];
const c4Case=process.env.QIWE_C4_SYNTHETIC_CASE;
if(c4Case&&!['grounded','missing-evidence'].includes(c4Case))throw Error('Invalid C4 synthetic case option');
export const localContainerAnswer=c4Case?JSON.stringify({tag:'synthetic-c4-real-container-answer',status:c4Case==='grounded'?'draft':'partial',executed:false,published:false,
 draft:c4Case==='grounded'?{topic:'项目体验介绍：每场限额 12 人',copy:'了解项目体验。每场限额 12 人。咨询核对项目。',source:'approved.txt',evidence:'synthetic-approved-v1',methods:[{source:'vendor-content-strategy/SKILL.md',method:'主题对应到可展示的服务步骤'},{source:'vendor-copywriting/SKILL.md',method:'单一行动号召'}]}:null,
 missingMaterial:c4Case==='grounded'?[]:['approved.txt'],skillRead:true,denied:true}):JSON.stringify({tag:'synthetic-real-container-answer',approved:'synthetic-approved-v1: 每场限额 12 人',skillRead:true,denied:true,priorAnswer:false});
export const localContainerRequest=c4Case?'[c4-synthetic] 请根据已有批准资料，为美容门店写一段项目体验活动草稿，读取美容内容、内容策划和文案三个技能，说明每场限额与行动建议，并标明来源及尚未发布、尚未执行。':'请根据已有批准资料，为美容门店写一段项目体验介绍，读取内容营销技能，说明每场限额并给出行动建议。';
export function prepareLocalContainerTransport(calls:any[],existing?:{actor:{accountId:string};folder:string;ownedContainerPrefix:string}){
 const selectedActor=existing?.actor??actor,selectedFolder=existing?.folder??folder;
 const ownedContainerPrefix=existing?.ownedContainerPrefix;
 if(existing&&ownedContainerPrefix!=='miniclaw-'+selectedFolder+'-')throw Error('EXISTING_CONTAINER_FOLDER_MISMATCH');
 const receipt=JSON.parse(fs.readFileSync(process.env.QIWE_RESTORATION_RECEIPT!,'utf8'));
 const dockerFacts=inspectLocalDockerReceipt(receipt),runs:any[]=[],owned=new Set<string>();
 let ready=false,expectedMounts:any;
 const invoke=(args:string[])=>actual.execFileSync(localDocker,['--host',localEndpoint,...args],{encoding:'utf8',timeout:20000});
 const route=(command:string,args:string[])=>['--host',localEndpoint,...admitDockerControl(command,args,owned,ownedContainerPrefix)];
 const ports={
  execFileSync:(command:string,args:string[],...rest:any[])=>actual.execFileSync(localDocker,route(command,args),...rest),
  execFile:(command:string,args:string[],...rest:any[])=>actual.execFile(localDocker,route(command,args),...rest),
  exec:(command:string,...rest:any[])=>actual.execFile(localDocker,['--host',localEndpoint,...admitDockerShell(command,owned,ownedContainerPrefix)],...rest),
  spawn:(command:string,args:string[],options:any)=>{
   admitLocalDockerSpawn(command,args,options,{ready,alreadyStarted:runs.length>0,ownedContainerPrefix});
   const shell=JSON.parse(process.env.QIWE_REAL_CONTAINER_ORIGINAL_SHELL!);
   const identity=JSON.parse(invoke(['info','--format','{{json .SecurityOptions}}']));
   if(process.platform!=='linux'||process.getuid?.()!==1000||process.getgid?.()!==1000||!Array.isArray(identity)||identity.some((v:string)=>/rootless|userns/i.test(v)))throw Error('LOCAL_DOCKER_HOST_IDENTITY');
   const admitted=admitDockerRun(args,{root:process.cwd(),runner:path.resolve('runner'),deps:path.resolve('runner/node_modules'),provider:path.resolve('real-container-provider.mjs'),image:process.env.MINICLAW_CONTAINER_IMAGE,runId:process.env.QIWE_LOCAL_DOCKER_RUN_ID,expectedMounts,originalShell:shell,expectedIdentity:'direct',expectedUid:process.getuid(),expectedGid:process.getgid(),ownedContainerPrefix});
   const translated=translateLocalMounts(admitted.args,dockerFacts.mountpoint);
   fs.appendFileSync(process.env.QIWE_REAL_CONTAINER_OWNED_MANIFEST!,admitted.name+'\n');owned.add(admitted.name);
   const proc=actual.spawn(localDocker,['--host',localEndpoint,...translated],options);
   const run:any={name:admitted.name,pid:proc.pid,hostPid:process.pid,mounts:admitted.mounts,args:translated,stdout:'',stderr:'',exitCode:null,proc};runs.push(run);
   const write=proc.stdin.write.bind(proc.stdin);let input='';
   proc.stdin.write=((chunk:any,...rest:any[])=>{input+=chunk.toString();try{const value=JSON.parse(input);if(!calls.length)calls.push(value);}catch{}return (write as any)(chunk,...rest);}) as any;
   let drain=false,observed=false;
   proc.stdout.on('data',(bytes:Buffer)=>{run.stdout+=bytes.toString();
    if(!observed){const eventFile=path.resolve('data/ipc',selectedFolder,'verification-events.ndjson');if(fs.existsSync(eventFile)){
     const events=fs.readFileSync(eventFile,'utf8').split('\n').filter(Boolean).map(v=>JSON.parse(v));
     if(events.some(e=>e.type==='bootstrap')){run.inspection=JSON.parse(invoke(['inspect',admitted.name]))[0];observed=true;}
    }}
    if(!drain&&/"inputTurnCompleted"\s*:\s*true/.test(run.stdout)){drain=true;fs.writeFileSync(path.resolve('data/ipc',selectedFolder,'input/_drain'),'');}
   });
   proc.stderr.on('data',(bytes:Buffer)=>run.stderr+=bytes.toString());proc.on('exit',(code:number)=>{run.exitCode=code;owned.delete(admitted.name);});return proc;
  },
 };
 return {ports,runs,c4Case,
  prepare(config:any){
   const group=path.join(config.GROUPS_DIR,selectedFolder),ipc=path.join(config.DATA_DIR,'ipc',selectedFolder);
   if(existing)for(const id of skillIds){const source=fs.readFileSync(path.resolve('skill-sources',id,'SKILL.md')),restored=fs.readFileSync(path.join(config.DATA_DIR,'skills',selectedActor.accountId,id,'SKILL.md'));expect(restored.equals(source),'existing restored skill bytes: '+id).toBe(true);}
   if(process.env.QIWE_FULL_HOST_PHASE!=='restart'){
    fs.mkdirSync(group,{recursive:true});
    if(c4Case==='missing-evidence')expect(fs.existsSync(path.join(group,'approved.txt'))).toBe(false);
    else {
     try{fs.writeFileSync(path.join(group,'approved.txt'),'synthetic-approved-v1: 每场限额 12 人',{flag:existing?'wx':'w'});}
     catch(error){if(existing&&(error as NodeJS.ErrnoException).code==='EEXIST')throw Error('EXISTING_SYNTHETIC_MATERIAL_ALREADY_EXISTS');throw error;}
    }
    if(!existing)for(const id of skillIds){const target=path.join(config.DATA_DIR,'skills',selectedActor.accountId,id);fs.mkdirSync(target,{recursive:true});fs.copyFileSync(path.resolve('skill-sources',id,'SKILL.md'),path.join(target,'SKILL.md'));}
   }
   expectedMounts=Object.fromEntries([
    ['/workspace/group',group,false],['/workspace/ipc',ipc,false],['/home/node/.claude',path.join(config.DATA_DIR,'sessions',selectedFolder,'.claude'),false],
    ['/home/node/.claude.json',path.join(config.DATA_DIR,'config/container-claude-json.json'),true],
    ...skillIds.map(id=>['/workspace/effective-skills/'+id,path.join(config.DATA_DIR,'skills',selectedActor.accountId,id),true]),
    ['/home/node/.feishu-cli',path.join(config.DATA_DIR,'config/user-cli',selectedActor.accountId,'feishu-cli'),false],
    ['/workspace/plugins',path.join(config.DATA_DIR,'plugins/runtime',selectedActor.accountId),true],['/workspace/env-dir',path.join(config.DATA_DIR,'env',selectedFolder,'default/main'),true],
    ['/workspace/extra',path.join(config.DATA_DIR,'extra',selectedFolder),false],['/app/src',path.resolve('container/agent-runner/src'),true],['/app/prompts',path.resolve('container/agent-runner/prompts'),true],
   ].map(([destination,source,readonly])=>[destination,{source,readonly}]));
  },activate(){ready=true;},
  async verify(boundary:any){
   if(process.env.QIWE_FULL_HOST_PHASE==='restart'){expect(runs).toEqual([]);return {runs:[]};}
   expect(runs).toHaveLength(1);const run=runs[0];await boundary.wait(()=>run.exitCode!==null,'actual original runner Docker exits after drain');
   expect(run.exitCode,run.stderr).toBe(0);expect(run.inspection?.Id).toMatch(/^[a-f0-9]{64}$/);
   expect(run.inspection.HostConfig.NetworkMode).toBe('none');expect(run.inspection.HostConfig.ReadonlyRootfs).toBe(true);
   expect(run.inspection.Mounts.some((m:any)=>m.Destination.includes('docker.sock')||m.Destination==='/qiwe-control')).toBe(false);
   const eventFile=path.resolve('data/ipc',selectedFolder,'verification-events.ndjson'),events=fs.readFileSync(eventFile,'utf8').trim().split('\n').map(v=>JSON.parse(v));
   const bootstrap=events.find(e=>e.type==='bootstrap');expect(bootstrap).toMatchObject({uid:1000,gid:1000,originalShellExecuted:true,chromiumExecuted:true,identityBridgeExecuted:true,socketPresent:false});
   expect(bootstrap.shellEvidence).toMatchObject({mainEffectiveCaps:'0000000000000000',shellEffectiveCaps:'00000000000000eb',noNewPrivileges:'1',piVersion:'0.84.2'});
   const used=events.find(e=>e.type==='provider'&&e.messages.some((m:any)=>m.role==='toolResult'));
   expect(used).toBeDefined();const results=used.messages.filter((m:any)=>m.role==='toolResult');
   const ids=['approved','skill',...(c4Case?['strategy','copywriting']:[]),'forbidden-project','forbidden-user'];
   expect(results).toHaveLength(ids.length);
   for(const id of ids){const found=results.filter((r:any)=>r.toolCallId===id);expect(found).toHaveLength(1);expect(found[0].toolName).toBe('read');
    if(['forbidden-project','forbidden-user'].includes(id)||id==='approved'&&c4Case==='missing-evidence')expect(found[0].isError).toBe(true);else expect(found[0].isError).not.toBe(true);
   }
   if(c4Case){
    expect(used.messages.findLast((m:any)=>m.role==='user')?.content).toBeDefined();
    const textOf=(id:string)=>results.find((r:any)=>r.toolCallId===id).content.map((p:any)=>p.text??'').join('');
    for(const [id,skill]of [['skill',skillIds[0]],['strategy',skillIds[1]],['copywriting',skillIds[2]]] as const)expect(textOf(id).trim()).toBe(fs.readFileSync(path.resolve('skill-sources',skill,'SKILL.md'),'utf8').trim());
    const final=run.stdout;expect(final).toContain('synthetic-c4-real-container-answer');
    expect(fs.existsSync(path.join(run.mounts.find((mount:any)=>mount.destination==='/workspace/group').source,'approved.txt'))).toBe(c4Case==='grounded');
   }
   const {proc,...evidence}=run;const output={c4Case:c4Case??null,runs:[evidence],events};
   fs.writeFileSync(path.resolve('local-container-evidence.json'),JSON.stringify(output,null,2),{flag:existing?'wx':'w'});
   // Move only the exact instrumentation file out of scanned application IPC.
   const eventTarget=path.resolve('local-container-events.ndjson');
   if(existing){fs.linkSync(eventFile,eventTarget);fs.unlinkSync(eventFile);}else fs.renameSync(eventFile,eventTarget);
   return output;
  },
 };
}
