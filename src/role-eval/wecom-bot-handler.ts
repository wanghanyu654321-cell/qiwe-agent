import {createHash} from 'node:crypto';
import type {ManagerStore,StaffContext,StaffReport,BotReplyAttachment} from './manager-store.js';
import type {ManagerArtifactStore,ManagerSnapshot,ManagerArtifact} from './manager-artifacts.js';
import {parseManagerCommand} from './manager-commands.js';
import {botDeliveryNotice} from './wecom-bot-notice.js';
import {parseBotTaskCommand} from './wecom-bot-task-commands.js';
import type {createBotTasks} from './wecom-bot-tasks.js';
import type {BotContextRequest,WecomBotContext,createWecomBotContext} from './wecom-bot-context.js';
import {normalizeBotFrame,type BotEvent,type BotReplyPlan} from './wecom-bot-transport.js';
export interface BotReportOptions {
 mode:'isolated-synthetic';authority:ReturnType<typeof createWecomBotContext>;ledger:ManagerStore;
 artifacts?:ManagerArtifactStore;
 tasks?:ReturnType<typeof createBotTasks>;
 scope:{tenant:string;store:string;workspace:string};
 employees:readonly {accountId:string;employeeId:string;employeeName:string}[];
 /** Already authenticated SDK callback snapshot, never an HTTP/client payload. Synchronous and bounded by caller. */
 readEvent():unknown;now?:()=>Date;
 /** Trusted synchronous reservation; a persisted file result can short-circuit regeneration on replay. */
 beforeWork?(value:{context:WecomBotContext;event:Readonly<BotEvent>;actor:Readonly<StaffContext>},checkActive:()=>void):BotReportResult|void;
}
export interface BotReportResult {status:'pending'|'confirmed'|'needs-input'|'not-found'|'conflict'|'summary'|'file'|'task';reportId?:string;snapshotId?:string;attachment?:BotReplyAttachment;taskId?:string;taskStatus?:string;reply:BotReplyPlan;}
export interface BotReplyExecution {context:WecomBotContext;event:BotEvent;actor:StaffContext;result:BotReportResult;}
export function createBotReportHandler(options:BotReportOptions){
 const valid=(s:unknown):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=120&&!/[\u0000-\u001f]/.test(s);
 if(options.mode!=='isolated-synthetic'||!options.scope||Object.values(options.scope).length!==3||!['tenant','store','workspace'].every(k=>valid(Reflect.get(options.scope,k)))||!Array.isArray(options.employees)||!options.employees.length||options.employees.some(p=>!p||![p.accountId,p.employeeId,p.employeeName].every(valid))||new Set(options.employees.map(p=>p.accountId)).size!==options.employees.length||new Set(options.employees.map(p=>p.employeeId)).size!==options.employees.length)throw Error('invalid_report_catalog');
 const scope={...options.scope},employees=structuredClone(options.employees),{authority,ledger,artifacts,tasks,readEvent,beforeWork}=options,now=options.now??(()=>new Date());
 const roster=employees.map(e=>({...scope,employeeId:e.employeeId,employeeName:e.employeeName}));
 const money=(cents:number|null)=>cents===null?'未知':`${cents<0?'-':''}${Math.trunc(Math.abs(cents)/100)}.${String(Math.abs(cents)%100).padStart(2,'0')}元`;
 const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const issued=new WeakMap<object,BotReplyExecution>();
 const resolveActor=(context:WecomBotContext):StaffContext=>{
  if(scope.tenant!==context.identity.tenantId||scope.store!==context.identity.storeId)throw Error('access_denied');
  const employee=employees.find(p=>p.accountId===context.identity.accountId);if(!employee)throw Error('access_denied');
  return {...scope,employeeId:employee.employeeId,employeeName:employee.employeeName};
 };
 return {
 async consumeReply<T>(result:BotReportResult,work:(value:BotReplyExecution)=>Promise<T>):Promise<T>{
  const own=result&&issued.get(result);if(!own)throw Error('access_denied');await authority.assertCurrent(own.context);
  return work({context:own.context,event:structuredClone(own.event),actor:{...own.actor},result:structuredClone(own.result)});
 },
 async consumeReport<T>(request:BotContextRequest,id:string,work:(value:{context:WecomBotContext;actor:StaffContext;report:StaffReport})=>Promise<T>):Promise<T>{
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('report_not_found');const context=await authority.authorize(request,'manager'),actor=resolveActor(context);
  const report=await authority.withCurrent(context,check=>{
   const r=ledger.getReport(actor,id);if(!r)throw Error('report_not_found');const source=r.botSource,c=context.channel,i=context.identity;
   if(r.state!=='confirmed'||!r.delivery||!source||source.corpId!==c.corpId||source.botId!==c.botId||source.memberId!==c.memberId||source.accountId!==i.accountId||source.workspaceJid!==i.workspaceJid||source.storeId!==i.storeId||source.bindingVersion!==c.bindingVersion)throw Error('access_denied');check();return r;
  });
  return work({context,actor,report});
 },
 async handle(request:BotContextRequest):Promise<BotReportResult>{
  const input={correlationId:request.correlationId,signal:request.signal,deadline:request.deadline};
  let frame:unknown;try{frame=structuredClone(readEvent());}catch{throw Error('event_unavailable');}
  const event=normalizeBotFrame(frame),taskCommand=event.action.kind==='text'?parseBotTaskCommand(event.action.text):undefined,context=await authority.authorize(input,taskCommand?.role??'manager');
  if(event.botId!==context.channel.botId||event.memberId!==context.channel.memberId||event.corpId!==undefined&&event.corpId!==context.channel.corpId||scope.tenant!==context.identity.tenantId||scope.store!==context.identity.storeId)throw Error('access_denied');
  const actor=resolveActor(context);
  const plan=(status:BotReportResult['status'],content:string,report?:StaffReport,card=false):BotReportResult=>({status,...(report?{reportId:report.id}:{}),reply:{reqId:event.reqId,body:{msgtype:card?'stream_with_template_card':'stream',stream:{id:hash('report-reply|'+event.reqId),finish:true,content},...(card&&report?{template_card:{card_type:'button_interaction' as const,main_title:{title:'核对本人报数'},task_id:'report-'+report.id+'-'+hash(JSON.stringify([context.channel.corpId,event.botId,event.memberId,event.messageId,event.reqId])).slice(0,32),button_list:[{text:'确认入账',key:'confirm:'+report.hash,style:1 as const}]}}:{})}}});
  const view=(r:StaffReport):BotReportResult=>{
   const complete=r.proposed.items.length>0&&r.proposed.items.length<=10&&r.proposed.missing.length===0;
   const items=r.state==='confirmed'?r.entries:r.proposed.items;
   const replaced=r.state==='confirmed'?ledger.supersededEntryIds(actor,r.id):[];
   const content=[r.state==='confirmed'?'已入账':'待核对，尚未入账',...(replaced.length?['部分或全部原明细已更正，原金额为历史记录，不再重复累计。']:[]),...(r.correction?[`更正原金额：${money(r.correction.previousAmountCents)}；新金额：${money(items[0]!.amountCents)}`]:[]),...items.map((i,index)=>`${index+1}. ${i.kind==='sales'?'销售成交':'目标'} ${i.start}至${i.end} ${money(i.amountCents)}（${i.mode==='increment'?'新增':'期间快照'}）`),...(!complete&&r.state==='pending'?['缺少或需核对：'+(r.proposed.missing.join('、')||'有效报数项目'),'请发送完整新报数；此条不会自动入账。']:[]),`报告编号：${r.id}`,`查回：查询 ${r.id}`].join('\n');
   return plan(r.state==='confirmed'?'confirmed':complete?'pending':'needs-input',content,r,r.state==='pending'&&complete);
  };
  const owned=(id:string)=>{const r=ledger.getReport(actor,id);return r&&(!r.botSource||r.botSource.accountId===context.identity.accountId)&&(!r.source||r.source.accountId===context.identity.accountId)?r:undefined;};
  const owner={accountId:context.identity.accountId,actor};
  const summaryView=(s:ManagerSnapshot):BotReportResult=>{
   const file=ledger.getBotFileReply(actor,s.snapshotHash,{...context.channel,accountId:context.identity.accountId,workspaceJid:context.identity.workspaceJid,storeId:context.identity.storeId});
   return {...plan('summary',[`经营汇总 ${s.period.start}至${s.period.end}`,'口径：销售成交额；不等于实收、充值或余额消耗。',`销售成交：${money(s.salesCents)}`,`目标：${money(s.targetCents)}`,`达成率：${s.rate===null?'未知':(s.rate*100).toFixed(2)+'%'}`,`差额：${money(s.varianceCents)}`,`期间覆盖：${s.coverage==='complete'?'完整':'部分，请核对缺报及跨期数据'}`,`快照编号：${s.snapshotHash}`,`文件投递：${file?botDeliveryNotice(file.delivery):'尚无当前成员的投递记录'}`,`查询汇总 ${s.snapshotHash}（查回汇总及文件投递状态，不会重发文件）`,`导出Excel ${s.snapshotHash}`,`查询文件 ${s.snapshotHash}（明确请求再次取得已有文件）`].join('\n')),snapshotId:s.snapshotHash};
  };
  const fileView=(info:ManagerArtifact):BotReportResult=>({...plan('file',`文件：${info.filename}\n快照编号：${info.snapshotHash}\n查询文件 ${info.snapshotHash}`),snapshotId:info.snapshotHash,attachment:{...info}});
  let exportSnapshot:string|undefined;
  let result:BotReportResult;
  try{
   result=await authority.withCurrent(context,checkActive=>{
    const replay=beforeWork?.({context,event:structuredClone(event),actor:{...actor}},checkActive);checkActive();if(replay)return structuredClone(replay);
    if(taskCommand)return plan('needs-input','正在核实任务。');
    if(event.action.kind==='confirm'){
     const r=owned(event.action.reportId);if(!r)return plan('not-found','未找到你有权访问的报告，请核对报告编号。');
     if(r.hash!==event.action.hash)return plan('conflict',`报告版本不一致，未变更入账结果。请发送：查询 ${r.id}`);
     if(!r.proposed.items.length||r.proposed.items.length>10||r.proposed.missing.length)return view(r);
     return view(ledger.confirm(actor,r.id,r.hash,r.proposed.items,checkActive));
    }
    const text=event.action.text.trim();
    const command=parseManagerCommand(text);
    if(command?.kind==='invalid')return plan('needs-input',command.message);
    if(command&&command.kind!=='correction'){
     if(!artifacts)return plan('needs-input','汇总和文件服务暂不可用，请稍后重试。');
     if(command.kind==='summary')return summaryView(artifacts.save(owner,ledger.summary(actor,command.date,command.period,roster),checkActive));
     const saved=artifacts.read(owner,command.snapshotId);if(!saved)return plan('not-found','未找到你有权访问的汇总快照，请核对完整编号。');
     if(command.kind==='snapshot')return summaryView(saved);
     if(command.kind==='file'){const file=artifacts.artifact(owner,command.snapshotId);return file?fileView(file.info):plan('not-found','此快照尚无可用文件，请先发送“导出Excel 快照编号”；已有文件不可用时请联系管理员核实。');}
     exportSnapshot=command.snapshotId;return plan('needs-input','文件正在生成。');
    }
    if(/^查询(?:\s|$)/.test(text)){
     const match=/^查询\s+([a-f0-9]{64})$/.exec(text);if(!match)return plan('needs-input','请发送“查询 报告编号”，使用原消息中的完整编号。');
     const r=owned(match[1]!);checkActive();return r?view(r):plan('not-found','未找到你有权访问的报告，请核对报告编号。');
    }
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(event.createTime===undefined?now():new Date(event.createTime*1000));
    const channel=context.channel,source={kind:'wecom-bot' as const,corpId:channel.corpId,botId:channel.botId,memberId:channel.memberId,messageId:event.messageId,accountId:context.identity.accountId,workspaceJid:context.identity.workspaceJid,storeId:context.identity.storeId,bindingVersion:channel.bindingVersion,...(event.createTime!==undefined?{createTime:event.createTime}:{})};
    const key='bot-'+hash(JSON.stringify([source.corpId,source.botId,source.memberId,source.messageId]));
    if(command?.kind==='correction')return view(ledger.receiveBotCorrection(actor,key,text,date,source,command.reportId,command.entryIndex,command.amountCents,checkActive));
    return view(ledger.receiveBot(actor,key,event.action.text,date,source,checkActive));
   });
   if(taskCommand){if(!tasks)result=plan('needs-input','任务服务尚未装配，未执行。请联系管理员核实。');else{const task=await tasks.execute(context,event,taskCommand,input);result={...plan(task.status==='needs-input'?'needs-input':'task',task.content),...(task.taskId?{taskId:task.taskId}:{}),taskStatus:task.status};}}
   else if(exportSnapshot){const id=exportSnapshot;result=fileView(await artifacts!.export(owner,id,input,async()=>{
    await authority.assertCurrent(context);
    await authority.withCurrent(context,guard=>{const saved=artifacts!.read(owner,id);if(!saved)throw Error('artifact_unavailable');if(ledger.summary(actor,saved.period.start,saved.kind,roster).snapshotHash!==id)throw Error('snapshot_changed');guard();});
   }));}
  }catch(error){
   const code=error instanceof Error?error.message:'';
   if(['task_conflict','task_attempt_conflict','task_reference_changed','task_command_conflict'].includes(code))result=plan('conflict','任务来源或原引用冲突，未重新执行。请核对岗位与原任务编号并查询，必要时联系管理员。');
   else if(['message_conflict','overlapping_report','confirmation_conflict','correction_conflict','report_version_conflict'].includes(code))result=plan('conflict','该消息或期间与已有记录冲突，未重复入账。请查询原报告，使用当前有效报告编号与明细序号发起更正。');
   else if(code==='invalid_correction_reference')result=plan('needs-input','请核对本人已确认报告的完整编号、明细序号和新金额。');
   else if(code==='snapshot_changed')result=plan('conflict','原汇总之后账本已变化，未发送文件。请重新发送经营汇总指令，按新快照导出；旧汇总仍可查询。');
   else if(['artifact_unavailable','artifact_snapshot_conflict','workbook_failed','invalid_workbook','invalid_workbook_size','no_confirmed_sales_data'].includes(code))result=plan('needs-input','文件尚未发送。请核对已确认报数；汇总或文件不可用时联系管理员核实，可继续在企微查询原报告和汇总。');
   else if(['authority_cancelled','authority_timeout','context_closed','tasks_closed','access_changed','access_denied','authority_unavailable','bot_reply_conflict','invalid_bot_reply'].includes(code))throw Error(code);
   else throw Error('report_unavailable');
  }
  // A committed report survives response failure. Do not roll it back or mark it delivered.
  await authority.assertCurrent(context);issued.set(result,{context,event:structuredClone(event),actor:{...actor},result:structuredClone(result)});return result;
 }};
}
