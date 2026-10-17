import {parseBotTaskCommand,type BotTaskCommand} from './wecom-bot-task-commands.js';
import type {BotContextRequest,WecomBotContext} from './wecom-bot-context.js';
import type {BotEvent} from './wecom-bot-transport.js';
import {createHash} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
import {WORKBENCH_ROLES,type WorkbenchRole} from './workbench-access.js';
import type {createWecomBotContext,BotReadScope} from './wecom-bot-context.js';
import {BotTaskStore,type BotTaskOwner,type BotTaskRecord,type BotTaskBackend,type BotTaskStartOutcome} from './wecom-bot-task-store.js';
import type {createNativeBotTasks} from './native-bot-tasks.js';
import type {createTrainingGenerationService,TrainingRun} from './training-generation.js';
export interface BotTaskView {taskId?:string;status:string;content:string;}
export interface BotTaskRoute {tenantId:string;storeId:string;accountId:string;homeJid:string;role:WorkbenchRole;alias:string;taskId:string;profileId:string;workspaceJid:string;}
export interface BotTasksOptions {
 mode:'isolated-synthetic';authority:ReturnType<typeof createWecomBotContext>;store:BotTaskStore;catalog:readonly BotTaskRoute[];
 native?:ReturnType<typeof createNativeBotTasks>;
 training?:{enabled:boolean;resolve(owner:Readonly<BotTaskOwner>):ReturnType<typeof createTrainingGenerationService>};
}
export function createBotTasks(options:BotTasksOptions){
 const valid=(s:unknown,max=200):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=max&&!/[\u0000-\u001f]/.test(s);
 const catalog=structuredClone(options.catalog);if(options.mode!=='isolated-synthetic'||!Array.isArray(catalog)||catalog.some(r=>!r||!WORKBENCH_ROLES.includes(r.role)||![r.tenantId,r.storeId,r.accountId,r.homeJid,r.taskId,r.profileId,r.workspaceJid].every(v=>valid(v))||!/^web:/.test(r.homeJid)||!/^web:/.test(r.workspaceJid)||! /^[A-Za-z0-9_-]{1,64}$/.test(r.alias))||new Set(catalog.map(r=>JSON.stringify([r.tenantId,r.storeId,r.accountId,r.homeJid,r.role,r.alias]))).size!==catalog.length)throw Error('invalid_task_catalog');
 const {authority,store}=options,closing=new AbortController(),training=options.training?{enabled:options.training.enabled,resolve:options.training.resolve}:undefined;
 const native=options.native?{start:options.native.start.bind(options.native),query:options.native.query.bind(options.native),cancel:options.native.cancel.bind(options.native)}:undefined;
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const check=(scope:BotReadScope)=>{if(closing.signal.aborted)throw Error('tasks_closed');if(scope.signal.aborted)throw Error('authority_cancelled');if(!Number.isFinite(scope.deadline)||performance.now()>=scope.deadline)throw Error('authority_timeout');};
 const bounded=<T>(scope:BotReadScope,work:(child:BotReadScope)=>Promise<T>):Promise<T>=>{
  check(scope);const controller=new AbortController();return new Promise((resolve,reject)=>{let done=false;
   const finish=(error:unknown,value?:T)=>{if(done)return;done=true;clearTimeout(timer);scope.signal.removeEventListener('abort',cancel);closing.signal.removeEventListener('abort',close);controller.abort();error?reject(error):resolve(value!);};
   const cancel=()=>finish(Error('authority_cancelled')),close=()=>finish(Error('tasks_closed')),timer=setTimeout(()=>finish(Error('authority_timeout')),Math.min(2147483647,Math.max(0,scope.deadline-performance.now())));
   scope.signal.addEventListener('abort',cancel,{once:true});closing.signal.addEventListener('abort',close,{once:true});
   Promise.resolve().then(()=>{check(scope);return work({signal:controller.signal,deadline:scope.deadline});}).then(v=>{try{check(scope);finish(null,structuredClone(v));}catch(e){finish(e);}},e=>finish(e));
  });
 };
 const ownerFor=(context:WecomBotContext,role:WorkbenchRole):BotTaskOwner=>({tenantId:context.identity.tenantId,storeId:context.identity.storeId,accountId:context.identity.accountId,workspaceJid:context.identity.workspaceJid,...context.channel,role});
 const routeFor=(owner:BotTaskOwner,alias:string)=>catalog.find(r=>r.tenantId===owner.tenantId&&r.storeId===owner.storeId&&r.accountId===owner.accountId&&r.homeJid===owner.workspaceJid&&r.role===owner.role&&r.alias===alias);
 const nativeBackend=(r:BotTaskRoute):Extract<BotTaskBackend,{kind:'native'}>=>({kind:'native',taskId:r.taskId,workspaceJid:r.workspaceJid,profileId:r.profileId});
 const trainingService=(owner:BotTaskOwner)=>{if(!training?.enabled)throw Error('training_disabled');return training.resolve(Object.freeze({...owner}));};
 const checkTrainingReference=(r:BotTaskRecord,run:TrainingRun)=>{
  if(r.backend.kind!=='training'||r.input.kind!=='training'||run.id!==r.referenceId||run.actor.accountId!==r.owner.accountId||run.actor.workspaceJid!=='web:local-training'||run.input.requestKey!==r.backend.requestKey||run.input.query!==r.input.query||run.input.mode!==r.input.mode||run.input.persona!==r.input.persona)throw Error('task_reference_changed');
 };
 const labels:Record<string,string>={reserved:'待提交',attempting:'提交结果待核实，不要重复执行',linked:'已保存原任务引用',blocked:'明确未开始，请核对岗位配置或暂停状态',unknown:'结果未知，不会自动重新执行',queued:'排队中',running:'执行中',retry_wait:'原任务等待重试',success:'原任务执行完成；不代表业务交易已完成',failed:'执行失败，请核对原任务及可用资料',cancelled:'已取消；已发生的业务副作用不会回滚',missed:'原任务未执行',delivered:'仅原提示已投递，执行完成待核实',ready:'培训结果已保存，需人工审核',stale:'原资料已变化，旧结果不可继续使用','not-found':'未找到你有权访问的任务'};
 const view=(r:BotTaskRecord,status:string,output:string|null=null,page=1):BotTaskView=>{
  const points=Array.from(output??''),pages=Math.max(1,Math.ceil(points.length/2000)),body=page>pages?'页码超出范围。':points.slice((page-1)*2000,page*2000).join('');
  return {taskId:r.id,status,content:[`任务编号：${r.id}`,`岗位：${r.owner.role}`,`状态：${labels[status]??'状态待核实'}`,...(r.referenceId?[`原任务引用：${r.referenceId}`]:[]),...(r.cancellation.state!=='none'?[`取消请求：${{attempting:'处理中或结果待核实，不重复取消',requested:'已受理，原任务终态仍以查询为准',blocked:'明确未取消，请核对状态',unknown:'结果未知，不重复取消'}[r.cancellation.state]}`]:[]),...(output?[`结果第${Math.min(page,pages)}/${pages}页：`,body]:[]),`查回：查询任务 ${r.owner.role} ${r.id}${pages>1?' [页码]':''}`,`取消：取消任务 ${r.owner.role} ${r.id}`].join('\n')};
 };
 async function read(context:WecomBotContext,r:BotTaskRecord,scope:BotReadScope,page=1):Promise<BotTaskView>{
  if(r.state!=='linked')return view(r,r.state==='attempting'?'unknown':r.state);
  await authority.assertCurrent(context);check(scope);
  if(r.backend.kind==='native'){
   const route=r.input.kind==='native'?routeFor(r.owner,r.input.alias):undefined;
   if(!route||!isDeepStrictEqual(nativeBackend(route),r.backend)||!native)return view(r,'unknown');
   const result=await bounded(scope,child=>native.query({...r.owner},{...r.backend} as Extract<BotTaskBackend,{kind:'native'}>,'bot-'+r.id,r.referenceId!,child,()=>authority.assertCurrent(context)));
   await authority.assertCurrent(context);check(scope);return view(r,result.status,result.output,page);
  }
  const run=trainingService(r.owner).get({accountId:r.owner.accountId,workspaceJid:'web:local-training'},r.backend.requestKey);
  checkTrainingReference(r,run);
  await authority.assertCurrent(context);check(scope);return view(r,run.status,run.status==='ready'&&run.output?JSON.stringify(run.output):null,page);
 }
 return {
 async execute(context:WecomBotContext,rawEvent:BotEvent,rawCommand:BotTaskCommand,request:BotContextRequest):Promise<BotTaskView>{
  const event=structuredClone(rawEvent),command=structuredClone(rawCommand),scope={signal:request.signal,deadline:request.deadline};check(scope);await authority.assertCurrent(context);
  if(!context.roles.includes(command.role)||event.botId!==context.channel.botId||event.memberId!==context.channel.memberId||event.corpId!==undefined&&event.corpId!==context.channel.corpId)throw Error('access_denied');
  if(event.action.kind!=='text'||!isDeepStrictEqual(parseBotTaskCommand(event.action.text),command))throw Error('task_command_conflict');
  if(command.kind==='invalid')return {status:'needs-input',content:command.message};
  const owner=ownerFor(context,command.role);let record:BotTaskRecord|undefined;
  if(command.kind==='start'){
   const id=hash([owner.corpId,owner.botId,owner.memberId,event.messageId]),route=command.input.kind==='native'?routeFor(owner,command.input.alias):undefined;
   if(command.input.kind==='native'&&!route)return {status:'blocked',content:'此岗位尚未配置该已有任务别名，未执行。请联系管理员核实原任务与岗位绑定。'};
   const backend:BotTaskBackend=command.input.kind==='native'?nativeBackend(route!):{kind:'training',requestKey:'bot-'+id};
   record=await authority.withCurrent(context,guard=>{check(scope);return store.reserve({id,fingerprint:hash([event.botId,event.memberId,event.messageId,event.createTime??null,event.action]),owner,input:command.input,backend},guard);});
   const claim=await authority.withCurrent(context,guard=>{check(scope);return store.claimStart(owner,id,guard);});
   if(claim){
    let invoked=false,outcome:BotTaskStartOutcome={state:'blocked',detail:'backend_unavailable'};
    try{
     await authority.assertCurrent(context);check(scope);
     if(claim.backend.kind==='native'&&native){invoked=true;outcome=await bounded(scope,child=>native.start({...owner},{...claim.backend} as Extract<BotTaskBackend,{kind:'native'}>,'bot-'+id,child,()=>authority.assertCurrent(context)));}
     else if(claim.backend.kind==='training'&&training?.enabled){
      const service=trainingService(owner);check(scope);const input=command.input;if(input.kind!=='training')throw Error('task_conflict');
      invoked=true;const run=service.start({accountId:owner.accountId,workspaceJid:'web:local-training'},{mode:input.mode,query:input.query,persona:input.persona,requestKey:claim.backend.requestKey});
      outcome={state:'linked',referenceId:run.id,detail:'training_reference_saved'};
     }
    }catch(error){const code=error instanceof Error?error.message:'';outcome={state:invoked&&!['training_evidence_missing','training_evidence_too_large','invalid_training_generation'].includes(code)?'unknown':'blocked',detail:'task_submission_unverified'};}
    record=store.finishStart(owner,id,claim.attempt,outcome);
   }else record=store.get(owner,id)!;
  }else record=await authority.withCurrent(context,guard=>{check(scope);const r=store.get(owner,command.taskId);guard();return r;});
  if(!record)return {status:'not-found',content:'未找到你有权访问的任务，请核对岗位和完整编号。'};
  if(command.kind==='cancel'&&record.state==='linked'){
   const claim=await authority.withCurrent(context,guard=>{check(scope);return store.claimCancel(owner,record!.id,guard);});
   if(claim){let invoked=false,outcome:{state:'requested'|'blocked'|'unknown';detail:string}={state:'blocked',detail:'backend_unavailable'};
    try{await authority.assertCurrent(context);check(scope);
     if(claim.backend.kind==='native'&&native){const route=claim.input.kind==='native'?routeFor(owner,claim.input.alias):undefined;if(route&&isDeepStrictEqual(nativeBackend(route),claim.backend)){invoked=true;outcome=await bounded(scope,child=>native.cancel({...owner},{...claim.backend} as Extract<BotTaskBackend,{kind:'native'}>,'bot-'+claim.id,claim.referenceId!,child,()=>authority.assertCurrent(context)));}}
     else if(claim.backend.kind==='training'&&training?.enabled){const service=trainingService(owner),actor={accountId:owner.accountId,workspaceJid:'web:local-training'};checkTrainingReference(claim,service.get(actor,claim.backend.requestKey));invoked=true;const run=service.cancel(actor,claim.backend.requestKey,claim.referenceId!);checkTrainingReference(claim,run);outcome={state:run.status==='cancelled'?'requested':run.status==='unknown'?'unknown':'blocked',detail:'training_cancel_observed'};}
    }catch{outcome={state:invoked?'unknown':'blocked',detail:'cancellation_unverified'};}
    record=store.finishCancel(owner,claim.id,claim.cancellation.attempt,outcome);
   }else record=store.get(owner,record.id)!;
  }
  let result:BotTaskView;try{result=await read(context,record,scope,command.kind==='query'?command.page:1);}catch(error){const code=error instanceof Error?error.message:'';if(['access_changed','access_denied','authority_cancelled','authority_timeout','tasks_closed','context_closed','authority_unavailable'].includes(code))throw error;result=view(record,'unknown');}
  await authority.assertCurrent(context);check(scope);return result;
 },
 close(){closing.abort();}
 };
}
