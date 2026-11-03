import { resolveDayOnly, resolveMonthDay } from './metrics.js';

export interface ParsedEntry {
  customer: string | null;
  amount: number;
  employeeName: string;
  note: string;
}

export interface ParsedReport {
  businessDay: string;
  storeName: string | null;
  entries: ParsedEntry[];
}

export type ParseResult =
  | { status: 'complete'; report: ParsedReport }
  | { status: 'incomplete' }
  | { status: 'none' };

const AMOUNT = String.raw`(\d+(?:\s*[+＋]\s*\d+)*)`;
const EMPLOYEE = String.raw`[（(]\s*([^（）()]+?)\s*[）)]`;
const COLON = /^(.+?)[：:]\s*/;
const BARE = new RegExp(String.raw`^${AMOUNT}\s*${EMPLOYEE}\s*(.*)$`);
const SPACE = new RegExp(String.raw`^(.+?)\s+${AMOUNT}\s*${EMPLOYEE}\s*(.*)$`);

function blankStore(value: string | undefined): string | null {
  const name = value?.trim() ?? '';
  return name ? name : null;
}

export function parseHeader(line: string, businessDay: string): { businessDay: string; storeName: string | null } | null {
  const text = line.trim();
  const monthForm = /^(\d{1,2})月(\d{1,2})日?\s*(.*)$/.exec(text);
  if (monthForm) {
    const resolved = resolveMonthDay(Number(monthForm[1]), Number(monthForm[2]), businessDay);
    if (!resolved) return null;
    return { businessDay: resolved, storeName: blankStore(monthForm[3]) };
  }
  const dotted = /^(\d{1,2})[./](\d{1,2})\s*(.*)$/.exec(text);
  if (dotted) {
    const resolved = resolveMonthDay(Number(dotted[1]), Number(dotted[2]), businessDay);
    if (!resolved) return null;
    return { businessDay: resolved, storeName: blankStore(dotted[3]) };
  }
  const dayForm = /^(\d{1,2})号\s*(.*)$/.exec(text);
  if (dayForm) {
    const resolved = resolveDayOnly(Number(dayForm[1]), businessDay);
    if (!resolved) return null;
    return { businessDay: resolved, storeName: blankStore(dayForm[2]) };
  }
  return null;
}

function amountsOf(raw: string): number[] | null {
  const parts = raw.split(/[+＋]/).map(part => part.trim());
  if (!parts.length || parts.some(part => !/^\d+$/.test(part))) return null;
  const amounts = parts.map(part => Number(part));
  if (amounts.some(amount => !Number.isSafeInteger(amount) || amount <= 0)) return null;
  return amounts;
}

function expand(customer: string | null, amountText: string, employeeName: string, note: string): ParsedEntry[] | null {
  const name = employeeName.trim();
  const who = customer?.trim() ?? '';
  if (!name || name.includes('：') || name.includes(':')) return null;
  if (customer !== null && !who) return null;
  const amounts = amountsOf(amountText);
  if (!amounts) return null;
  const kept = note.trim();
  return amounts.map(amount => ({ customer: customer === null ? null : who, amount, employeeName: name, note: kept }));
}

export function parseEntryLine(line: string): ParsedEntry[] | null {
  const text = line.trim();
  if (!text) return null;
  if (/[：:]/.test(text)) {
    const colon = COLON.exec(text);
    if (!colon) return null;
    const rest = text.slice(colon[0].length);
    const body = new RegExp(String.raw`^${AMOUNT}\s*${EMPLOYEE}\s*(.*)$`).exec(rest);
    if (!body || body[1] === undefined || body[2] === undefined || body[3] === undefined) return null;
    return expand(colon[1] ?? '', body[1], body[2], body[3]);
  }
  if (/^\d/.test(text)) {
    const bare = BARE.exec(text);
    if (!bare || bare[1] === undefined || bare[2] === undefined || bare[3] === undefined) return null;
    return expand(null, bare[1], bare[2], bare[3]);
  }
  const spaced = SPACE.exec(text);
  if (!spaced || spaced[1] === undefined || spaced[2] === undefined || spaced[3] === undefined || spaced[4] === undefined) return null;
  return expand(spaced[1], spaced[2], spaced[3], spaced[4]);
}

export function parseReportText(text: string, businessDay: string): ParseResult {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  const first = lines[0];
  if (!first) return { status: 'none' };
  const header = parseHeader(first, businessDay);
  if (!header) return { status: 'none' };
  if (lines.length < 2) return { status: 'incomplete' };
  const entries: ParsedEntry[] = [];
  for (const line of lines.slice(1)) {
    const parsed = parseEntryLine(line);
    if (!parsed) return { status: 'incomplete' };
    entries.push(...parsed);
  }
  if (!entries.length) return { status: 'incomplete' };
  return { status: 'complete', report: { businessDay: header.businessDay, storeName: header.storeName, entries } };
}

export interface ReportFields {
  businessDay: string;
  storeName: string | null;
  entries: ParsedEntry[];
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Same field rules the fast path uses. Invalid or extra fields are rejected, never filled in. */
export function validateReportFields(value: unknown): { ok: true; report: ReportFields } | { ok: false } {
  const body = record(value);
  if (!body) return { ok: false };
  const keys = Object.keys(body);
  if (keys.some(key => !['businessDay', 'storeName', 'entries'].includes(key))) return { ok: false };
  if (typeof body.businessDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDay)) return { ok: false };
  if (!(body.storeName === null || (typeof body.storeName === 'string' && body.storeName.trim().length > 0))) return { ok: false };
  if (!Array.isArray(body.entries) || body.entries.length === 0) return { ok: false };
  const entries: ParsedEntry[] = [];
  for (const item of body.entries) {
    const row = record(item);
    if (!row) return { ok: false };
    if (Object.keys(row).some(key => !['customer', 'amount', 'employeeName', 'note'].includes(key))) return { ok: false };
    if (!('customer' in row) || !('amount' in row) || !('employeeName' in row)) return { ok: false };
    const customer = row.customer;
    const employeeName = row.employeeName;
    const note = 'note' in row ? row.note : '';
    if (!(customer === null || (typeof customer === 'string' && customer.trim().length > 0))) return { ok: false };
    if (typeof employeeName !== 'string' || !employeeName.trim()) return { ok: false };
    if (typeof row.amount !== 'number' || !Number.isSafeInteger(row.amount) || row.amount <= 0) return { ok: false };
    if (typeof note !== 'string') return { ok: false };
    entries.push({
      customer: customer === null ? null : customer.trim(),
      amount: row.amount,
      employeeName: employeeName.trim(),
      note: note.trim(),
    });
  }
  return { ok: true, report: { businessDay: body.businessDay, storeName: body.storeName === null ? null : body.storeName.trim(), entries } };
}
