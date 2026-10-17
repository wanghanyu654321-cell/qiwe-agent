import {it,expect} from 'vitest';
import {parseManagerCommand} from '../../src/role-eval/manager-commands.js';
const id='a'.repeat(64);
it('uses the original cents parser and explicit original report/line for correction',()=>{expect(parseManagerCommand(`更正 ${id} 2 1.23万元`)).toEqual({kind:'correction',reportId:id,entryIndex:1,amountCents:1230000});});
it.each([['半月','half'],['本月','month'],['四个月','four'],['全年','year']])('selects the existing %s reporting period', (label,period)=>{expect(parseManagerCommand('经营汇总 2026-10-18 '+label)).toEqual({kind:'summary',date:'2026-10-18',period});});
it.each([['查询汇总','snapshot'],['导出Excel','export'],['导出 Excel','export'],['查询文件','file']])('uses an explicit snapshot ID for %s',(label,kind)=>{expect(parseManagerCommand(label+' '+id)).toEqual({kind,snapshotId:id});});
it.each([`更正 ${id} 0 1元`,`更正 ${id} 11 1元`,`更正 ${id} 1 -1元`,'经营汇总 2026-02-30 本月','导出Excel ../../secret'])('rejects invalid management commands without turning them into reports %s',text=>{expect(parseManagerCommand(text)?.kind).toBe('invalid');});
it('leaves ordinary reports and original report queries to the existing handler',()=>{expect(parseManagerCommand('今天销售成交1元')).toBeUndefined();expect(parseManagerCommand('查询 '+id)).toBeUndefined();});
