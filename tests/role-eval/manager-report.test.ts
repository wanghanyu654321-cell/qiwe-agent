import {describe,it,expect} from 'vitest';
import {reportPeriod,yuanToCents,parseStaffReport} from '../../src/role-eval/manager-report.js';
describe('employee sales report semantics',()=>{
 it.each([
  ['2026-10-15','half','2026-10-01','2026-10-15'],
  ['2026-10-16','half','2026-10-16','2026-10-31'],
  ['2028-02-29','half','2028-02-16','2028-02-29'],
  ['2026-05-17','four','2026-05-01','2026-08-31'],
  ['2026-10-14','month','2026-10-01','2026-10-31'],
  ['2026-10-14','year','2026-01-01','2026-12-31'],
 ])('uses the approved calendar %s %s',(date,kind,start,end)=>expect(reportPeriod(date,kind)).toEqual({start,end}));
 it('rejects impossible dates instead of moving the report into another month',()=>expect(()=>reportPeriod('2026-02-30','half')).toThrow());
 it('converts yuan and wan exactly, rejects non money and excessive precision',()=>{
  expect(yuanToCents('1.23万')).toBe(1230000);expect(yuanToCents('3,200.15元')).toBe(320015);expect(yuanToCents('0元')).toBe(0);
  for(const s of ['-1元','1.001元','NaN','999999999999999999万'])expect(()=>yuanToCents(s)).toThrow();
 });
 it('splits half-month target and today sales without using a model or treating the target as sales',()=>{
  expect(parseStaffReport('本月上半月目标5万，今天销售成交3200元','2026-10-14')).toMatchObject({items:[
   {kind:'target',start:'2026-10-01',end:'2026-10-15',amountCents:5000000},
   {kind:'sales',start:'2026-10-14',end:'2026-10-14',amountCents:320000,mode:'snapshot'},
  ],missing:[]});
 });
 it('retains cumulative semantics and asks for unclear dates or metric rather than counting blindly',()=>{
  expect(parseStaffReport('本月上半月累计销售成交2万元','2026-10-14')).toMatchObject({items:[{kind:'sales',mode:'snapshot',amountCents:2000000}],missing:[]});
  expect(parseStaffReport('今天收款3000，退款100','2026-10-14')).toMatchObject({items:[],missing:expect.arrayContaining(['销售成交金额'])});
  expect(parseStaffReport('完成了3000','2026-10-14')).toMatchObject({missing:expect.arrayContaining(['统计期间','销售成交金额'])});
 });
 it.each(['今天销售成交3千元','今天销售成交3200美元','今天销售成交3万元整美元'])('does not silently extract a numeric prefix from an unsupported unit: %s',text=>{
  expect(parseStaffReport(text,'2026-10-14')).toMatchObject({items:[],missing:expect.arrayContaining(['有效金额或单位'])});
 });
 it('flags two metrics in one undelimited phrase rather than silently dropping sales',()=>{
  expect(parseStaffReport('本月上半月目标5000元成交3000元','2026-10-14').missing).toContain('多个指标需要分别核对');
 });
});
