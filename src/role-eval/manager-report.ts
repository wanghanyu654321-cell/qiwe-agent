export type PeriodKind='half'|'month'|'four'|'year';
export interface ReportItem {kind:'target'|'sales';start:string;end:string;amountCents:number;mode:'snapshot'|'increment';supersedes?:string;}
export function validDate(date:string):boolean {return /^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;}
export function reportPeriod(date: string, kind: string): {start:string;end:string} {
 if(!validDate(date))throw Error('invalid_report_date');
 const [y,m,d]=date.split('-').map(Number) as [number,number,number];
 const iso=(month:number,day:number)=>`${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 const last=(month:number)=>new Date(Date.UTC(y,month,0)).getUTCDate();
 if(kind==='half')return {start:iso(m,d<=15?1:16),end:iso(m,d<=15?15:last(m))};
 if(kind==='month')return {start:iso(m,1),end:iso(m,last(m))};
 if(kind==='four'){const first=Math.floor((m-1)/4)*4+1;return {start:iso(first,1),end:iso(first+3,last(first+3))};}
 if(kind==='year')return {start:iso(1,1),end:iso(12,31)};
 throw Error('invalid_period_kind');
}
export function yuanToCents(text: string): number {
 const match=/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(万)?(?:元)?$/.exec(text.trim());
 if(!match)throw Error('invalid_sales_amount');
 const decimals=match[2]??'',places=match[3]?6:2;
 if(decimals.length>places)throw Error('invalid_sales_precision');
 const cents=BigInt(match[1]!.replaceAll(',',''))*10n**BigInt(places)+BigInt(decimals.padEnd(places,'0')||'0');
 if(cents>BigInt(Number.MAX_SAFE_INTEGER))throw Error('sales_amount_overflow');return Number(cents);
}
/** Offline conservative extraction. Unrecognized natural language remains a human edit, never a model run. */
export function parseStaffReport(text:string,date:string):{items:ReportItem[];missing:string[];parser:'offline-rules'} {
 if(!validDate(date)||typeof text!=='string'||!text.trim()||text.length>4000)throw Error('invalid_staff_report');
 const items:ReportItem[]=[],missing=new Set<string>();
 const chunks=text.replace(/(\d),(?=\d{3}(?:\D|$))/g,'$1').split(/[，,；;\n。]+/).filter(x=>x.trim());
 for(const chunk of chunks){
  const kind=/目标/.test(chunk)?'target':/销售(?:成交)?(?:额)?|成交(?:额)?/.test(chunk)?'sales':null;
  if(!kind){missing.add('销售成交金额');continue;}
  if((chunk.match(/目标|销售(?:成交)?(?:额)?|成交(?:额)?/g)??[]).length>1){missing.add('多个指标需要分别核对');continue;}
  let period:{start:string;end:string}|undefined;
  const range=/(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(\d{4}-\d{2}-\d{2})/.exec(chunk);
  const explicit=/(\d{4}-\d{2}-\d{2})/.exec(chunk);
  let ref=explicit?.[1]??date;
  const md=/(\d{1,2})月(?:(\d{1,2})[日号])?/.exec(chunk);
  if(md&&!explicit)ref=date.slice(0,4)+'-'+md[1]!.padStart(2,'0')+'-'+(md[2]??date.slice(8)).padStart(2,'0');
  if(range)period={start:range[1]!,end:range[2]!};
  else if(/上半月|下半月/.test(chunk))period=reportPeriod(ref.slice(0,8)+(/上半月/.test(chunk)?'01':'16'),'half');
  else if(/今年|本年|全年/.test(chunk))period=reportPeriod(ref,'year');
  else if(/本月|这个月/.test(chunk)||md&&!md[2])period=reportPeriod(ref,'month');
  else if(explicit||md?.[2]||/今天|昨日|昨天/.test(chunk)){
   if(/昨天|昨日/.test(chunk))ref=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
   period={start:ref,end:ref};
  }
  const amount=/(?:目标|销售(?:成交)?(?:额)?|成交(?:额)?)\s*(?:为|是|了|:|：)?\s*([\d]+(?:\.[\d]+)?(?:万)?(?:元)?)\s*$/.exec(chunk);
  if(!period)missing.add('统计期间');
  if(!amount){missing.add('有效金额或单位');continue;}
  if(period){
   if(!validDate(period.start)||!validDate(period.end)||period.start>period.end){missing.add('有效日期');continue;}
   try{items.push({kind,...period,amountCents:yuanToCents(amount[1]!),mode:kind==='sales'&&/新增一笔|新增成交|新增销售/.test(chunk)?'increment':'snapshot'});}catch{missing.add('有效金额');}
  }
 }
 if(!items.length&&!/今天|昨天|昨日|\d{1,2}月|\d{4}-\d{2}-\d{2}|本月|今年|本年/.test(text))missing.add('统计期间');
 return {items,missing:[...missing],parser:'offline-rules'};
}
