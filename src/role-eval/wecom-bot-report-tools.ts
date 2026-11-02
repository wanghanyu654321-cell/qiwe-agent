import type {ManagerStore,StaffContext,StaffReport,BotReportSource} from './manager-store.js';
import {parseStaffReport,type ReportItem} from './manager-report.js';
import type {WorkbenchRole} from './workbench-access.js';
import type {BotPendingReports,PendingReportOwner} from './wecom-bot-task-store.js';
/**
 * qiwe adapter tools over claw-agent's manager service (ManagerStore + parseStaffReport).
 * report_numbers: every granted role; only produces a pending echo that needs 「对」/「确认」.
 * get_summary: manager (the highest pilot role) checked in code; otherwise a polite refusal.
 */
export type BotReportToolName='report_numbers'|'get_summary';
export const SUMMARY_DENIED='查看汇总需要店长及以上权限；报数可正常发送。';
export const SUMMARY_ROLES:readonly WorkbenchRole[]=['manager'];
export function botToolAllowed(name:BotReportToolName,roles:readonly WorkbenchRole[]):boolean{
 if(name==='report_numbers')return roles.length>0;
 if(name==='get_summary')return roles.some(role=>SUMMARY_ROLES.includes(role));
 return false;
}
export type ParsedReport=ReturnType<typeof parseStaffReport>;
/** A COMPLETE structured report: at least one item (target or deal) with period and amount, nothing missing. */
export function isCompleteReport(parsed:ParsedReport):boolean{return parsed.items.length>0&&parsed.items.length<=10&&parsed.missing.length===0;}
function parseOnce(text:string,date:string):ParsedReport|undefined{try{return parseStaffReport(text,date);}catch{return undefined;}}
/** Common colloquial forms rewritten to the canonical report grammar. The result is only used when it parses completely, and is always echoed back for 对/改 before anything is saved. */
export function normalizeReportText(text:string):string{
 let t=text.replace(/[\uFF10-\uFF19]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0)).replace(/[，,](?=\d{3}(?!\d))/g,'').replace(/\s+/g,' ').trim();
 t=t.replace(/今日|当天|今儿个?|本日/g,'今天').replace(/昨日|昨儿个?/g,'昨天');
 t=t.replace(/(?:总共|一共)?(?:卖了|卖出了?|营业额|营收|业绩|流水|销售额|成交额|成交了?)(?:是|为|有)?/g,'销售').replace(/销售(?:销售)+/g,'销售');
 t=t.replace(/(\d+(?:\.\d+)?)\s*[kK](?![a-zA-Z])/g,(_,n)=>String(Math.round(Number(n)*1000))+'元').replace(/(\d)\s*(?:块钱|块|元整|元钱)/g,'$1元');
 if(/销售|目标/.test(t)&&!/今天|昨天|前天|本月|上月|本周|上周|今年|月|日|号|\d{4}-\d{2}-\d{2}/.test(t))t='今天'+t;
 return t;
}
export function tryParseReport(text:string,date:string):ParsedReport|undefined{
 const direct=parseOnce(text,date);if(direct&&isCompleteReport(direct))return direct;
 const normalized=normalizeReportText(text);if(normalized===text)return direct;
 const widened=parseOnce(normalized,date);return widened&&isCompleteReport(widened)?widened:direct;
}
/** Local, content-free audit of report-like text that could not be parsed: digits masked, length capped, no ids or secrets. */
export function auditUnrecognizedReport(text:string):void{
 try{const shape=String(text).slice(0,40).replace(/\d/g,'9').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g,'<email>');
  console.info(JSON.stringify({event:'report_unrecognized',shape,length:String(text).length}));}catch{}
}
/** Confirmed ledger entries of this employee still in force (not superseded). */
function activeOwn(ledger:ManagerStore,actor:StaffContext){
 const all=ledger.list(actor).filter(r=>r.state==='confirmed').flatMap(r=>r.entries);
 const old=new Set(all.flatMap(e=>e.supersedes?[e.supersedes]:[]));
 return all.filter(e=>!old.has(e.id)&&e.employeeId===actor.employeeId);
}
/** Same kind and same period snapshot already confirmed: the new amount supersedes it (history kept, no silent overwrite). */
export function withSupersedes(ledger:ManagerStore,actor:StaffContext,items:readonly ReportItem[]):{items:ReportItem[];replaced:{index:number;previousAmountCents:number}[]}{
 const active=activeOwn(ledger,actor),replaced:{index:number;previousAmountCents:number}[]=[];
 const next=items.map((item,index)=>{
  if(item.mode!=='snapshot'||item.supersedes)return {...item};
  const old=active.find(e=>e.kind===item.kind&&e.start===item.start&&e.end===item.end&&e.mode==='snapshot');
  if(!old)return {...item};replaced.push({index,previousAmountCents:old.amountCents});return {...item,supersedes:old.id};
 });
 return {items:next,replaced};
}
export interface ReportNumbersInput {actor:StaffContext;roles:readonly WorkbenchRole[];owner:PendingReportOwner;messageKey:string;text:string;date:string;source:BotReportSource;now:Date;guard?:()=>void;}
export type ReportNumbersResult={status:'pending';report:StaffReport}|{status:'incomplete';missing:string[]}|{status:'denied'};
export function createBotReportTools({ledger,pendingReports}:{ledger:ManagerStore;pendingReports:BotPendingReports}){
 return {
  /** Never saves: records a pending ledger report and points the owner's confirmation at it. */
  reportNumbers(input:ReportNumbersInput):ReportNumbersResult{
   if(!botToolAllowed('report_numbers',input.roles))return {status:'denied'};
   const parsed=tryParseReport(input.text,input.date);
   if(!parsed||!isCompleteReport(parsed))return {status:'incomplete',missing:parsed?.missing.length?parsed.missing:['日期、目标或成交、金额']};
   const report=ledger.receiveBot(input.actor,input.messageKey,input.text,input.date,input.source,input.guard);
   pendingReports.open(input.owner,report,input.now,input.guard);
   return {status:'pending',report};
  },
  /** Saves the owner's open pending report; corrections of confirmed periods supersede (history kept). */
  confirmPending(input:{actor:StaffContext;roles:readonly WorkbenchRole[];owner:PendingReportOwner;now:Date;guard?:()=>void}):{status:'confirmed';report:StaffReport}|{status:'none'}|{status:'denied'}{
   if(!botToolAllowed('report_numbers',input.roles))return {status:'denied'};
   const pending=pendingReports.current(input.owner,input.now);if(!pending)return {status:'none'};
   const report=ledger.getReport(input.actor,pending.reportId);
   if(!report||report.hash!==pending.reportHash||!isCompleteReport(report.proposed))return {status:'none'};
   const confirmed=report.state==='confirmed'?report:ledger.confirm(input.actor,report.id,report.hash,withSupersedes(ledger,input.actor,report.proposed.items).items,input.guard);
   pendingReports.close(input.owner,report.id,'confirmed',input.now,input.guard);
   return {status:'confirmed',report:confirmed};
  },
  getSummaryAllowed(roles:readonly WorkbenchRole[]):boolean{return botToolAllowed('get_summary',roles);},
 };
}
