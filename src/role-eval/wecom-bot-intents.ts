import type {ManagerCommand} from './manager-commands.js';
import {looksLikeReport} from './wecom-bot-report-model.js';

/** Fixed guidance when a message looks like a report but no valid fields could be extracted. */
export const REPORT_GUIDE='这条报数我没能识别。可以这样发：今天 销售 3500元。我核对后你回「对」就保存。';
/** Short reply when an auto-selected conversation cannot be routed right now. Never names internal terms. */
export const CONVERSATION_UNAVAILABLE='暂时无法处理这条消息，请稍后再试；如果一直这样，请联系店长。';
const SUMMARY_TOPIC=/数据|报数|业绩|营业额|销售额?|成交额?|流水|营收|达成/;
const SUMMARY_ASK=/^(?:本月|这个月|今天|本周|今年)?(?:的)?(?:数据|业绩)$|汇总|总结|统计|合计|总共|一共|多少|怎么样|情况|看看|看下|看一下|查一下|报表/;
/** Natural-language read-only summary request ("给我汇总一下本月业绩"). Text with amounts is never a summary. */
export function parseSummaryIntent(text:string,date:string):Extract<ManagerCommand,{kind:'summary'}>|undefined{
 if(typeof text!=='string'||!text||text.length>60||!SUMMARY_TOPIC.test(text)||!SUMMARY_ASK.test(text))return undefined;
 if(/\d{2,}/.test(text.replace(/\d{4}-\d{2}-\d{2}/g,'')))return undefined;
 if(/目标.*(定|设|制定)|怎么(提升|提高|做)|方案|建议|文案/.test(text))return undefined;
 const period=/全年|今年|本年/.test(text)?'year':/半月|半个月/.test(text)?'half':/四个月/.test(text)?'four':'month';
 return {kind:'summary',date,period};
}
/** Short confirmations accepted only while this member has an open pending report. */
export function isShortConfirm(text:string):boolean{
 return /^(?:对|对的|确认|确认保存|是|是的|好|好的|嗯|嗯嗯|没错|可以|ok)[。.!！~～]*$/i.test(text.trim());
}
/** A report-like statement with a number, not a question: gets fixed guidance instead of a model answer. */
export function looksLikeReportAttempt(text:string):boolean{
 return looksLikeReport(text)&&/\d|[一二两三四五六七八九十百千万]/.test(text)&&!/[?？]|怎么|如何|吗|多少|为什么|能不能/.test(text);
}
