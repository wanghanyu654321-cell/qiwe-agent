export type ExactTool = 'my_progress' | 'unreported' | 'stores_ranking' | 'get_summary' | 'snapshot';

const EXACT: Record<string, ExactTool> = {
  '我的进度': 'my_progress',
  '进度': 'my_progress',
  '谁还没报': 'unreported',
  '今天谁没报': 'unreported',
  '门店排名': 'stores_ranking',
  '各店排名': 'stores_ranking',
  '汇总': 'get_summary',
  '今日汇总': 'get_summary',
  '快照': 'snapshot',
  '今日快照': 'snapshot',
};

export function matchExactTool(text: string): ExactTool | null {
  return EXACT[text.trim()] ?? null;
}

export function isClosedCommand(text: string): boolean {
  return /^(?:导出|文件|export|file)(?:\s*(?:excel|表格|报表)?)?$/i.test(text.trim());
}

export function parseTargetUtterance(text: string): { name: string; amount: number; which: 'current' | 'next' } | null {
  const match = text.trim().match(/^(.*?)目标\s*(\d+(?:\.\d+)?)\s*(万|千)?$/);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const hasCurrent = /这个月|本月/.test(match[1]);
  const hasNext = match[1].includes('下个月');
  if (hasCurrent && hasNext) return null;
  const name = match[1].replace(/这个月|本月|下个月/g, '').replace(/\s+/g, '').trim();
  if (!name || /[，。！？、]/.test(name)) return null;
  const scaled = Number(match[2]) * (match[3] === '万' ? 10_000 : match[3] === '千' ? 1_000 : 1);
  if (!Number.isFinite(scaled) || scaled < 0 || Math.abs(scaled - Math.round(scaled)) > 1e-6) return null;
  return { name, amount: Math.round(scaled), which: hasNext ? 'next' : 'current' };
}

export function validateTargetFields(value: unknown): { ok: true; personName: string; amount: number; periodMonth: string | null } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['personName', 'amount', 'periodMonth'].includes(key))) return { ok: false };
  if (typeof body.personName !== 'string' || !body.personName.trim()) return { ok: false };
  if (typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount) || body.amount < 0) return { ok: false };
  if (body.periodMonth !== undefined && (typeof body.periodMonth !== 'string' || !/^\d{4}-\d{2}$/.test(body.periodMonth))) return { ok: false };
  return {
    ok: true,
    personName: body.personName.trim(),
    amount: body.amount,
    periodMonth: typeof body.periodMonth === 'string' ? body.periodMonth : null,
  };
}
