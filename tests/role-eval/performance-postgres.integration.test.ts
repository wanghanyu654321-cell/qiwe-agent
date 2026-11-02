import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { WORKBENCH_ROLES, type WorkbenchRole } from '../../src/role-eval/workbench-access.js';
import type { PerformanceStore, Person } from '../../src/role-eval/performance-store.js';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore, type OpenedPerformanceStore } from '../../src/role-eval/performance-open.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';

const roles = [...WORKBENCH_ROLES] as WorkbenchRole[];
const bin = '/usr/lib/postgresql/16/bin';

function person(fields: Pick<Person, 'personId' | 'accountId' | 'memberId' | 'displayName' | 'tier'>): Person {
  return { ...fields, storeId: 'store-ming', storeName: '明川店', roles, active: true };
}

function listenPort(): Promise<number> {
  return import('node:net').then(({ createServer }) => new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  }));
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`${command} exited ${code}`)));
  });
}

async function startCluster(): Promise<{ url: string; stop(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'front-claw-pg-'));
  const port = await listenPort();
  await run(`${bin}/initdb`, ['-D', directory, '-U', 'frontclaw', '--auth=trust', '--no-sync', '--encoding=UTF8']);
  const child: ChildProcess = spawn(`${bin}/postgres`, [
    '-D', directory, '-p', String(port), '-h', '127.0.0.1', '-k', directory, '-c', 'listen_addresses=127.0.0.1',
  ], { stdio: 'ignore' });
  const url = `postgres://frontclaw@127.0.0.1:${port}/postgres`;
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 20_000) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.end();
      ready = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (!ready) {
    child.kill('SIGTERM');
    throw Error('postgres_not_ready');
  }
  return {
    url,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function bind(store: PerformanceStore, now: () => Date) {
  const sent: { toPersonId: string; text: string }[] = [];
  const handler = createWecomBotHandler({
    mode: 'isolated-synthetic',
    store,
    now,
    resolve: memberId => store.getPersonByMember(memberId),
    send: async message => { sent.push(message); return 'sent'; },
    model: { complete: async () => ({ type: 'chat', text: 'Front Claw 在。' }) },
  });
  return { handler, sent };
}

async function open(url: string): Promise<OpenedPerformanceStore> {
  return openPerformanceStore({ [FRONT_CLAW_DATABASE_URL]: url });
}

let cluster: { url: string; stop(): Promise<void> };

beforeAll(async () => {
  cluster = await startCluster();
  const client = new Client({ connectionString: cluster.url });
  await client.connect();
  await client.query('CREATE TABLE public.appointments (id integer PRIMARY KEY, note text NOT NULL)');
  await client.query(`INSERT INTO public.appointments VALUES (1, 'existing')`);
  await client.end();
}, 30_000);

afterAll(async () => {
  await cluster?.stop();
});

it('opens Postgres through Node ESM pg.default.Pool and openPerformanceStore', async () => {
  const source = readFileSync(new URL('../../src/role-eval/performance-open.ts', import.meta.url), 'utf8');
  expect(source).toContain("(await import('pg')).default");
  expect(source).not.toMatch(/const\s*\{\s*Pool\s*\}\s*=\s*await import\('pg'\)/);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const loaded = await import('pg');
    if (typeof loaded.Pool === 'function') process.exit(2);
    if (typeof loaded.default?.Pool !== 'function') process.exit(3);
    const pool = new loaded.default.Pool({ connectionString: process.env.FRONT_CLAW_TEST_URL });
    const client = await pool.connect();
    try { const row = await client.query('select 1 as ok'); if (row.rows[0].ok !== 1) process.exit(4); }
    finally { client.release(); await pool.end(); }
  `], { encoding: 'utf8', env: { ...process.env, FRONT_CLAW_TEST_URL: cluster.url } });
  expect(result.status, result.stderr).toBe(0);
  const opened = await open(cluster.url);
  expect(opened.driver).toBe('postgres');
  await opened.store.setConfig('pg_open_probe', '1');
  expect(await opened.store.getConfig('pg_open_probe')).toBe('1');
  await opened.close();
});

it('applies migration 007 twice and leaves existing public tables alone', async () => {
  const first = await open(cluster.url);
  const second = await open(cluster.url);
  expect(first.driver).toBe('postgres');
  expect(second.driver).toBe('postgres');
  const client = new Client({ connectionString: cluster.url });
  await client.connect();
  const kept = await client.query(`SELECT note FROM public.appointments WHERE id=1`);
  expect(kept.rows[0].note).toBe('existing');
  const leaked = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'performance_%'`);
  expect(leaked.rows).toEqual([]);
  const owned = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='front_claw_perf' ORDER BY table_name`);
  expect(owned.rows.map(row => row.table_name)).toEqual([
    'performance_aliases',
    'performance_appointments',
    'performance_config',
    'performance_drafts',
    'performance_entries',
    'performance_notifications',
    'performance_people',
    'performance_revisions',
    'performance_targets',
  ]);
  const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' ORDER BY column_name`);
  expect(columns.rows.map(row => row.column_name)).toEqual(['id', 'note']);
  await client.end();
  await first.close();
  await second.close();
});

it('keeps confirmed numbers, resend diffs, corrections, and targets after a new connection', async () => {
  const first = await open(cluster.url);
  let clock = new Date('2026-10-27T10:00:00+08:00');
  await first.store.savePerson(person({ personId: 'person-zhou', accountId: 'acct-zhou', memberId: 'member-zhou', displayName: '小周', tier: 'employee' }));
  await first.store.savePerson(person({ personId: 'person-mei', accountId: 'acct-mei', memberId: 'member-mei', displayName: '小美', tier: 'employee' }));
  await first.store.savePerson(person({ personId: 'person-mgr', accountId: 'acct-mgr', memberId: 'member-mgr', displayName: '周店长', tier: 'manager' }));
  const started = bind(first.store, () => clock);
  const sheet = `27号明川店
李欣：888（小美）
李秋：98（小周）
李秋：98（小周）`;
  await started.handler.handleMessage({ memberId: 'member-zhou', text: sheet });
  expect(await first.store.listEntries()).toEqual([]);
  await started.handler.handleMessage({ memberId: 'member-zhou', text: '对' });
  expect(await first.store.listEntries({ status: 'recorded' })).toHaveLength(3);
  await first.close();

  const second = await open(cluster.url);
  const resumed = bind(second.store, () => clock);
  const resent = await resumed.handler.handleMessage({ memberId: 'member-zhou', text: `27号明川店\n李秋：98（小周）\n赵芳：35（小美）` });
  expect(resent.replies.join('\n')).toContain('先不删');
  expect(resent.replies.join('\n')).toContain('赵芳 35 小美');
  await resumed.handler.handleMessage({ memberId: 'member-zhou', text: '全部确认' });
  expect(await second.store.listEntries({ status: 'recorded' })).toHaveLength(4);
  const corrected = await resumed.handler.handleMessage({ memberId: 'member-mei', text: '更正 1 900' });
  expect(corrected.replies.join('\n')).toContain('已改好');
  await resumed.handler.handleMessage({ memberId: 'member-mgr', text: '这个月小美目标 3 万' });
  await second.close();

  const third = await open(cluster.url);
  const entries = await third.store.listEntries({ ownerPersonId: 'person-mei', status: 'recorded' });
  const changed = entries.find(entry => entry.amount === 900);
  expect(changed).toBeTruthy();
  const history = await third.store.listRevisions(changed!.entryId);
  expect(JSON.parse(history[0]!.beforeJson).amount).toBe(888);
  expect(JSON.parse(history[0]!.afterJson).amount).toBe(900);
  expect((await third.store.getTarget('store-ming', 'person-mei', '2026-10'))?.amount).toBe(30000);
  expect(await third.store.listEntries({ status: 'recorded' })).toHaveLength(4);
  await third.close();
});

it('keeps an unconfirmed sheet across restart and fires reminder and void once', async () => {
  const prepared = await open(cluster.url);
  await prepared.store.savePerson(person({ personId: 'person-zhou', accountId: 'acct-zhou', memberId: 'member-zhou', displayName: '小周', tier: 'employee' }));
  await prepared.store.savePerson(person({ personId: 'person-mei', accountId: 'acct-mei', memberId: 'member-mei', displayName: '小美', tier: 'employee' }));
  const stale = await prepared.store.getOpenDraft('person-zhou');
  if (stale) {
    stale.status = 'void';
    stale.voidNotice = 'sent';
    await prepared.store.saveDraft(stale);
  }
  await prepared.close();
  const first = await open(cluster.url);
  let clock = new Date('2026-10-27T11:00:00+08:00');
  const session = bind(first.store, () => clock);
  await session.handler.handleMessage({ memberId: 'member-zhou', text: '27号明川店\n金梅：3500（小美）' });
  const pending = await first.store.getOpenDraft('person-zhou');
  expect(pending?.status).toBe('pending');
  expect(pending?.reminder).toBe('none');
  await first.close();

  clock = new Date('2026-10-27T11:31:00+08:00');
  const second = await open(cluster.url);
  const reminded = bind(second.store, () => clock);
  await reminded.handler.runMaintenance();
  expect(reminded.sent).toHaveLength(1);
  expect(reminded.sent[0]?.text).toContain('还没确认');
  expect((await second.store.getOpenDraft('person-zhou'))?.reminder).toBe('sent');
  await second.close();

  const third = await open(cluster.url);
  const quiet = bind(third.store, () => clock);
  await quiet.handler.runMaintenance();
  expect(quiet.sent).toHaveLength(0);
  const confirmed = await quiet.handler.handleMessage({ memberId: 'member-zhou', text: '对' });
  expect(confirmed.replies.join('\n')).toContain('已入账 1 笔');
  const booked = await third.store.listEntries({ reporterPersonId: 'person-zhou', businessDay: '2026-10-27', status: 'recorded' });
  expect(booked.some(entry => entry.customerName === '金梅' && entry.amount === 3500)).toBe(true);
  await third.close();

  const fourth = await open(cluster.url);
  clock = new Date('2026-10-28T18:00:00+08:00');
  const later = bind(fourth.store, () => clock);
  await later.handler.handleMessage({ memberId: 'member-zhou', text: '28号明川店\n林倩：100（小周）' });
  await fourth.close();
  clock = new Date('2026-10-28T23:00:00+08:00');
  const fifth = await open(cluster.url);
  const closing = bind(fifth.store, () => clock);
  await closing.handler.runMaintenance();
  expect(closing.sent.map(message => message.text).join('\n')).toContain('已作废');
  expect(closing.sent.map(message => message.text).join('\n')).not.toContain('还没确认。回复');
  const voided = (await fifth.store.listDrafts({ kind: 'report' })).find(draft => draft.businessDay === '2026-10-28');
  expect(voided?.status).toBe('void');
  expect(voided?.voidNotice).toBe('sent');
  expect(voided?.reminder).toBe('none');
  await fifth.close();
  const sixth = await open(cluster.url);
  const again = bind(sixth.store, () => clock);
  await again.handler.runMaintenance();
  expect(again.sent).toHaveLength(0);
  await sixth.close();
});
