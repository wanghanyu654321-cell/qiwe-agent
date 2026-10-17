import {createHash} from 'node:crypto';
import {createBotReportHandler,type BotReportOptions,type BotReportResult} from './wecom-bot-handler.js';
import type {BotContextRequest} from './wecom-bot-context.js';
import type {ReportDelivery} from './manager-store.js';
import type {createBotSender} from './wecom-bot-sender.js';
export interface BotDeliveryResult {result:BotReportResult;delivery:ReportDelivery|null;reportDelivery?:ReportDelivery;deferred?:boolean;suppressed?:boolean;}
export function botDeliveryNotice(delivery:ReportDelivery):string{
 return {prepared:'通知待投递',blocked:'明确尚未发送，可在恢复后重试',attempting:'通知正在尝试或中途退出，请勿重复投递',accepted:'平台已受理，不代表手机实收',rejected:'平台已拒绝，请核实原因；不会自动重发',unknown:'通知结果未知，请勿重复投递；可继续查询入账结果'}[delivery.state];
}
export function createBotDelivery(options:BotReportOptions&{sender:ReturnType<typeof createBotSender>}){
 const {ledger,authority,sender}=options;let closed=false;
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const checkOpen=()=>{if(closed)throw Error('delivery_closed');};
 const eventSeed=(value:Parameters<NonNullable<BotReportOptions['beforeWork']>>[0])=>{
  const c=value.context.channel,i=value.context.identity,event=value.event;
  return {id:hash(JSON.stringify([c.corpId,c.botId,c.memberId,event.messageId])),fingerprint:hash(JSON.stringify([event.botId,event.memberId,event.messageId,event.createTime??null,event.action])),target:{...c,accountId:i.accountId,workspaceJid:i.workspaceJid,storeId:i.storeId}};
 };
 const handler=createBotReportHandler({...options,beforeWork:(value,guard)=>{checkOpen();ledger.reserveBotReply({...value.actor},{...eventSeed(value),reqId:value.event.reqId},guard);}});
 return {
 async handle(request:BotContextRequest):Promise<BotDeliveryResult>{
  checkOpen();const input={signal:request.signal,deadline:request.deadline,correlationId:request.correlationId},result=await handler.handle(input);
  return handler.consumeReply(result,async value=>{
   const {context,event,actor}=value;
   const readReportDelivery=()=>value.result.reportId?ledger.getReport(actor,value.result.reportId)?.delivery:undefined;
   const report=value.result.reportId?ledger.getReport(actor,value.result.reportId):undefined;
   const confirmation=event.action.kind==='confirm'&&result.status==='confirmed'&&report?.botSource&&report.delivery?{reportId:report.id,deliveryId:report.delivery.id}:undefined;
   const reply=structuredClone(value.result.reply);
   if(event.action.kind==='text'&&/^查询\s/.test(event.action.text.trim())&&report?.delivery)reply.body.stream.content+='\n原报告'+botDeliveryNotice(report.delivery);
   const seed={...eventSeed(value),reply,...(report?{reportId:report.id}:{}),...(confirmation?{confirmation}:{})};
   await authority.withCurrent(context,guard=>{checkOpen();return ledger.prepareBotReply(actor,seed,guard);});
   const claim=await authority.withCurrent(context,guard=>{checkOpen();return ledger.claimBotReply(actor,seed.id,guard);});
   if(!claim){const delivery=ledger.getBotReply(actor,seed.id)?.delivery??null,reportDelivery=readReportDelivery();return {result,delivery,...(reportDelivery?{reportDelivery}:{}),suppressed:true};}
   const outcome=await sender.reply(claim.reply,input,async()=>{checkOpen();await authority.assertCurrent(context);});
   let delivery=claim.delivery,deferred=false;
   try{delivery=ledger.finishBotReply(actor,claim.id,claim.delivery.id,claim.delivery.attempt,outcome)?.delivery??delivery;}catch{deferred=true;}
   let reportDelivery=confirmation&&report?.delivery?{...report.delivery,state:delivery.state,attempt:claim.reportAttempt!,apiErrorCode:delivery.apiErrorCode,msgid:delivery.msgid,detail:delivery.detail,...(delivery.ackReqId?{ackReqId:delivery.ackReqId}:{})}:undefined;
   try{reportDelivery=readReportDelivery();}catch{deferred=true;}
   return {result,delivery,...(reportDelivery?{reportDelivery}:{}),...(deferred?{deferred:true}:{})};
  });
 },
 async recover(request:BotContextRequest,id:string):Promise<{delivery:ReportDelivery;deferred?:boolean;suppressed?:boolean}>{
  checkOpen();const input={signal:request.signal,deadline:request.deadline,correlationId:request.correlationId};
  return handler.consumeReport(input,id,async({context,actor,report})=>{
   const claim=await authority.withCurrent(context,guard=>{checkOpen();return ledger.claimReturn(actor,id,guard);});
   if(!claim)return {delivery:ledger.getReport(actor,id)?.delivery??report.delivery!,suppressed:true};
   const source=claim.botSource!;
   const content=['报数已入账',...claim.entries.map(e=>`${e.kind==='sales'?'销售成交':'目标'} ${e.start}至${e.end} ${Math.trunc(e.amountCents/100)}.${String(e.amountCents%100).padStart(2,'0')}元（${e.mode==='increment'?'新增':'期间快照'}）`),`报告编号：${claim.id}`,`查回：查询 ${claim.id}`].join('\n');
   const outcome=await sender.notify(source.memberId,content,input,async()=>{checkOpen();await authority.assertCurrent(context);});
   try{return {delivery:ledger.finishReturn(actor,id,claim.delivery!.id,claim.delivery!.attempt,outcome)?.delivery??claim.delivery!};}
   catch{return {delivery:claim.delivery!,deferred:true};}
  });
 },
 close(){closed=true;sender.close();}
 };
}
