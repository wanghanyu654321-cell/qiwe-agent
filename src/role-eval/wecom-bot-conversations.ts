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
export interface BotConversationsOptions {store:BotTaskStore;native:BotRoleWorkspacePort;authority:ReturnType<typeof createWecomBotContext>}
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
export function createBotConversations({store,native,authority}:BotConversationsOptions){
 const reconcileHint='重新发送选岗命令可核实准备结果；不会重复创建。如仍无法核实，请联系管理员。';
 const actor=(context:WecomBotContext):BotConversationActor=>({tenantId:context.identity.tenantId,storeId:context.identity.storeId,accountId:context.identity.accountId,corpId:context.channel.corpId,botId:context.channel.botId,memberId:context.channel.memberId,bindingVersion:context.channel.bindingVersion,grantVersion:context.identity.grantVersion});
 const event=(context:WecomBotContext,source:BotEvent,role:WorkbenchRole):BotConversationEvent=>({actor:actor(context),messageId:source.messageId,fingerprint:hash([source.botId,source.memberId,source.messageId,source.createTime??null,source.action]),role});
 const name=(role:WorkbenchRole)=>Object.entries(roles).find(([key,value])=>value===role&&/[^\x00-\x7f]/.test(key))?.[0]??role;
 return {async route(context:WecomBotContext,source:BotEvent,scope:BotContextRequest):Promise<{reply?:string;reportText?:string}|undefined>{
  if(source.action.kind!=='text')return undefined;
  const text=source.action.text.trim(),command=parseBotConversationCommand(text),current=store.currentConversation(actor(context));
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
   if(reservation.state==='ready')return {reply:`已选择${name(command.role)}岗位对话，当前门店${context.identity.storeId}。后续自然语言对话执行尚未接通。`};
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
   return {reply:saved.state==='ready'?`已选择${name(command.role)}岗位对话，当前门店${context.identity.storeId}。后续自然语言对话执行尚未接通。`:'这条选岗消息已由更新的岗位选择覆盖；请以当前岗位为准。'};
  }
  const report=/^报数\s+([\s\S]+)$/.exec(text);
  if(report){if(!context.roles.includes('manager'))throw Error('access_denied');return {reportText:report[1]!.trim()};}
  if(parseBotTaskCommand(text)||parseManagerCommand(text)||/^(查询|导出Excel|经营汇总|查询汇总|查询文件)(?:\s|$)/.test(text))return undefined;
  if(current?.state==='stale')throw Error('access_changed');
  if(!current)return undefined;
  if(current.state!=='ready')return {reply:`岗位空间正在准备或结果待核实。${reconcileHint}`};
  if(!context.roles.includes(current.role))throw Error('access_changed');
  return {reply:'对话执行尚未接通，未受理这条需求，也未写入报数。'};
 }};
}
