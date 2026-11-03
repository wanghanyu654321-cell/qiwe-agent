import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyDirectoryMigration, createMemoryBindingStore, createPostgresBindingStore, readSqliteDirectory } from '../../src/role-eval/directory-store.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import { matchPerson } from '../../src/role-eval/people-match.js';
import { nativeIntegrationStatus, bootFrontClaw } from '../../src/role-eval/front-claw-boot.js';
import { MemorySql } from './sql-fixture.js';

function sqliteFile(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'front-claw-dir-')), 'base.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE wecom_bot_bindings (bot_id TEXT, corp_id TEXT, member_id TEXT, account_id TEXT, version INTEGER, active INTEGER);
    INSERT INTO wecom_bot_bindings VALUES ('bot','corp','member-zhou','acct-zhou',2,1);
    CREATE TABLE people_aliases (store_id TEXT, alias TEXT, person_id TEXT);
    INSERT INTO people_aliases VALUES ('store-ming','周周','person-zhou');
    CREATE TABLE bot_bindings (body TEXT);
    INSERT INTO bot_bindings VALUES ('{"botId":"bot","corpId":"corp","memberId":"member-mei","accountId":"acct-mei","version":1,"active":true}');`);
  db.close();
  return file;
}

it('copies bindings and aliases out of base SQLite once and falls back when Postgres is unset', async () => {
  const file = sqliteFile();
  const rows = readSqliteDirectory(file);
  expect(rows.bindings.map(row => row.memberId).sort()).toEqual(['member-mei', 'member-zhou']);
  expect(rows.aliases).toEqual([{ storeId: 'store-ming', alias: '周周', personId: 'person-zhou' }]);
  const store = new MemoryPerformanceStore();
  const bindings = createMemoryBindingStore();
  await store.savePerson({
    personId: 'person-zhou', accountId: 'acct-zhou', memberId: 'member-zhou', displayName: '小周',
    storeId: 'store-ming', storeName: '明川店', tier: 'employee', roles: ['reception'], active: true,
  });
  const first = await applyDirectoryMigration({ store, bindings }, rows);
  const second = await applyDirectoryMigration({ store, bindings }, rows);
  expect(first).toEqual({ bindings: 2, aliases: 1 });
  expect(second).toEqual({ bindings: 0, aliases: 0 });
  expect((await bindings.listBindings()).map(row => row.accountId).sort()).toEqual(['acct-mei', 'acct-zhou']);
  expect(matchPerson(await store.listPeople(), await store.listAliases('store-ming'), 'store-ming', '周周')?.personId).toBe('person-zhou');
  const sql = new MemorySql();
  await migratePerformance(sql);
  const pgStore = createPostgresPerformanceStore(sql);
  const pgBindings = createPostgresBindingStore(sql);
  expect(await applyDirectoryMigration({ store: pgStore, bindings: pgBindings }, rows)).toEqual({ bindings: 2, aliases: 1 });
  expect(await applyDirectoryMigration({ store: pgStore, bindings: pgBindings }, rows)).toEqual({ bindings: 0, aliases: 0 });
  expect(await pgStore.listAliases('store-ming')).toEqual([{ storeId: 'store-ming', alias: '周周', personId: 'person-zhou' }]);
  const booted = await bootFrontClaw({
    env: { FRONT_CLAW_SQLITE_PATH: file },
    now: () => new Date('2026-10-27T10:00:00+08:00'),
    send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: 'Front Claw 在。' }) },
    root: path.join(tmpdir(), 'no-native-overlay'),
  });
  expect(booted.driver).toBe('memory');
  expect(booted.native).toBe('absent');
  expect(booted.migrated).toEqual({ bindings: 2, aliases: 1 });
  expect(nativeIntegrationStatus(path.join(tmpdir(), 'missing-native-root'))).toBe('absent');
  await booted.close();
});
