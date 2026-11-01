import {expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {actor,folder,profileId} from './full-host-restoration.fixture.mts';

export const skillIds=['beauty-local-content','vendor-content-strategy','vendor-copywriting'];

/** D4's process/mount seam. Original runTurn, Pi adapter, SDK session and tools
 * remain executable. Only ModelRuntime's provider stream is synthetic. */
export async function installRestorationPi({config,transportCalls}:any){
 const work=path.resolve('restoration-pi-workspace'),ipc=path.join(config.DATA_DIR,'ipc',folder),agent=path.join(work,'config');
 if(process.env.QIWE_FULL_HOST_PHASE!=='restart'){
  fs.mkdirSync(work,{recursive:true});
  fs.writeFileSync(path.join(work,'approved.txt'),'合成方案：每场限额 12 人；来源 synthetic-approved-v1');
  const managed=path.join(config.DATA_DIR,'skills',actor.accountId);fs.mkdirSync(managed,{recursive:true});
  for(const id of skillIds)fs.cpSync(path.resolve('skill-sources',id),path.join(managed,id),{recursive:true});
 }
 process.env.MINICLAW_WORKSPACE_GROUP=work;process.env.MINICLAW_WORKSPACE_IPC=ipc;process.env.CLAUDE_CONFIG_DIR=agent;
 process.env.ANTHROPIC_API_KEY='synthetic-not-a-secret';
 fs.mkdirSync(path.join(ipc,'input'),{recursive:true});
 // The complete host owns the memory RPC handler as well. Keep its real tasks
 // directory usable; unlike isolated D4 there is no missing memory transport.
 const {ModelRuntime}=await import('../runner/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
 const {runTurn}=await import('../runner/src/pi-index.js');
 const {resolveAgentProfileUserSkillsPolicy}=await import('../src/container-runner.js');
 const requests:any[]=[],runs:any[]=[],outputs:any[]=[],releases=new Map<string,()=>void>();
 let active:any,closing=false;
 const modelSpy=vi.spyOn(ModelRuntime.prototype,'streamSimple').mockImplementation(((model:any,context:any,options:any)=>{
  const current=active;expect(current).toBeDefined();
  requests.push({turnId:current.input.turnId,queryId:current.input.queryRunId,systemPrompt:context.systemPrompt,messages:structuredClone(context.messages),offeredTools:context.tools?.map((tool:any)=>tool.name)});
  const latestUser=context.messages.findLastIndex((m:any)=>m.role==='user');
  const results=context.messages.slice(latestUser+1).filter((m:any)=>m.role==='toolResult');
  const textOf=(id:string)=>results.find((r:any)=>r.toolCallId===id)?.content.map((p:any)=>p.text??'').join('')??'';
  const material=textOf('read-approved'),strategy=textOf('read-vendor-content-strategy'),copy=textOf('read-vendor-copywriting');
  const fact=material.match(/每场限额 \d+ 人/)?.[0],cta=copy.match(/行动号召为([^。]+)。/)?.[1];
  const valid=results.length>0&&!results.some((r:any)=>r.isError)&&!!fact&&!!cta&&strategy.includes('拍摄资源需求');
  const content=results.length===0?[
   {type:'toolCall',id:'read-approved',name:'read',arguments:{path:'approved.txt'}},
   ...skillIds.map(id=>({type:'toolCall',id:'read-'+id,name:'read',arguments:{path:path.join(agent,'skills',id,'SKILL.md')}})),
   {type:'toolCall',id:'channel-context',name:'mcp__miniclaw__get_channel_context',arguments:{}},
  ]:[{type:'text',text:JSON.stringify({status:valid?'draft':'partial',executed:false,published:false,request:current.kind,draft:valid?{topic:`项目体验介绍：${fact}`,copy:`了解项目体验。${fact}。${cta}。`,methods:[{source:'vendor-content-strategy/SKILL.md',method:'主题对应到可展示的服务步骤'},{source:'vendor-copywriting/SKILL.md',method:'单一行动号召'}],evidence:'synthetic-approved-v1'}:null,channel:textOf('channel-context')})}];
  const message:any={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:results.length?'stop':'toolUse',timestamp:Date.now()};
  // Hold only the synthetic provider event, never original queue/runtime work.
  let resolveWait:()=>void=()=>{};
  const held=!closing&&results.length===0&&['first','active-cancel','successor'].includes(current.kind);
  const wait=held?new Promise<void>(resolve=>{resolveWait=resolve;releases.set(current.kind,resolve);}):Promise.resolve();
  const aborted=()=>{current.providerAborted=true;if(current.kind!=='active-cancel')resolveWait();};
  if(held){expect(options.signal).toBeDefined();options.signal.addEventListener('abort',aborted,{once:true});}
  const finish=async()=>{await wait;options.signal?.removeEventListener('abort',aborted);if(options.signal?.aborted){message.content=[];message.stopReason='aborted';message.errorMessage='Synthetic provider observed SDK AbortSignal';}return message;};
  return {async *[Symbol.asyncIterator](){await finish();yield message.stopReason==='aborted'?{type:'error',reason:'aborted',error:message}:{type:'done',reason:message.stopReason,message};},result:finish};
 }) as any);
 return {requests,runs,outputs,release:(kind:string)=>{expect(releases.has(kind),'provider hold '+kind).toBe(true);releases.get(kind)!();},
  async run(group:any,input:any,onProcess:any,onOutput:any){
   transportCalls.push(structuredClone(input));
   const kind=['active-cancel','successor','follow-up','first'].find(value=>input.prompt.includes('[pi-'+value+']'))??'unexpected';
   const current={input:structuredClone(input),kind,providerAborted:false,interrupted:false,closed:false,outputs:[] as any[],onOutput};runs.push(current);active=current;
   expect(input.agentProfile.id).toBe(profileId);expect(input.agentProfile.runtimePolicy.skills.mode).toBe('inherit');
   const policy=resolveAgentProfileUserSkillsPolicy(actor.accountId,input.agentProfile);expect(policy.mountUserSkills).toBe(true);
   const skills=policy.userSkillsDirOverride??path.join(config.DATA_DIR,'skills',actor.accountId);
   expect(fs.readdirSync(skills).sort()).toEqual([...skillIds].sort());
   fs.mkdirSync(agent,{recursive:true});const mounted=path.join(agent,'skills');
   if(!fs.existsSync(mounted))fs.symlinkSync(skills,mounted,'dir');else expect(fs.realpathSync(mounted)).toBe(fs.realpathSync(skills));
   onProcess({pid:0} as any,'synthetic-pi-process-transport',null);
   const runnerInput=structuredClone(input),turnOutputs:any[]=[];
   let delivered=Promise.resolve();const log=console.log;
   const stdout=vi.spyOn(console,'log').mockImplementation((...values:any[])=>{
    const value=values[0];
    if(values.length===1&&typeof value==='string'&&value.startsWith('{')){
     const output=JSON.parse(value);turnOutputs.push(output);outputs.push(output);current.outputs.push(output);
     delivered=delivered.then(()=>onOutput?.(output));void delivered.catch(()=>{});
    }else if(value!=='---MINICLAW_OUTPUT_START---'&&value!=='---MINICLAW_OUTPUT_END---')log(...values);
   });
   try{
    const outcome=await runTurn(runnerInput,{chatJid:runnerInput.currentSourceJid||runnerInput.chatJid,channelContext:runnerInput.channelContext,groupFolder:runnerInput.groupFolder,isHome:runnerInput.isHome??runnerInput.isMain??false,isAdminHome:runnerInput.isAdminHome??runnerInput.isMain??false,agentBuilderEnabled:runnerInput.agentBuilderEnabled??false,ownerProfileEnabled:runnerInput.miniclawOwnerProfileEnabled===true,interactionMode:runnerInput.interactionMode??'assistant',isScheduledTask:false,currentTaskId:null,currentInputTurnId:runnerInput.turnId,currentSessionId:runnerInput.sessionId??null,workspaceIpc:ipc,workspaceGroup:work},runnerInput.prompt,runnerInput.images,[]);
    current.interrupted=outcome.interrupted;current.closed=outcome.closed;
   }finally{stdout.mockRestore();}
   await delivered;
   console.log('RESTORATION_PI_TURN',JSON.stringify({kind,turnId:input.turnId,queryId:input.queryRunId,providerAborted:current.providerAborted,closed:current.closed,interrupted:current.interrupted,outputs:turnOutputs.map(output=>({status:output.status,inputTurnId:output.inputTurnId,inputTurnCompleted:output.inputTurnCompleted,finalizationReason:output.finalizationReason,statusText:output.streamEvent?.statusText}))}));
   // A transport return with no final cannot assert cancellation. D3 must see
   // an actual original interruption event before recording cancelled.
   return turnOutputs.findLast((output:any)=>output.status==='success'&&output.inputTurnCompleted)??{status:'success',result:null,newSessionId:runnerInput.sessionId};
  },releaseAll(){closing=true;for(const release of releases.values())release();},close(){modelSpy.mockRestore();}};
}
