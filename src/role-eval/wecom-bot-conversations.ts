import type {WorkbenchRole} from './workbench-access.js';
import {createHash} from 'node:crypto';
import type {BotContextRequest,WecomBotContext,createWecomBotContext} from './wecom-bot-context.js';
import type {BotEvent} from './wecom-bot-transport.js';
import type {BotTaskStore,BotConversationActor,BotConversationEvent} from './wecom-bot-task-store.js';
import {parseManagerCommand} from './manager-commands.js';
import {parseBotTaskCommand} from './wecom-bot-task-commands.js';

export type BotConversationCommand={kind:'select';role:WorkbenchRole}|{kind:'exit'|'status'|'invalid'};
const roles:Record<string,WorkbenchRole>={客服接待:'reception',前台办理:'frontdesk',内容营销:'marketing',投放辅助:'ads',店长经营:'manager',评测质检:'qa',培训:'training',reception:'reception',frontdesk:'frontdesk',marketing:'marketing',ads:'ads',manager:'manager',qa:'qa',training:'training'};
export function parseBotConversationCommand(text:string):BotConversationCommand|undefined{
 const value=text.trim();if(value==='退出岗位对话')return {kind:'exit'};if(value==='岗位查询')return {kind:'status'};
 const match=/^岗位\s+(\S+)$/.exec(value);
 if(match)return Object.hasOwn(roles,match[1]!)?{kind:'select',role:roles[match[1]!]!}:{kind:'invalid'};
 return value==='岗位'||value.startsWith('岗位 ')?{kind:'invalid'}:undefined;
}

export interface BotRoleWorkspaceInput {
 actor:BotConversationActor&{role:WorkbenchRole};scope:BotContextRequest;idempotencyKey:string;
 assertCurrent():Promise<void>;withCurrent<T>(work:()=>T extends PromiseLike<unknown>?never:T):Promise<T>;
}
export type BotRoleWorkspaceRead={state:'ready';workspaceJid:string;profileId:string;ownerAccountId:string;storeId:string;role:WorkbenchRole}|{state:'missing'|'unknown';detail:string};
export interface BotRoleWorkspacePort {
 readRoleWorkspace(input:BotRoleWorkspaceInput):Promise<BotRoleWorkspaceRead>;
 prepareRoleWorkspace(input:BotRoleWorkspaceInput):Promise<Exclude<BotRoleWorkspaceRead,{state:'missing'}>>;
}
export interface BotConversationExecution {state:'queued'|'running'|'cancelling'|'cancelled'|'completed'|'failed'|'unknown';queryId?:string;turnId?:string;sessionId?:string;batchSize?:number}
export interface BotConversationReceipt {receiptId:string;messageId:string;acceptedAt:string;state:'accepted';role:WorkbenchRole;workspaceJid:string;profileId:string;selectionId:string;fingerprint:string;execution?:BotConversationExecution}
export interface BotConversationReadInput {
 actor:BotConversationActor;roles:readonly WorkbenchRole[];receiptId:string;scope:BotContextRequest;
 assertCurrent():Promise<void>;withCurrent<T>(work:()=>T extends PromiseLike<unknown>?never:T):Promise<T>;
}
export interface BotConversationSubmitInput extends BotConversationReadInput {
 originMessageId:string;fingerprint:string;text:string;target:{workspaceJid:string;profileId:string;role:WorkbenchRole;selectionId:string};
}
export interface BotConversationIntakePort {readReceipt(input:BotConversationReadInput):Promise<BotConversationReceipt|undefined>;submitMessage(input:BotConversationSubmitInput):Promise<BotConversationReceipt>;cancelReceipt?(input:BotConversationReadInput):Promise<BotConversationReceipt|undefined>}
export interface BotConversationsOptions {store:BotTaskStore;native:BotRoleWorkspacePort;intake?:BotConversationIntakePort;authority:ReturnType<typeof createWecomBotContext>}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function bounded<T>(scope:BotContextRequest,physical:Promise<T>):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  let settled=false;
  const finish=(error?:Error,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);scope.signal.removeEventListener('abort',cancel);if(error)reject(error);else resolve(value!);};
  const cancel=()=>finish(Error('authority_cancelled'));
  const timer=setTimeout(()=>finish(Error('authority_timeout')),Math.max(0,scope.deadline-performance.now()));
  scope.signal.addEventListener('abort',cancel,{once:true});
  if(scope.signal.aborted)cancel();else if(performance.now()>=scope.deadline)finish(Error('authority_timeout'));
  physical.then(value=>finish(undefined,value),error=>finish(error instanceof Error?error:Error('authority_unavailable')));
 });
}
export function createBotConversations({store,native,intake,authority}:BotConversationsOptions){
 const reconcileHint='重新发送选岗命令可核实准备结果；不会重复创建。如仍无法核实，请联系管理员。';
 const actor=(context:WecomBotContext):BotConversationActor=>({tenantId:context.identity.tenantId,storeId:context.identity.storeId,accountId:context.identity.accountId,corpId:context.channel.corpId,botId:context.channel.botId,memberId:context.channel.memberId,bindingVersion:context.channel.bindingVersion,grantVersion:context.identity.grantVersion});
 const event=(context:WecomBotContext,source:BotEvent,role:WorkbenchRole):BotConversationEvent=>({actor:actor(context),messageId:source.messageId,fingerprint:hash([source.botId,source.memberId,source.messageId,source.createTime??null,source.action]),role});
 const name=(role:WorkbenchRole)=>Object.entries(roles).find(([key,value])=>value===role&&/[^\x00-\x7f]/.test(key))?.[0]??role;
 const receiptId=(context:WecomBotContext,messageId:string)=>hash([context.channel.corpId,context.channel.botId,context.channel.memberId,messageId]);
 const scopeCopy=(scope:BotContextRequest):BotContextRequest=>Object.freeze({signal:scope.signal,deadline:scope.deadline,correlationId:scope.correlationId});
 const readInput=(context:WecomBotContext,scope:BotContextRequest,id:string):BotConversationReadInput=>Object.freeze({actor:Object.freeze({...actor(context)}),roles:Object.freeze([...context.roles]),receiptId:id,scope:scopeCopy(scope),assertCurrent:()=>authority.assertCurrent(context),withCurrent:<T>(work:()=>T extends PromiseLike<unknown>?never:T)=>authority.withCurrent(context,work)});
 const executionText:Record<BotConversationExecution['state'],string>={queued:'排队中，等待原会话执行。',running:'执行中。',cancelling:'取消处理中，尚未确认执行停止。',cancelled:'已取消；已经发生的业务操作不会自动撤销。',completed:'执行已结束，答案回传尚未接通。',failed:'执行失败，未自动重新执行。',unknown:'执行结果待核实，请稍后查询，不要重复提交。'};
 const validExecution=(value:BotConversationExecution|undefined)=>value===undefined||!!value&&Object.hasOwn(executionText,value.state)&&(['queryId','turnId','sessionId'] as const).every(key=>value[key]===undefined||typeof value[key]==='string'&&!!value[key])&&(value.batchSize===undefined||Number.isSafeInteger(value.batchSize)&&value.batchSize>0);
 const validReceipt=(value:BotConversationReceipt|undefined,id:string)=>value&&value.state==='accepted'&&value.receiptId===id&&/^[a-f0-9]{64}$/.test(value.fingerprint)&&typeof value.messageId==='string'&&!!value.messageId&&!!value.acceptedAt&&!!value.workspaceJid&&!!value.profileId&&!!value.selectionId&&Object.values(roles).includes(value.role)&&validExecution(value.execution);
 const receiptView=(value:BotConversationReceipt)=>`已保存需求，受理编号：${value.receiptId}。原${name(value.role)}岗位；查询对话 ${value.receiptId}。${value.execution?executionText[value.execution.state]+(value.execution.state==='cancelling'&&(value.execution.batchSize??0)>1?'本次取消会停止同批共同执行。':''):'执行尚未接通，本次未生成答案。'}`;
 return {async route(context:WecomBotContext,source:BotEvent,scope:BotContextRequest,replayState:'none'|'reserved'|'completed-report'|'completed-nonreport'='none'):Promise<{reply?:string;reportText?:string}|undefined>{
  if(source.action.kind!=='text')return undefined;
  const text=source.action.text.trim(),command=parseBotConversationCommand(text),current=store.currentConversation(actor(context));
  if(text.startsWith('查询对话')||text.startsWith('取消对话')){
   const cancelling=text.startsWith('取消对话'),match=/^(?:查询对话|取消对话)\s+([a-f0-9]{64})$/.exec(text);
   if(!match)return {reply:`请发送“${cancelling?'取消':'查询'}对话 受理编号”，使用原消息中的完整编号。`};
   if(!intake)return {reply:'对话受理尚未接通，无法查询对话编号。'};
   if(cancelling&&!intake.cancelReceipt)return {reply:'对话取消尚未接通，请查询原受理状态。'};
   const input=readInput(context,scope,match[1]!);await authority.assertCurrent(context);
   const observed=await bounded(scope,intake.readReceipt(input)),receipt=observed&&structuredClone(observed);await authority.assertCurrent(context);
   if(!receipt)return {reply:'未找到你有权访问的对话受理记录，请核对受理编号。'};
   if(!validReceipt(receipt,input.receiptId))throw Error('authority_unavailable');
   if(!context.roles.includes(receipt.role))throw Error('access_denied');
   if(cancelling){
    const unknown=()=>({reply:`取消结果待核实。请稍后发送：查询对话 ${input.receiptId}；请勿重复提交。`});
    if(replayState!=='none')return unknown();
    let cancelled:BotConversationReceipt|undefined;
    try{cancelled=await bounded(scope,intake.cancelReceipt!(input));}catch(error){await authority.assertCurrent(context);if(error instanceof Error&&['authority_cancelled','authority_timeout','access_changed','access_denied'].includes(error.message))throw error;return unknown();}
    await authority.assertCurrent(context);
    if(!validReceipt(cancelled,input.receiptId)||!cancelled?.execution)return unknown();
    if(cancelled.role!==receipt.role||cancelled.workspaceJid!==receipt.workspaceJid||cancelled.messageId!==receipt.messageId||cancelled.profileId!==receipt.profileId||cancelled.selectionId!==receipt.selectionId||cancelled.fingerprint!==receipt.fingerprint)return unknown();
    return {reply:receiptView(cancelled)};
   }
   return {reply:receiptView(receipt)};
  }
  if(command?.kind==='invalid')return {reply:'请发送：岗位 内容营销（或其他已开通岗位）；退出岗位对话。'};
  if(command?.kind==='status')return {reply:current?.state==='stale'?'原岗位选择已因授权或绑定变化失效，请重新选择获准岗位或退出。':current?.state==='ready'?`当前${name(current.role)}岗位对话，门店${current.actor.storeId}。`:current?`岗位空间准备结果待核实。${reconcileHint}`:'当前未选择岗位对话。'};
  if(command?.kind==='exit'){
   await authority.withCurrent(context,guard=>store.exitConversation(actor(context),source.messageId,hash([source.botId,source.memberId,source.messageId,source.createTime??null,source.action]),guard));
   return {reply:'已退出岗位对话，普通文字恢复原报数规则。'};
  }
  if(command?.kind==='select'){
   if(!context.roles.includes(command.role))throw Error('access_denied');
   const seed=event(context,source,command.role),reservation=await authority.withCurrent(context,guard=>store.beginConversationSelection(seed,guard));
   if(store.currentConversation(actor(context))?.eventId!==reservation.eventId)return {reply:'这条选岗消息已由更新的岗位选择覆盖；请以当前岗位为准。'};
   if(reservation.state==='ready')return {reply:`已选择${name(command.role)}岗位对话，当前门店${context.identity.storeId}。${intake?(intake.cancelReceipt?'可发送需求、查询进度或取消对话。':'可保存需求并查询受理编号；对话执行尚未接通。'):'后续自然语言对话执行尚未接通。'}`};
   const trustedActor=Object.freeze({...actor(context),role:command.role}),input:BotRoleWorkspaceInput={actor:Object.freeze({...trustedActor}),scope:Object.freeze({signal:scope.signal,deadline:scope.deadline,correlationId:scope.correlationId}),idempotencyKey:hash([trustedActor.tenantId,trustedActor.accountId,trustedActor.storeId,command.role]),assertCurrent:()=>authority.assertCurrent(context),withCurrent:work=>authority.withCurrent(context,work)};
   Object.freeze(input);
   await authority.assertCurrent(context);
   let result=await bounded(scope,native.readRoleWorkspace(input));await authority.assertCurrent(context);
   if(result.state==='missing'){
    if(reservation.state!=='preparing')return {reply:`岗位空间准备结果尚未核实。${reconcileHint}`};
    const claimed=await authority.withCurrent(context,guard=>store.claimConversationPreparation(seed,guard));
    if(!claimed)return {reply:`岗位空间准备仍在处理中。${reconcileHint}`};
    result=await bounded(scope,native.prepareRoleWorkspace(input));await authority.assertCurrent(context);
   }
   if(result.state!=='ready'){
    await authority.withCurrent(context,guard=>store.markConversationUnknown(seed,guard));
    return {reply:`岗位空间准备结果暂时无法核实。${reconcileHint}`};
   }
   if(result.ownerAccountId!==trustedActor.accountId||result.storeId!==trustedActor.storeId||result.role!==command.role||!/^web:(?!home(?:-|:|$))[^\s#]{1,196}$/.test(result.workspaceJid)||!result.profileId)throw Error('access_denied');
   const saved=await authority.withCurrent(context,guard=>store.finishConversationSelection(seed,{workspaceJid:result.workspaceJid,profileId:result.profileId},guard));
   return {reply:saved.state==='ready'?`已选择${name(command.role)}岗位对话，当前门店${context.identity.storeId}。${intake?(intake.cancelReceipt?'可发送需求、查询进度或取消对话。':'可保存需求并查询受理编号；对话执行尚未接通。'):'后续自然语言对话执行尚未接通。'}`:'这条选岗消息已由更新的岗位选择覆盖；请以当前岗位为准。'};
  }
  const report=/^报数\s+([\s\S]+)$/.exec(text);
  if(report){if(!context.roles.includes('manager'))throw Error('access_denied');return {reportText:report[1]!.trim()};}
  if(parseBotTaskCommand(text)||parseManagerCommand(text)||/^(查询|导出Excel|经营汇总|查询汇总|查询文件)(?:\s|$)/.test(text))return undefined;
  if(intake){
   const id=receiptId(context,source.messageId),input=readInput(context,scope,id),fingerprint=hash([source.botId,source.memberId,source.messageId,source.createTime??null,source.action]);
   await authority.assertCurrent(context);
   let existing:BotConversationReceipt|undefined;
   try{existing=await bounded(scope,intake.readReceipt(input));}catch(error){await authority.assertCurrent(context);throw error;}
   await authority.assertCurrent(context);
   if(existing){if(!validReceipt(existing,id)||existing.fingerprint!==fingerprint)throw Error('bot_reply_conflict');if(!context.roles.includes(existing.role))throw Error('access_denied');return {reply:receiptView(existing)};}
   // Only a completed report may return to the original reporting route.
   // Another completed reply might be an uncertain Native submit.
   if(replayState==='completed-report')return undefined;
   if(replayState==='reserved'||replayState==='completed-nonreport')return {reply:`受理结果待核实。请稍后发送：查询对话 ${id}；请勿重复提交。`};
   if(current?.state==='ready'){
    if(!context.roles.includes(current.role))throw Error('access_changed');
    const target=Object.freeze({workspaceJid:current.workspaceJid!,profileId:current.profileId!,role:current.role,selectionId:current.eventId});
    const submitInput:BotConversationSubmitInput=Object.freeze({...input,originMessageId:source.messageId,fingerprint,text,target});
    let saved:BotConversationReceipt;
    try{saved=await bounded(scope,intake.submitMessage(submitInput));}catch(error){await authority.assertCurrent(context);if(error instanceof Error&&['authority_cancelled','authority_timeout','access_changed','access_denied'].includes(error.message))throw error;return {reply:`受理结果待核实。请稍后发送：查询对话 ${id}；请勿重复提交。`};}
    await authority.assertCurrent(context);
    if(!validReceipt(saved,id)||saved.fingerprint!==fingerprint||saved.role!==target.role||saved.workspaceJid!==target.workspaceJid||saved.profileId!==target.profileId||saved.selectionId!==target.selectionId)return {reply:`受理结果待核实。请稍后发送：查询对话 ${id}；请勿重复提交。`};
    return {reply:receiptView(saved)};
   }
  }
  if(current?.state==='stale')throw Error('access_changed');
  if(!current)return undefined;
  if(current.state!=='ready')return {reply:`岗位空间正在准备或结果待核实。${reconcileHint}`};
  if(!context.roles.includes(current.role))throw Error('access_changed');
  return {reply:'对话执行尚未接通，未受理这条需求，也未写入报数。'};
 }};
}
