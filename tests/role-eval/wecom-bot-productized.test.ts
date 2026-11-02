import {describe,expect,it} from 'vitest';
import {isShortConfirm,looksLikeReportAttempt,parseSummaryIntent,REPORT_GUIDE,CONVERSATION_UNAVAILABLE} from '../../src/role-eval/wecom-bot-intents.js';
import {sanitizeReply} from '../../src/role-eval/wecom-bot-reply-format.js';
import {conversationResultPages,pickAutoRole} from '../../src/role-eval/wecom-bot-conversations.js';

const hex=(c:string)=>c.repeat(64);
const result=(content:string)=>({receiptId:hex('a'),revision:1,queryId:'q',turnId:'t',sourceOutputIds:[],digest:hex('b'),content});

describe('productized replies',()=>{
 it('delivers plain answers without receipt ids, versions or page commands',()=>{
  const [page]=conversationResultPages(result('你好，**今天**可以预约。'),false,true);
  expect(page).toBe('你好，今天可以预约。');
  expect(page).not.toMatch(/[a-f0-9]{64}|版本|查询对话|对话答案/);
 });
 it('keeps the legacy query view unchanged',()=>{
  expect(conversationResultPages(result('x'))[0]).toContain('查询对话 '+hex('a'));
 });
 it('only numbers pages when an answer spans several pages',()=>{
  const pages=conversationResultPages(result('字'.repeat(6000)),false,true);
  expect(pages.length).toBe(2);expect(pages[0]).toMatch(/（1\/2）$/);
 });
 it('turns tables into short lines and hides internal names',()=>{
  const text=sanitizeReply('## 价格\n| 项目 | 价格 |\n|---|---|\n| 水光 | 1980 |\nMiniclaw 已处理');
  expect(text).toBe('价格\n项目：价格\n水光：1980\nFront Claw 已处理');
  expect(text).not.toMatch(/\||#|Miniclaw/);
 });
 it('fixed texts carry no internal terms',()=>{
  for(const t of [REPORT_GUIDE,CONVERSATION_UNAVAILABLE])expect(t).not.toMatch(/Miniclaw|岗位空间|版本|[a-f0-9]{16}/);
 });
});
describe('default role',()=>{
 const granted=['reception','frontdesk','marketing','ads','manager','qa','training'] as const;
 it('falls back to reception for unclear text',()=>{expect(pickAutoRole(granted,'你好')).toEqual({role:'reception',multiple:true});});
 it('still follows clear keywords',()=>{expect(pickAutoRole(granted,'帮我写个小红书文案')?.role).toBe('marketing');});
 it('never picks manager',()=>{expect(pickAutoRole(['manager'],'你好')).toBeUndefined();});
});
describe('report and summary intents',()=>{
 it('maps natural summary requests to a month summary',()=>{
  expect(parseSummaryIntent('给我汇总一下本月业绩','2026-11-01')).toEqual({kind:'summary',date:'2026-11-01',period:'month'});
  expect(parseSummaryIntent('今年营业额统计','2026-11-01')?.period).toBe('year');
 });
 it('does not treat reports or advice requests as summaries',()=>{
  expect(parseSummaryIntent('今天销售3500','2026-11-01')).toBeUndefined();
  expect(parseSummaryIntent('业绩怎么提升，给个方案','2026-11-01')).toBeUndefined();
 });
 it('accepts short confirmations only',()=>{
  for(const t of ['对','是的','好','嗯','确认','好的。'])expect(isShortConfirm(t)).toBe(true);
  for(const t of ['对，但是改一下','不是','好的我再想想'])expect(isShortConfirm(t)).toBe(false);
 });
 it('guides report-like statements but not questions',()=>{
  expect(looksLikeReportAttempt('水光卖了两单')).toBe(true);
  expect(looksLikeReportAttempt('这个月业绩目标怎么定？')).toBe(false);
 });
});
