import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MemoryPerformanceStore, type LedgerEntry, type PerformanceStore, type Person } from '../../src/role-eval/performance-store.js';
import { PERFORMANCE_MIGRATION_SQL } from '../../src/role-eval/performance-migration.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import { MemorySql } from './sql-fixture.js';

const person = (tier: Person['tier'] = 'employee'): Person => ({
  personId: 'person-zhou', accountId: 'acct-zhou', memberId: 'member-zhou', displayName: '小周',
  storeId: 'store-ming', storeName: '明川店', tier, roles: ['reception'], active: true,
});

const entry = (amount: number, id = 'entry-1'): LedgerEntry => ({
  entryId: id, storeId: 'store-ming', businessDay: '2026-10-27', customerName: '李秋', amount,
  amountType: '业绩', ownerPersonId: 'person-zhou', ownerName: '小周', reporterPersonId: 'person-zhou',
  note: '', status: 'recorded', disputed: false, createdAt: '2026-10-27T02:00:00.000Z',
});

async function contract(store: PerformanceStore): Promise<void> {
  await store.savePerson(person());
  const copy = await store.getPersonByAccount('acct-zhou');
  expect(copy?.displayName).toBe('小周');
  copy!.tier = 'owner';
  expect((await store.getPersonByAccount('acct-zhou'))?.tier).toBe('employee');
  await store.saveAlias({ storeId: 'store-ming', alias: '周周', personId: 'person-zhou' });
  await expect(store.saveAlias({ storeId: 'store-tian', alias: '周周', personId: 'person-zhou' })).rejects.toThrow('alias_person');
  await store.insertEntries([entry(98), entry(98, 'entry-2')]);
  expect(await store.listEntries({ reporterPersonId: 'person-zhou', businessDay: '2026-10-27', status: 'recorded' })).toHaveLength(2);
  await store.reviseEntry('entry-1', { amount: 100 }, { revisionId: 'rev-1', editorPersonId: 'person-zhou', reason: 'correction', createdAt: '2026-10-27T03:00:00.000Z' });
  await store.reviseEntry('entry-1', { amount: 110 }, { revisionId: 'rev-2', editorPersonId: 'person-zhou', reason: 'correction', createdAt: '2026-10-27T04:00:00.000Z' });
  const revisions = await store.listRevisions('entry-1');
  expect(revisions).toHaveLength(2);
  expect(JSON.parse(revisions[0]!.beforeJson).amount).toBe(98);
  expect(JSON.parse(revisions[1]!.beforeJson).amount).toBe(100);
  expect((await store.getEntry('entry-1'))?.amount).toBe(110);
  await store.saveTarget({ storeId: 'store-ming', personId: 'person-zhou', periodMonth: '2026-10', amount: 30000, updatedBy: 'person-boss', updatedAt: '2026-10-01T00:00:00.000Z' });
  await store.saveTarget({ storeId: 'store-ming', personId: 'person-zhou', periodMonth: '2026-10', amount: 0, updatedBy: 'person-boss', updatedAt: '2026-10-02T00:00:00.000Z' });
  expect((await store.getTarget('store-ming', 'person-zhou', '2026-10'))?.amount).toBe(0);
  await store.setConfig('qixun_start', '');
  expect(await store.getConfig('qixun_start')).toBe('');
  await store.setConfig('qixun_start', '2026-08-01');
  expect(await store.getConfig('qixun_start')).toBe('2026-08-01');
  await store.saveDraft({
    draftId: 'draft-1', reporterPersonId: 'person-zhou', storeId: 'store-ming', businessDay: '2026-10-27',
    expiresAt: '2026-10-27T15:00:00.000Z', kind: 'report', payload: { type: 'report', added: [], missing: [], skipped: 0 },
    status: 'pending', reminder: 'none', voidNotice: 'none', createdAt: '2026-10-27T02:00:00.000Z', closedAt: null,
  });
  expect((await store.getOpenDraft('person-zhou'))?.draftId).toBe('draft-1');
}

it('keeps report history in memory and behind the Postgres store', async () => {
  await contract(new MemoryPerformanceStore());
  const sql = new MemorySql();
  await migratePerformance(sql);
  await contract(createPostgresPerformanceStore(sql));
});

it('ships the Postgres migration without a connection string', () => {
  const file = readFileSync(new URL('../../migrations/001_performance.sql', import.meta.url), 'utf8').trim();
  expect(file).toBe(PERFORMANCE_MIGRATION_SQL);
  const source = readFileSync(new URL('../../src/role-eval/performance-postgres.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/DATABASE_URL|from 'pg'|sqlite/);
  const memory = readFileSync(new URL('../../src/role-eval/performance-store.ts', import.meta.url), 'utf8');
  expect(memory).not.toMatch(/sqlite/);
});
