import {createHash} from 'node:crypto';
import {createBotReportHandler,type BotReportOptions,type BotReportResult} from './wecom-bot-handler.js';
import type {BotContextRequest} from './wecom-bot-context.js';
import type {ReportDelivery} from './manager-store.js';
import type {createBotSender} from './wecom-bot-sender.js';
import {parseManagerCommand} from './manager-commands.js';
import {botDeliveryNotice} from './wecom-bot-notice.js';
export {botDeliveryNotice} from './wecom-bot-notice.js';
export interface BotDeliveryResult {result:BotReportResult;delivery:ReportDelivery|null;reportDelivery?:ReportDelivery;deferred?:boolean;suppressed?:boolean;}
export function createBotDelivery(options:BotReportOptions&{sender:ReturnType<typeof createBotSender>}){
 const {ledger,authority,sender,artifacts}=options;let closed=false;
 const roster=structuredClone(options.employees).map(e=>({...options.scope,employeeId:e.employeeId,employeeName:e.employeeName}));
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const checkOpen=()=>{if(closed)throw Error('delivery_closed');};
 const eventSeed=(value:Parameters<NonNullable<BotReportOptions['beforeWork']>>[0])=>{
  const c=value.context.channel,i=value.context.identity,event=value.event;
  // The task_id routes a card update, not a new business intent. Preserve the
  // historical confirmation fingerprint so old blocked/unknown rows stay usable.
  const action=event.action.kind==='confirm'?{kind:'confirm',reportId:event.action.reportId,hash:event.action.hash}:event.action;
  return {id:hash(JSON.stringify([c.corpId,c.botId,c.memberId,event.messageId])),fingerprint:hash(JSON.stringify([event.botId,event.memberId,event.messageId,event.createTime??null,action])),target:{...c,accountId:i.accountId,workspaceJid:i.workspaceJid,storeId:i.storeId}};
 };
 const handler=createBotReportHandler({...options,beforeWork:(value,guard)=>{
  checkOpen();const seed=eventSeed(value);ledger.reserveBotReply({...value.actor},{...seed,reqId:value.event.reqId},guard);
  const previous=ledger.getBotReply(value.actor,seed.id);if(previous?.attachment)return {status:'file',snapshotId:previous.attachment.snapshotHash,attachment:{...previous.attachment},reply:structuredClone(previous.reply)};
 }});
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
   const attachment=value.result.attachment;
   const seed={...eventSeed(value),reply,...(report?{reportId:report.id}:{}),...(confirmation?{confirmation}:{}),...(attachment?{attachment}:{})};
   await authority.withCurrent(context,guard=>{checkOpen();return ledger.prepareBotReply(actor,seed,guard);});
   const claim=await authority.withCurrent(context,guard=>{checkOpen();return ledger.claimBotReply(actor,seed.id,guard);});
   if(!claim){const delivery=ledger.getBotReply(actor,seed.id)?.delivery??null,reportDelivery=readReportDelivery();return {result,delivery,...(reportDelivery?{reportDelivery}:{}),suppressed:true};}
   const preflight=async()=>{checkOpen();await authority.assertCurrent(context);};
   let outcome;
   if(claim.attachment){
    const descriptor=claim.attachment,owner={accountId:context.identity.accountId,actor};
    const currentFile=()=>{const file=artifacts?.artifact(owner,descriptor.snapshotHash);if(!file||file.info.sha256!==descriptor.sha256||file.info.filename!==descriptor.filename||file.info.byteLength!==descriptor.byteLength)throw Error('artifact_unavailable');return file;};
    try{
     const file=currentFile(),fresh=event.action.kind==='text'&&parseManagerCommand(event.action.text)?.kind==='export';
     const filePreflight=async()=>{await preflight();await authority.withCurrent(context,guard=>{currentFile();if(fresh){const snapshot=artifacts!.read(owner,descriptor.snapshotHash);if(!snapshot||ledger.summary(actor,snapshot.period.start,snapshot.kind,roster).snapshotHash!==descriptor.snapshotHash)throw Error('snapshot_changed');}guard();});};
     outcome=await sender.file(context.channel.memberId,descriptor.filename,file.bytes,input,filePreflight);
    }catch{outcome={state:'blocked' as const,apiErrorCode:null,msgid:null,detail:'file_not_sent'};}
   }else outcome=await sender.reply(claim.reply,input,preflight);
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
