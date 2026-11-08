import { expect, it } from 'vitest';
import {
  businessDate, paceTier, qixunWindow, scoreDay, scoreMonth, scorePeriod, scoreXun,
} from '../../src/role-eval/metrics.js';
import { formatAmount, formatScore } from '../../src/role-eval/reply.js';

it('bands follow 进度达成率 and keep 月完成率 separate', () => {
  expect(paceTier(0.9)).toBe('high');
  expect(paceTier(0.899)).toBe('medium');
  expect(paceTier(0.7)).toBe('medium');
  expect(paceTier(0.699)).toBe('low');
  const early = scorePeriod({ done: 45, fullPeriodTarget: 100, fullMonthTarget: 100, elapsedDays: 5, periodDays: 10 });
  expect(early.completionRate).toBeCloseTo(0.45);
  expect(early.paceRate).toBeCloseTo(0.9);
  expect(early.tier).toBe('high');
  expect(early.gap).toBeCloseTo(5);
  const idle = scorePeriod({ done: 80, fullPeriodTarget: 0, fullMonthTarget: 0, elapsedDays: 5, periodDays: 10 });
  expect(idle.status).toBe('未开始');
  expect(idle.completionRate).toBeNull();
  expect(idle.paceRate).toBeNull();
  expect(idle.gap).toBeNull();
  expect(idle.tier).toBeNull();
  expect(formatScore('本月', '月完成率', idle)).toBe('本月 已做 80，未开始');
  expect(formatScore('本月', '月完成率', idle)).not.toMatch(/差额|进度达成率|月完成率/);
});

it('prorates the month by elapsed days and the 旬 by elapsed days inside the 旬', () => {
  const day = '2026-10-15';
  const month = scoreMonth(15500, 31000, day);
  expect(month.completionRate).toBeCloseTo(0.5);
  expect(month.toDateTarget).toBeCloseTo(15000);
  expect(month.paceRate).toBeCloseTo(15500 / 15000);
  expect(month.tier).toBe('high');
  expect(month.fullMonthTarget).toBe(31000);
  const xun = scoreXun(5000, 31000, day);
  expect(xun.fullPeriodTarget).toBeCloseTo(10000);
  expect(xun.completionRate).toBeCloseTo(0.5);
  expect(xun.toDateTarget).toBeCloseTo(5000);
  expect(xun.paceRate).toBeCloseTo(1);
  expect(xun.tier).toBe('high');
  expect(scoreDay(1000, 31000, day).paceRate).toBeCloseTo(1);
  expect(scoreDay(1000, 31000, day).completionRate).toBeCloseTo(1);
  const text = formatScore('本月', '月完成率', month);
  expect(text).toContain('月完成率 50%');
  expect(text).toContain('进度达成率 103%');
  expect(text).toContain('全月 31000');
  expect(text).toContain('高');
  expect(text).toContain('差额 -500');
  expect(formatAmount(15000)).toBe('15000');
});

it('rolls the business day at the cutoff and leaves 七旬 empty without a start', () => {
  expect(businessDate(new Date('2026-10-27T22:59:00+08:00'))).toBe('2026-10-27');
  expect(businessDate(new Date('2026-10-27T23:00:00+08:00'))).toBe('2026-10-28');
  expect(businessDate(new Date('2026-10-31T23:30:00+08:00'))).toBe('2026-11-01');
  expect(qixunWindow('2026-10-15', '')).toBeNull();
  expect(qixunWindow('2026-10-15', null)).toBeNull();
  expect(qixunWindow('2026-10-15', '   ')).toBeNull();
  expect(qixunWindow('2026-10-15', '2026-10-20')).toBeNull();
  expect(qixunWindow('2026-10-15', '2026-10-10')).toEqual({ start: '2026-10-10', end: '2026-12-18' });
});
