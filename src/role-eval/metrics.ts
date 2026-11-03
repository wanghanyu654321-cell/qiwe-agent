/** Pure period math shared by every assistant tool. Read-time only. */

export const DEFAULT_BUSINESS_CUTOFF = '23:00';
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const QIXUN_CONFIG_KEY = 'qixun_start';
export const QIXUN_LENGTH_DAYS = 70;
export const REMINDER_DELAY_MS = 30 * 60 * 1000;

export type PaceTier = 'high' | 'medium' | 'low';

export interface PeriodScore {
  done: number;
  /** Full target of this period (month, 旬 allocation, or one day). */
  fullPeriodTarget: number;
  /** Whole-month target, shown for context. */
  fullMonthTarget: number;
  status: '未开始' | '进行中';
  /** fullPeriodTarget scaled by elapsed days / period length. */
  toDateTarget: number | null;
  /** 日/旬/月完成率: done / full period target. Not the achievement band. */
  completionRate: number | null;
  /** 进度达成率: done / to-date target. Achievement bands use this rate. */
  paceRate: number | null;
  /** To-date target minus done. Null when the period target is not positive. */
  gap: number | null;
  tier: PaceTier | null;
}

export function paceTier(rate: number): PaceTier {
  if (rate >= 0.9) return 'high';
  if (rate >= 0.7) return 'medium';
  return 'low';
}

export function scorePeriod(input: {
  done: number;
  fullPeriodTarget: number;
  fullMonthTarget: number;
  elapsedDays: number;
  periodDays: number;
}): PeriodScore {
  const base = {
    done: input.done,
    fullPeriodTarget: input.fullPeriodTarget,
    fullMonthTarget: input.fullMonthTarget,
  };
  if (!(input.fullPeriodTarget > 0)) {
    return { ...base, status: '未开始', toDateTarget: null, completionRate: null, paceRate: null, gap: null, tier: null };
  }
  if (input.elapsedDays <= 0 || input.periodDays <= 0) throw Error('invalid_period');
  const toDateTarget = input.fullPeriodTarget * input.elapsedDays / input.periodDays;
  const completionRate = input.done / input.fullPeriodTarget;
  const paceRate = toDateTarget === 0 ? 0 : input.done / toDateTarget;
  return {
    ...base,
    status: '进行中',
    toDateTarget,
    completionRate,
    paceRate,
    gap: toDateTarget - input.done,
    tier: paceTier(paceRate),
  };
}

/** Month-to-date against the full monthly target and against the elapsed-day proration. */
export function scoreMonth(done: number, monthTarget: number, businessDay: string): PeriodScore {
  const period = monthPeriod(businessDay);
  return scorePeriod({
    done,
    fullPeriodTarget: monthTarget,
    fullMonthTarget: monthTarget,
    elapsedDays: period.elapsedDays,
    periodDays: period.daysInMonth,
  });
}

/** 旬-to-date. The 旬 target is the month target scaled by 旬 length; pace then uses elapsed days inside the 旬. */
export function scoreXun(done: number, monthTarget: number, businessDay: string): PeriodScore {
  const month = monthPeriod(businessDay);
  const xun = xunPeriod(businessDay);
  const length = diffDays(xun.start, xun.end) + 1;
  const fullPeriodTarget = monthTarget > 0 ? monthTarget * length / month.daysInMonth : monthTarget;
  return scorePeriod({
    done,
    fullPeriodTarget,
    fullMonthTarget: monthTarget,
    elapsedDays: xun.elapsedDays,
    periodDays: length,
  });
}

/** One business day. Its full target is one day of the month, so both rates match. */
export function scoreDay(done: number, monthTarget: number, businessDay: string): PeriodScore {
  const month = monthPeriod(businessDay);
  const fullPeriodTarget = monthTarget > 0 ? monthTarget / month.daysInMonth : monthTarget;
  return scorePeriod({
    done,
    fullPeriodTarget,
    fullMonthTarget: monthTarget,
    elapsedDays: 1,
    periodDays: 1,
  });
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; }

export function zonedParts(now: Date, timeZone = DEFAULT_TIME_ZONE): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
  };
}

export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function splitIso(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw Error('invalid_date');
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function addDays(value: string, days: number): string {
  const { year, month, day } = splitIso(value);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

export function diffDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function monthKey(value: string): string {
  return value.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw Error('invalid_month');
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const next = index % 12;
  return `${String(year).padStart(4, '0')}-${String(next + 1).padStart(2, '0')}`;
}

/** Calendar date in the store zone, rolling to the next date once the cutoff is reached. */
export function businessDate(now: Date, cutoff = DEFAULT_BUSINESS_CUTOFF, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = zonedParts(now, timeZone);
  const date = isoDate(parts.year, parts.month, parts.day);
  const [hourText, minuteText] = cutoff.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw Error('invalid_cutoff');
  if (parts.hour * 60 + parts.minute >= hour * 60 + minute) return addDays(date, 1);
  return date;
}

/** Wall-clock instant of a store date at `time` in the given zone. */
export function zonedDateTime(date: string, time: string, timeZone = DEFAULT_TIME_ZONE): Date {
  const { year, month, day } = splitIso(date);
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const zoned = zonedParts(new Date(utc), timeZone);
    const shown = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0);
    const want = Date.UTC(year, month - 1, day, hour, minute, 0);
    const delta = want - shown;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

export interface DayPeriod { start: string; end: string; elapsedDays: number; daysInMonth: number; }
export interface XunPeriod { start: string; end: string; elapsedDays: number; daysInMonth: number; }

export function monthPeriod(businessDay: string): DayPeriod {
  const { year, month, day } = splitIso(businessDay);
  const total = daysInMonth(year, month);
  return { start: isoDate(year, month, 1), end: isoDate(year, month, total), elapsedDays: day, daysInMonth: total };
}

/** 旬 is 1–10, 11–20, and 21 through month end, computed from the business day. */
export function xunPeriod(businessDay: string): XunPeriod {
  const { year, month, day } = splitIso(businessDay);
  const total = daysInMonth(year, month);
  const startDay = day <= 10 ? 1 : day <= 20 ? 11 : 21;
  const endDay = day <= 10 ? 10 : day <= 20 ? 20 : total;
  return {
    start: isoDate(year, month, startDay),
    end: isoDate(year, month, endDay),
    elapsedDays: day - startDay + 1,
    daysInMonth: total,
  };
}

export interface QixunWindow { start: string; end: string; }

/**
 * Current 七旬 block of 70 days aligned to `start`.
 * Empty start, or a business day before the start, does not produce a window.
 */
export function qixunWindow(businessDay: string, start: string | null | undefined): QixunWindow | null {
  const trimmed = start?.trim() ?? '';
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  if (businessDay < trimmed) return null;
  const index = Math.floor(diffDays(trimmed, businessDay) / QIXUN_LENGTH_DAYS);
  const windowStart = addDays(trimmed, index * QIXUN_LENGTH_DAYS);
  return { start: windowStart, end: addDays(windowStart, QIXUN_LENGTH_DAYS - 1) };
}

/** Day-only headers use the business month, and an impossible day falls back one month. */
export function resolveDayOnly(day: number, businessDay: string): string | null {
  const { year, month } = splitIso(businessDay);
  if (isValidDate(year, month, day)) return isoDate(year, month, day);
  const previous = shiftMonth(monthKey(businessDay), -1);
  const [previousYear, previousMonth] = previous.split('-').map(Number);
  if (isValidDate(previousYear!, previousMonth!, day)) return isoDate(previousYear!, previousMonth!, day);
  return null;
}

/** Explicit month/day. December/January wrap uses the business month as the boundary. */
export function resolveMonthDay(month: number, day: number, businessDay: string): string | null {
  const { year, month: businessMonth } = splitIso(businessDay);
  let resolvedYear = year;
  if (businessMonth === 1 && month >= 11) resolvedYear = year - 1;
  else if (businessMonth === 12 && month <= 2) resolvedYear = year + 1;
  if (!isValidDate(resolvedYear, month, day)) return null;
  return isoDate(resolvedYear, month, day);
}
