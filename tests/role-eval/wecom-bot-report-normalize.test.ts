import {describe,expect,it,vi} from 'vitest';
import {tryParseReport,normalizeReportText,auditUnrecognizedReport,isCompleteReport} from '../../src/role-eval/wecom-bot-report-tools.js';
import {parseSummaryIntent} from '../../src/role-eval/wecom-bot-intents.js';
const D='2026-11-02';
describe('colloquial report forms',()=>{
 it.each(['今天销售4500','今天销售4,500元','销售4500','今日销售4500元','今天卖了4500','今天营业额4500','今天业绩4500块','今天流水４５００元','今天销售4500元整','今天销售4.5k'])('parses %s as 4500 yuan',text=>{
  const r=tryParseReport(text,D);expect(r&&isCompleteReport(r)).toBe(true);expect(JSON.stringify(r)).toMatch(/4500/);
 });
 it('leaves unrelated text alone',()=>{expect(normalizeReportText('你好')).toBe('你好');expect(tryParseReport('你好',D)&&isCompleteReport(tryParseReport('你好',D)!)).toBeFalsy();});
 it('audits unrecognized text without digits or emails',()=>{
  const spy=vi.spyOn(console,'info').mockImplementation(()=>{});auditUnrecognizedReport('卖了好多 13800138000 a@b.com');
  const line=String(spy.mock.calls[0]?.[0]);spy.mockRestore();expect(line).toContain('report_unrecognized');expect(line).not.toMatch(/138|a@b/);
 });
});
describe('summary intents',()=>{
 it.each(['给我汇总一下本月数据','本月数据','本月业绩','业绩'])('%s is a summary',t=>expect(parseSummaryIntent(t,D)).toBeTruthy());
 it('a bare 报数 is not a summary',()=>expect(parseSummaryIntent('报数',D)).toBeFalsy());
});
