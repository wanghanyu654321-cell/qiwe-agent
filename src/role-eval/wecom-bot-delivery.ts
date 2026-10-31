import {createHash} from 'node:crypto';
import {createBotReportHandler,createControlledRealBotReportHandler,type BotReportOptions,type BotReportResult} from './wecom-bot-handler.js';
import type {BotContextRequest,BotReadScope} from './wecom-bot-context.js';
import type {ReportDelivery} from './manager-store.js';
import type {createBotSender} from './wecom-bot-sender.js';
import {parseManagerCommand} from './manager-commands.js';
import {botDeliveryNotice} from './wecom-bot-notice.js';
export {botDeliveryNotice} from './wecom-bot-notice.js';
export interface BotDeliveryResult {result:BotReportResult;delivery:ReportDelivery|null;reportDelivery?:ReportDelivery;deferred?:boolean;suppressed?:boolean;}
type DeliveryOptions=Omit<BotReportOptions,'mode'>&{mode:'isolated-synthetic' | 'controlled-real-pilot';sender:ReturnType<typeof createBotSender>};
export function createBotDelivery(options:BotReportOptions&{sender:ReturnType<typeof createBotSender>}){
 if(options.mode!=='isolated-synthetic')throw Error('invalid_report_catalog');
 return createDelivery(options);
}
export function createControlledRealBotDelivery(options:Omit<DeliveryOptions,'mode'>&{mode:'controlled-real-pilot'}){
 if(options.mode!=='controlled-real-pilot')throw Error('invalid_report_catalog');
 return createDelivery(options);
}
function createDelivery(options:DeliveryOptions){
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
 const createHandler=(value:Omit<BotReportOptions,'mode'>)=>options.mode==='controlled-real-pilot'?createControlledRealBotReportHandler({...value,mode:'controlled-real-pilot'}):createBotReportHandler({...value,mode:'isolated-synthetic'});
 const handler=createHandler({...options,beforeWork:(value,guard)=>{
  checkOpen();const seed=eventSeed(value),wasReserved=ledger.reserveBotReply({...value.actor},{...seed,reqId:value.event.reqId},guard);
  const previous=ledger.getBotReply(value.actor,seed.id);return {replayState:wasReserved?(previous?(previous.reportId?'completed-report' as const:'completed-nonreport' as const):'reserved' as const):'none' as const,...(previous?.attachment?{cached:{status:'file' as const,snapshotId:previous.attachment.snapshotHash,attachment:{...previous.attachment},reply:structuredClone(previous.reply)}}:{})};
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
   const preflight=async(sendScope:BotReadScope=input)=>{checkOpen();await authority.assertCurrent(context);await value.beforeReply?.(sendScope);};
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

import {conversationResultPages,type BotConversationIntakePort,type BotConversationReadInput,type BotConversationReceipt,type BotConversationResult} from './wecom-bot-conversations.js';
import type {createWecomBotContext,WecomBotContext} from './wecom-bot-context.js';
import type {ManagerStore,StaffContext} from './manager-store.js';
/** Caller-driven, receipt-scoped delivery; no retained request or autonomous loop. */
export function createBotConversationDelivery(options:{
 authority:ReturnType<typeof createWecomBotContext>;ledger:ManagerStore;sender:ReturnType<typeof createBotSender>;intake:BotConversationIntakePort;
 scope:{tenant:string;store:string;workspace:string};employees:readonly {accountId:string;employeeId:string;employeeName:string}[];
 gate:{isPaused():boolean;beginWrite():unknown;finishWrite(ticket:unknown):void};
}){
 const {authority,ledger,sender}=options,intake={readReceipt:options.intake.readReceipt.bind(options.intake),readResults:options.intake.readResults?.bind(options.intake)},gate={isPaused:options.gate.isPaused.bind(options.gate),beginWrite:options.gate.beginWrite.bind(options.gate),finishWrite:options.gate.finishWrite.bind(options.gate)};
 const business=structuredClone(options.scope),employees=structuredClone(options.employees);
 const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 function check(request:BotContextRequest){if(gate.isPaused())throw Error('conversation_maintenance');if(request.signal.aborted)throw Error('authority_cancelled');if(!Number.isFinite(request.deadline)||performance.now()>=request.deadline)throw Error('authority_timeout');}
 const readInput=(context:WecomBotContext,request:BotContextRequest,receiptId:string):BotConversationReadInput=>Object.freeze({actor:Object.freeze({tenantId:context.identity.tenantId,accountId:context.identity.accountId,storeId:context.identity.storeId,...context.channel,grantVersion:context.identity.grantVersion}),roles:Object.freeze([...context.roles]),receiptId,scope:Object.freeze({...request}),assertCurrent:()=>authority.assertCurrent(context),withCurrent:<T>(work:()=>T extends PromiseLike<unknown>?never:T)=>authority.withCurrent(context,work)});
 function owner(context:WecomBotContext):StaffContext {
  const employee=employees.find(item=>item.accountId===context.identity.accountId);
  if(!employee||context.identity.tenantId!==business.tenant||context.identity.storeId!==business.store)throw Error('access_denied');
  return {...business,employeeId:employee.employeeId,employeeName:employee.employeeName};
 }
 async function prepare(context:WecomBotContext,request:BotContextRequest,id:string,afterRevision=0,afterPage=0,track=<T>(promise:Promise<T>)=>promise){
  check(request);const actor=owner(context),input=readInput(context,request,id);
  if(!intake.readResults)throw Error('conversation_results_unavailable');
  await authority.assertCurrent(context);const receipt=structuredClone(await track(intake.readReceipt(input)));await authority.assertCurrent(context);check(request);
  if(!receipt||receipt.receiptId!==id||!context.roles.includes(receipt.role)||receipt.execution?.state!=='completed')throw Error('conversation_result_not_found');
  const results=structuredClone(await track(intake.readResults(Object.freeze({...input,afterRevision}))));await authority.assertCurrent(context);check(request);
  if(results.length>32)throw Error('authority_unavailable');
  const intents=[];let next:{afterRevision:number;afterPage:number}|undefined;
  for(const result of results){
   if(result.receiptId!==id||!Number.isSafeInteger(result.revision)||result.revision<=afterRevision)throw Error('authority_unavailable');
   const pages=conversationResultPages(result);
   for(let n=0;n<pages.length;n++){
    if(result.revision===afterRevision+1&&n<afterPage)continue;
    if(intents.length===32){next={afterRevision:result.revision-1,afterPage:n};break;}
    const key=hash(['conversation',id,result.revision,result.digest,context.channel.corpId,context.channel.botId,context.channel.memberId,n+1]);
    const seed={id:key,fingerprint:hash([id,result.revision,result.digest,n+1,pages.length]),target:{...context.channel,accountId:context.identity.accountId,storeId:context.identity.storeId,workspaceJid:receipt.workspaceJid},conversation:{receiptId:id,revision:result.revision,digest:result.digest,page:n+1,pages:pages.length},reply:{reqId:'conversation-'+key,body:{msgtype:'stream' as const,stream:{id:key,finish:true as const,content:pages[n]!}}}};
    const intent=await authority.withCurrent(context,guard=>{check(request);return ledger.prepareBotReply(actor,seed,guard);});intents.push({intent,result,receipt});
   }
   if(next)break;
  }
  return {actor,input,intents,next:next??(results.length===32?{afterRevision:results.at(-1)!.revision,afterPage:0}:undefined)};
 }
 async function ticketed<T>(request:BotContextRequest,work:(track:<V>(promise:Promise<V>)=>Promise<V>)=>Promise<T>):Promise<T>{
  check(request);const ticket=gate.beginWrite();if(ticket===null||ticket===undefined)throw Error('conversation_maintenance');
  // Keep the gate ticket through actual read settlement, even if caller budget wins.
  const physicalReads=new Set<Promise<void>>();
  const track=<V>(promise:Promise<V>):Promise<V>=>{const settled=promise.then(()=>{},()=>{});physicalReads.add(settled);void settled.then(()=>physicalReads.delete(settled));return promise;};
  const physical=Promise.resolve().then(()=>work(track));
  const release=async()=>{while(physicalReads.size)await Promise.all([...physicalReads]);gate.finishWrite(ticket);};
  void physical.then(release,release);
  return new Promise<T>((resolve,reject)=>{let settled=false;const done=(error?:unknown,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);request.signal.removeEventListener('abort',cancel);if(error)reject(error);else resolve(value!);};const cancel=()=>done(Error('authority_cancelled'));const timer=setTimeout(()=>done(Error('authority_timeout')),Math.max(1,request.deadline-performance.now()));request.signal.addEventListener('abort',cancel,{once:true});physical.then(value=>done(undefined,value),error=>done(error));if(request.signal.aborted)cancel();});
 }
 return {
  prepare(context:WecomBotContext,request:BotContextRequest,id:string){return ticketed(request,track=>prepare(context,request,id,0,0,track));},
  recover(request:BotContextRequest,id:string,retry:{retryRejected?:boolean;afterRevision?:number;afterPage?:number}={}){return ticketed(request,async track=>{
   if(!/^[a-f0-9]{64}$/.test(id))throw Error('conversation_result_not_found');
   const context=await authority.authorize(request,null),prepared=await prepare(context,request,id,retry.afterRevision??0,retry.afterPage??0,track),deliveries:ReportDelivery[]=[];
   let dispatched=0,next:{afterRevision:number;afterPage:number}|undefined;
   for(const {intent,result,receipt} of prepared.intents){
    if(result.revision===(retry.afterRevision??0)+1&&intent.conversation!.page<=(retry.afterPage??0))continue;
    if(dispatched===32){next={afterRevision:result.revision-1,afterPage:intent.conversation!.page-1};break;}
    const claim=await authority.withCurrent(context,guard=>{check(request);return ledger.claimBotReply(prepared.actor,intent.id,guard,retry.retryRejected===true);});
    if(!claim){deliveries.push(ledger.getBotReply(prepared.actor,intent.id)!.delivery);continue;}dispatched++;
    const preflight=async()=>{
     check(request);await authority.assertCurrent(context);
     const observed=structuredClone(await track(intake.readReceipt(prepared.input)));
     const frozen=structuredClone(await track(intake.readResults!(Object.freeze({...prepared.input,revision:result.revision}))));
     await authority.assertCurrent(context);check(request);
     if(!observed||observed.workspaceJid!==receipt.workspaceJid||observed.profileId!==receipt.profileId||observed.role!==receipt.role||observed.selectionId!==receipt.selectionId||!context.roles.includes(observed.role)||frozen.length!==1||JSON.stringify(frozen[0])!==JSON.stringify(result))throw Error('access_changed');
    };
    const outcome=await sender.notify(claim.target.memberId,claim.reply.body.stream.content,request,preflight);
    try{deliveries.push(ledger.finishBotReply(prepared.actor,claim.id,claim.delivery.id,claim.delivery.attempt,outcome)!.delivery);}catch{deliveries.push(claim.delivery);}
   }
   if(!next)next=prepared.next;
   return {deliveries,...(next?{next}:{} )};
  });},
 };
}
