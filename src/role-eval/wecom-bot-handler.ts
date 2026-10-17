import {createHash} from 'node:crypto';
import type {ManagerStore,StaffContext,StaffReport} from './manager-store.js';
import type {BotContextRequest,createWecomBotContext} from './wecom-bot-context.js';
import {normalizeBotFrame,type BotReplyPlan} from './wecom-bot-transport.js';
export interface BotReportOptions {
 mode:'isolated-synthetic';authority:ReturnType<typeof createWecomBotContext>;ledger:ManagerStore;
 scope:{tenant:string;store:string;workspace:string};
 employees:readonly {accountId:string;employeeId:string;employeeName:string}[];
 /** Already authenticated SDK callback snapshot, never an HTTP/client payload. Synchronous and bounded by caller. */
 readEvent():unknown;now?:()=>Date;
}
export interface BotReportResult {status:'pending'|'confirmed'|'needs-input'|'not-found'|'conflict';reportId?:string;reply:BotReplyPlan;}
export function createBotReportHandler(options:BotReportOptions){
 const valid=(s:unknown):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=120&&!/[\u0000-\u001f]/.test(s);
 if(options.mode!=='isolated-synthetic'||!options.scope||Object.values(options.scope).length!==3||!['tenant','store','workspace'].every(k=>valid(Reflect.get(options.scope,k)))||!Array.isArray(options.employees)||!options.employees.length||options.employees.some(p=>!p||![p.accountId,p.employeeId,p.employeeName].every(valid))||new Set(options.employees.map(p=>p.accountId)).size!==options.employees.length||new Set(options.employees.map(p=>p.employeeId)).size!==options.employees.length)throw Error('invalid_report_catalog');
 const scope={...options.scope},employees=structuredClone(options.employees),{authority,ledger,readEvent}=options,now=options.now??(()=>new Date());
 const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 return {async handle(request:BotContextRequest):Promise<BotReportResult>{
  const input={correlationId:request.correlationId,signal:request.signal,deadline:request.deadline};
  let frame:unknown;try{frame=structuredClone(readEvent());}catch{throw Error('event_unavailable');}
  const event=normalizeBotFrame(frame),context=await authority.authorize(input,'manager');
  if(event.botId!==context.channel.botId||event.memberId!==context.channel.memberId||event.corpId!==undefined&&event.corpId!==context.channel.corpId||scope.tenant!==context.identity.tenantId||scope.store!==context.identity.storeId)throw Error('access_denied');
  const employee=employees.find(p=>p.accountId===context.identity.accountId);if(!employee)throw Error('access_denied');
  const actor:StaffContext={...scope,employeeId:employee.employeeId,employeeName:employee.employeeName};
  const plan=(status:BotReportResult['status'],content:string,report?:StaffReport,card=false):BotReportResult=>({status,...(report?{reportId:report.id}:{}),reply:{reqId:event.reqId,body:{msgtype:card?'stream_with_template_card':'stream',stream:{id:hash('report-reply|'+event.reqId),finish:true,content},...(card&&report?{template_card:{card_type:'button_interaction' as const,main_title:{title:'核对本人报数'},task_id:'report-'+report.id+'-'+hash(JSON.stringify([context.channel.corpId,event.botId,event.memberId,event.messageId,event.reqId])).slice(0,32),button_list:[{text:'确认入账',key:'confirm:'+report.hash,style:1 as const}]}}:{})}}});
  const view=(r:StaffReport):BotReportResult=>{
   const complete=r.proposed.items.length>0&&r.proposed.items.length<=10&&r.proposed.missing.length===0;
   const items=r.state==='confirmed'?r.entries:r.proposed.items;
   const content=[r.state==='confirmed'?'已入账':'待核对，尚未入账',...items.map(i=>`${i.kind==='sales'?'销售成交':'目标'} ${i.start}至${i.end} ${(i.amountCents/100).toFixed(2)}元（${i.mode==='increment'?'新增':'期间快照'}）`),...(!complete&&r.state==='pending'?['缺少或需核对：'+(r.proposed.missing.join('、')||'有效报数项目'),'请发送完整新报数；此条不会自动入账。']:[]),`报告编号：${r.id}`,`查回：查询 ${r.id}`].join('\n');
   return plan(r.state==='confirmed'?'confirmed':complete?'pending':'needs-input',content,r,r.state==='pending'&&complete);
  };
  const owned=(id:string)=>{const r=ledger.getReport(actor,id);return r&&(!r.botSource||r.botSource.accountId===context.identity.accountId)&&(!r.source||r.source.accountId===context.identity.accountId)?r:undefined;};
  let result:BotReportResult;
  try{
   result=await authority.withCurrent(context,checkActive=>{
    if(event.action.kind==='confirm'){
     const r=owned(event.action.reportId);if(!r)return plan('not-found','未找到你有权访问的报告，请核对报告编号。');
     if(r.hash!==event.action.hash)return plan('conflict',`报告版本不一致，未变更入账结果。请发送：查询 ${r.id}`);
     if(!r.proposed.items.length||r.proposed.items.length>10||r.proposed.missing.length)return view(r);
     return view(ledger.confirm(actor,r.id,r.hash,r.proposed.items,checkActive));
    }
    const text=event.action.text.trim();
    if(/^查询(?:\s|$)/.test(text)){
     const match=/^查询\s+([a-f0-9]{64})$/.exec(text);if(!match)return plan('needs-input','请发送“查询 报告编号”，使用原消息中的完整编号。');
     const r=owned(match[1]!);checkActive();return r?view(r):plan('not-found','未找到你有权访问的报告，请核对报告编号。');
    }
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(event.createTime===undefined?now():new Date(event.createTime*1000));
    const channel=context.channel,source={kind:'wecom-bot' as const,corpId:channel.corpId,botId:channel.botId,memberId:channel.memberId,messageId:event.messageId,accountId:context.identity.accountId,workspaceJid:context.identity.workspaceJid,storeId:context.identity.storeId,bindingVersion:channel.bindingVersion,...(event.createTime!==undefined?{createTime:event.createTime}:{})};
    const key='bot-'+hash(JSON.stringify([source.corpId,source.botId,source.memberId,source.messageId]));
    return view(ledger.receiveBot(actor,key,event.action.text,date,source,checkActive));
   });
  }catch(error){
   const code=error instanceof Error?error.message:'';
   if(['message_conflict','overlapping_report','confirmation_conflict','correction_conflict','report_version_conflict'].includes(code))result=plan('conflict','该消息或期间与已有记录冲突，未重复入账。请查询原报告；更正流程尚未在本阶段接入。');
   else if(['authority_cancelled','authority_timeout','context_closed','access_changed','access_denied','authority_unavailable'].includes(code))throw Error(code);
   else throw Error('report_unavailable');
  }
  // A committed report survives response failure. Do not roll it back or mark it delivered.
  await authority.assertCurrent(context);return result;
 }};
}
