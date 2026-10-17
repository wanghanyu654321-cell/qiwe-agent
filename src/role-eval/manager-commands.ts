import {validDate,yuanToCents,type PeriodKind} from './manager-report.js';
export type ManagerCommand={kind:'correction';reportId:string;entryIndex:number;amountCents:number}|{kind:'summary';date:string;period:PeriodKind}|{kind:'snapshot'|'export'|'file';snapshotId:string}|{kind:'invalid';message:string};
export function parseManagerCommand(text:string):ManagerCommand|undefined{
 const value=text.trim(),correction=/^更正\s+([a-f0-9]{64})\s+(10|[1-9])\s+(\d[\d,.]*(?:万)?(?:元)?)$/.exec(value);
 if(correction){try{return {kind:'correction',reportId:correction[1]!,entryIndex:Number(correction[2])-1,amountCents:yuanToCents(correction[3]!) };}catch{/* Return the command's actionable usage below. */}}
 const periods:Record<string,PeriodKind>={'半月':'half','本月':'month','四个月':'four','全年':'year'},summary=/^经营汇总\s+(\d{4}-\d{2}-\d{2})\s+(半月|本月|四个月|全年)$/.exec(value);
 if(summary&&validDate(summary[1]!))return {kind:'summary',date:summary[1]!,period:periods[summary[2]!]!};
 const artifact=/^(查询汇总|导出\s*Excel|查询文件)\s+([a-f0-9]{64})$/i.exec(value);
 if(artifact)return {kind:artifact[1]==='查询汇总'?'snapshot':artifact[1]==='查询文件'?'file':'export',snapshotId:artifact[2]!};
 if(/^(更正|经营汇总|查询汇总|导出\s*Excel|查询文件)/i.test(value))return {kind:'invalid',message:'请使用：更正 报告编号 明细序号 新金额元；经营汇总 YYYY-MM-DD 半月/本月/四个月/全年；查询汇总/导出Excel/查询文件 快照编号。'};
 return undefined;
}
