import type { PaceTier, PeriodScore } from './metrics.js';
import { splitIso } from './metrics.js';

const TIER_LABEL: Record<PaceTier, string> = { high: '高', medium: '中', low: '低' };

export function formatAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function formatDay(iso: string): string {
  const { month, day } = splitIso(iso);
  return `${month}月${day}日`;
}

/** Drop leaked ids. Replies are built from names; this is the last gate. */
export function scrubReply(text: string, forbidden: readonly string[] = []): string {
  let out = text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b[0-9a-f]{16,}\b/gi, '');
  for (const token of forbidden) {
    if (token.length >= 6) out = out.split(token).join('');
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export function formatScore(label: string, completionLabel: string, score: PeriodScore): string {
  const done = formatAmount(score.done);
  if (score.status === '未开始') return `${label} 已做 ${done}，未开始`;
  const pace = formatAmount(score.toDateTarget ?? 0);
  const full = formatAmount(score.fullMonthTarget);
  const completion = Math.round((score.completionRate ?? 0) * 100);
  const pacePercent = Math.round((score.paceRate ?? 0) * 100);
  const tier = score.tier ? TIER_LABEL[score.tier] : '';
  const gap = formatAmount(score.gap ?? 0);
  return `${label} 已做 ${done}，至今 ${pace}（全月 ${full}），${completionLabel} ${completion}%，进度达成率 ${pacePercent}%，${tier}，差额 ${gap}`;
}

export function customerAmount(customer: string | null, amount: number, employeeName: string, note: string): string {
  const who = customer ? `${customer} ` : '';
  const extra = note ? `，备注${note}` : '';
  return `${who}${formatAmount(amount)} ${employeeName}${extra}`;
}
