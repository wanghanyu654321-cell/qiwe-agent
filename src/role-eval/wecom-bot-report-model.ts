import {parseStaffReport,validDate} from './manager-report.js';

/** One report line extracted by the model's `report_numbers` tool call. Amounts are yuan strings. */
export interface ExtractedReportItem {kind:'sales'|'target';start:string;end:string;amountYuan:string;increment?:boolean;}
export interface ReportExtractionInput {text:string;date:string;signal:AbortSignal;}
/** Returns undefined when the model did not produce a usable report. Never throws to the caller. */
export type BotReportExtractor=(input:ReportExtractionInput)=>Promise<readonly ExtractedReportItem[]|undefined>;

/** Anthropic-style tool definition offered to the model. */
export const REPORT_NUMBERS_TOOL=Object.freeze({
 name:'report_numbers',
 description:'从员工的报数消息中提取销售成交额或目标。只提取消息里明确出现的数字；无法确定期间或金额时返回空 items。提取结果不会直接入账，需员工确认。',
 input_schema:{type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['kind','start','end','amount_yuan'],properties:{
  kind:{type:'string',enum:['sales','target'],description:'sales=销售成交额，target=目标'},
  start:{type:'string',description:'统计期间开始日期 YYYY-MM-DD'},end:{type:'string',description:'统计期间结束日期 YYYY-MM-DD'},
  amount_yuan:{type:'string',description:'金额（元），阿拉伯数字，最多两位小数，例如 3500 或 3500.5'},
  increment:{type:'boolean',description:'仅当员工明确说“新增一笔”时为 true'}}}}}},
});

/** Cheap gate: only text that talks about sales/targets is sent to the model for extraction. */
export function looksLikeReport(text:string):boolean{
 return typeof text==='string'&&text.length<=500&&/报数|销售|成交|业绩|营业额|流水|目标|卖了|卖出/.test(text);
}
const AMOUNT=/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
/** Renders model-extracted fields as canonical report text. */
export function renderExtractedReport(items:readonly ExtractedReportItem[]):string|undefined{
 if(!Array.isArray(items)||!items.length||items.length>10)return undefined;
 const lines:string[]=[];
 for(const item of items){
  if(!item||(item.kind!=='sales'&&item.kind!=='target')||!validDate(item.start)||!validDate(item.end)||item.start>item.end||typeof item.amountYuan!=='string'||!AMOUNT.test(item.amountYuan))return undefined;
  if(item.increment&&item.kind!=='sales')return undefined;
  lines.push(`${item.start}至${item.end}${item.kind==='target'?'目标':item.increment?'新增成交':'销售成交'}${item.amountYuan}元`);
 }
 return lines.join('；');
}
/**
 * Model output passes the same parseStaffReport validation as the fast path: the canonical text must
 * parse completely and reproduce exactly the extracted fields. Otherwise it is rejected.
 */
export function validateExtractedReport(items:readonly ExtractedReportItem[],date:string):string|undefined{
 const text=renderExtractedReport(items);if(!text)return undefined;
 let parsed;try{parsed=parseStaffReport(text,date);}catch{return undefined;}
 if(parsed.missing.length||parsed.items.length!==items.length)return undefined;
 const same=parsed.items.every((p,i)=>{const x=items[i]!;const [y,f='']=x.amountYuan.split('.');return p.kind===x.kind&&p.start===x.start&&p.end===x.end&&p.amountCents===Number(y)*100+Number(f.padEnd(2,'0'))&&p.mode===(x.increment?'increment':'snapshot');});
 return same?text:undefined;
}
/** Reads the `report_numbers` tool call out of an Anthropic Messages response body. */
export function readReportToolCall(body:unknown):ExtractedReportItem[]|undefined{
 const content=(body as {content?:unknown})?.content;if(!Array.isArray(content))return undefined;
 const call=content.find(c=>c&&typeof c==='object'&&(c as {type?:unknown}).type==='tool_use'&&(c as {name?:unknown}).name==='report_numbers') as {input?:{items?:unknown}}|undefined;
 const items=call?.input?.items;if(!Array.isArray(items)||!items.length||items.length>10)return undefined;
 return items.map(raw=>{const r=(raw??{}) as Record<string,unknown>;return {kind:r.kind as 'sales',start:String(r.start??''),end:String(r.end??''),amountYuan:String(r.amount_yuan??''),...(r.increment===true?{increment:true}:{})};});
}
export interface ModelReportExtractorOptions {baseUrl:string;model:string;readApiKey():string;fetch?:typeof fetch;timeoutMs?:number;}
/** Model-backed extractor using tool calling (tool_choice forces `report_numbers`). The key is never logged. */
export function createModelReportExtractor(options:ModelReportExtractorOptions):BotReportExtractor{
 const base=String(options.baseUrl??'').replace(/\/+$/,''),timeout=options.timeoutMs??8000,doFetch=options.fetch??fetch;
 if(!/^https:\/\//.test(base)||typeof options.model!=='string'||!options.model||typeof options.readApiKey!=='function'||!Number.isInteger(timeout)||timeout<1||timeout>20000)throw Error('invalid_report_extractor');
 return async({text,date,signal})=>{
  try{
   if(!validDate(date)||!looksLikeReport(text))return undefined;
   const key=options.readApiKey();if(typeof key!=='string'||!key.trim())return undefined;
   const response=await doFetch(base+'/v1/messages',{method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)]),
    headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:options.model,max_tokens:512,temperature:0,tools:[REPORT_NUMBERS_TOOL],tool_choice:{type:'tool',name:'report_numbers'},
     system:'你是门店报数助手。调用 report_numbers 提取员工消息中的销售成交额或目标。今天/昨天/本月等期间按给定日期换算为 YYYY-MM-DD；中文数字换算为阿拉伯数字；“万”换算为元。没写期间时默认今天（start 和 end 都是今天）；没写类型时默认 sales；同一天的多个品项或多笔金额合计为一条 sales；只有明确说目标时才用 target。不要猜测缺失的金额，消息里没有金额时返回空 items。',
     messages:[{role:'user',content:`今天日期：${date}（Asia/Shanghai）\n员工消息：\n${text}`}]})});
   if(!response.ok)return undefined;
   return readReportToolCall(await response.json());
  }catch{return undefined;}
 };
}
