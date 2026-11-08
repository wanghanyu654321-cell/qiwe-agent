import { expect, it } from 'vitest';
import { parseReportText, validateReportFields } from '../../src/role-eval/report-parse.js';
import { CHATS, REPORTS } from './report-corpus.js';

it('parses the salon replay set and does not treat chat as a report', () => {
  expect(REPORTS.length).toBeGreaterThanOrEqual(50);
  expect(CHATS.length).toBeGreaterThanOrEqual(30);
  const failures = REPORTS.filter(item => {
    const parsed = parseReportText(item.text, item.businessDay);
    return parsed.status !== 'complete' || JSON.stringify(parsed.report) !== JSON.stringify(item.report);
  });
  const mistaken = CHATS.filter(text => parseReportText(text, '2026-10-27').status === 'complete');
  expect(mistaken).toEqual([]);
  expect(failures.map(item => item.text)).toEqual([]);
  expect((REPORTS.length - failures.length) / REPORTS.length).toBeGreaterThanOrEqual(0.95);
  expect(CHATS.every(text => parseReportText(text, '2026-10-27').status === 'none')).toBe(true);
});

it('rejects an incomplete sheet and a model field that is not a real amount', () => {
  expect(parseReportText('27号', '2026-10-27').status).toBe('incomplete');
  expect(parseReportText('27号明川店\n林倩来了', '2026-10-27').status).toBe('incomplete');
  expect(validateReportFields({
    businessDay: '2026-10-27',
    storeName: null,
    entries: [{ customer: '林倩', amount: '很多', employeeName: '小美', note: '' }],
  }).ok).toBe(false);
  expect(validateReportFields({
    businessDay: '2026-10-27',
    storeName: null,
    role: 'marketing',
    entries: [{ customer: '林倩', amount: 100, employeeName: '小美', note: '' }],
  }).ok).toBe(false);
  expect(validateReportFields({
    businessDay: '2026-10-27',
    storeName: null,
    entries: [{ customer: '林倩', amount: 100, note: '' }],
  }).ok).toBe(false);
});
