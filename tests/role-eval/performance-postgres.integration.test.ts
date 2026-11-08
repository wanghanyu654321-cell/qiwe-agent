import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { WORKBENCH_ROLES, type WorkbenchRole } from '../../src/role-eval/workbench-access.js';
import type { PerformanceStore, Person } from '../../src/role-eval/performance-store.js';
import { appointmentLineId, confirmEntryId } from '../../src/role-eval/performance-store.js';
import { createPostgresPerformanceStore, type SqlClient } from '../../src/role-eval/performance-postgres.js';
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

it('lets only one Postgres claim move a pending draft to confirming', async () => {
  const opened = await open(cluster.url);
  const draftId = 'draft-claim-once';
  await opened.store.saveDraft({
    draftId, reporterPersonId: 'person-claim', storeId: 'store-ming', businessDay: '2026-10-27',
    expiresAt: '2026-10-27T15:00:00.000Z', kind: 'report',
    payload: { type: 'report', added: [{ customer: '李欣', amount: 1, employeeName: '小周', employeeId: 'person-claim', note: '', amountType: '业绩' }], missing: [], skipped: 0 },
    status: 'pending', reminder: 'none', voidNotice: 'none', createdAt: '2026-10-27T02:00:00.000Z', closedAt: null,
  });
  const [first, second] = await Promise.all([opened.store.claimPendingDraft(draftId), opened.store.claimPendingDraft(draftId)]);
  expect([first, second].filter(row => row !== null)).toHaveLength(1);
  expect(await opened.store.claimPendingDraft(draftId)).toBeNull();
  expect((await opened.store.getDraft(draftId))?.status).toBe('confirming');
  await opened.close();
});

it('opens Postgres through Node ESM pg.default.Pool and openPerformanceStore', async () => {
  const source = readFileSync(new URL('../../src/role-eval/performance-open.ts', import.meta.url), 'utf8');
  expect(source).toContain('loadPgPool');
  expect(source).not.toMatch(/const\s*\{\s*Pool\s*\}\s*=\s*await import\('pg'\)/);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const loaded = await import('pg');
    const { createRequire } = await import('node:module');
    const required = createRequire(new URL('package.json', import.meta.url))('pg');
    const poolOf = value => value && typeof value.Pool === 'function' ? value.Pool : value && value.default ? poolOf(value.default) : undefined;
    if (typeof poolOf(loaded) !== 'function' || typeof poolOf(required) !== 'function') process.exit(3);
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
    'wecom_bot_bindings',
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

it('rolls back a confirming insert that fails before commit and retries it once on Postgres', async () => {
  const draftId = 'draft-rollback-once';
  const personId = 'person-rollback';
  const seeded = await open(cluster.url);
  await seeded.store.saveDraft({
    draftId, reporterPersonId: personId, storeId: 'store-ming', businessDay: '2026-10-27',
    expiresAt: '2026-10-27T15:00:00.000Z', kind: 'report',
    payload: { type: 'report', added: [
      { customer: '回滚甲', amount: 11, employeeName: '回滚', employeeId: personId, note: '', amountType: '业绩' },
      { customer: '回滚乙', amount: 12, employeeName: '回滚', employeeId: personId, note: '', amountType: '业绩' },
    ], missing: [], skipped: 0 },
    status: 'confirming', reminder: 'none', voidNotice: 'none', createdAt: '2026-10-27T02:00:00.000Z', closedAt: null,
  });
  await seeded.close();
  const client = new Client({ connectionString: cluster.url });
  await client.connect();
  let fail = true;
  const sql: SqlClient = {
    async query(text, params) {
      const result = await client.query(text, params ? [...params] : []);
      return { rows: result.rows };
    },
    async transaction(work) {
      await client.query('BEGIN');
      try {
        const result = await work(async (text, params) => {
          if (fail && text.includes('performance_entries')) { fail = false; throw Error('injected_before_commit'); }
          const result = await client.query(text, params ? [...params] : []);
          return { rows: result.rows };
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
  const store = createPostgresPerformanceStore(sql);
  const draft = await store.getDraft(draftId);
  const entries = [0, 1].map(index => ({
    entryId: confirmEntryId(draftId, index), storeId: 'store-ming', businessDay: '2026-10-27',
    customerName: index === 0 ? '回滚甲' : '回滚乙', amount: index === 0 ? 11 : 12, amountType: '业绩' as const,
    ownerPersonId: personId, ownerName: '回滚', reporterPersonId: personId, note: '', status: 'recorded' as const,
    disputed: false, createdAt: new Date(Date.parse('2026-10-27T02:00:00.000Z') + index).toISOString(),
  }));
  const next = { ...draft!, status: 'confirmed' as const, closedAt: '2026-10-27T03:00:00.000Z' };
  await expect(store.commitConfirmingDraft(next, entries)).rejects.toThrow('injected_before_commit');
  expect(await store.getDraft(draftId)).toMatchObject({ status: 'confirming' });
  expect(await store.listEntries({ reporterPersonId: personId })).toEqual([]);
  expect(await store.commitConfirmingDraft(next, entries)).toBe(2);
  expect(await store.commitConfirmingDraft(next, entries)).toBe(2);
  expect(await store.listEntries({ reporterPersonId: personId, status: 'recorded' })).toHaveLength(2);
  expect(await store.getDraft(draftId)).toMatchObject({ status: 'confirmed' });
  await client.end();
});

it('finishes one Postgres confirm after a restart and from two overlapping replies', async () => {
  const crash = await open(cluster.url);
  await crash.store.savePerson(person({ personId: 'person-crash', accountId: 'acct-crash', memberId: 'member-crash', displayName: '崩溃员', tier: 'employee' }));
  const crashed = bind(crash.store, () => new Date('2026-10-27T10:00:00+08:00'));
  await crashed.handler.handleMessage({ memberId: 'member-crash', text: '27号明川店\n金梅：40（崩溃员）' });
  const pending = await crash.store.getOpenDraft('person-crash');
  expect(await crash.store.claimPendingDraft(pending!.draftId)).toMatchObject({ status: 'confirming' });
  expect(await crash.store.listEntries({ reporterPersonId: 'person-crash' })).toEqual([]);
  await crash.close();
  const resumed = await open(cluster.url);
  const session = bind(resumed.store, () => new Date('2026-10-27T10:05:00+08:00'));
  await session.handler.runMaintenance();
  expect(await resumed.store.listEntries({ reporterPersonId: 'person-crash', status: 'recorded' })).toHaveLength(1);
  await session.handler.runMaintenance();
  expect(await resumed.store.listEntries({ reporterPersonId: 'person-crash', status: 'recorded' })).toHaveLength(1);
  const looked = await session.handler.handleMessage({ memberId: 'member-crash', text: '入账结果' });
  expect(looked.replies.join('\n')).toContain('已入账 1 笔');
  expect(looked.replies.join('\n')).not.toContain('没有入账');
  await resumed.close();

  const raced = await open(cluster.url);
  await raced.store.savePerson(person({ personId: 'person-race', accountId: 'acct-race', memberId: 'member-race', displayName: '并发员', tier: 'employee' }));
  const race = bind(raced.store, () => new Date('2026-10-27T11:00:00+08:00'));
  await race.handler.handleMessage({ memberId: 'member-race', text: '27号明川店\n周琪：70（并发员）\n周琪：80（并发员）' });
  await Promise.all([
    race.handler.handleMessage({ memberId: 'member-race', text: '对' }),
    race.handler.handleMessage({ memberId: 'member-race', text: '对' }),
  ]);
  expect(await raced.store.listEntries({ reporterPersonId: 'person-race', status: 'recorded' })).toHaveLength(2);
  const repeat = await race.handler.handleMessage({ memberId: 'member-race', text: '入账结果' });
  expect(repeat.replies.join('\n')).toContain('已入账 2 笔');
  expect(await raced.store.listEntries({ reporterPersonId: 'person-race', status: 'recorded' })).toHaveLength(2);
  await raced.close();
});

it('submits one appointment through a Postgres transaction, restart and two overlapping confirms', async () => {
  const draftId = 'draft-appointment-rollback';
  const personId = 'person-appointment-rollback';
  const seeded = await open(cluster.url);
  await seeded.store.saveDraft({
    draftId, reporterPersonId: personId, storeId: 'store-ming', businessDay: '2026-10-27',
    expiresAt: '2026-10-27T15:00:00.000Z', kind: 'appointment',
    payload: { type: 'appointment', items: [{ customer: '李欣', whenText: '15:00', note: '' }] },
    status: 'confirming', reminder: 'none', voidNotice: 'none', createdAt: '2026-10-27T02:00:00.000Z', closedAt: null,
  });
  await seeded.close();
  const client = new Client({ connectionString: cluster.url });
  await client.connect();
  let fail = true;
  const sql: SqlClient = {
    async query(text, params) {
      const result = await client.query(text, params ? [...params] : []);
      return { rows: result.rows };
    },
    async transaction(work) {
      await client.query('BEGIN');
      try {
        const result = await work(async (text, params) => {
          if (fail && text.includes('performance_appointments') && text.includes('INSERT')) { fail = false; throw Error('injected_before_commit'); }
          const result = await client.query(text, params ? [...params] : []);
          return { rows: result.rows };
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
  const store = createPostgresPerformanceStore(sql);
  const appointment = {
    appointmentId: appointmentLineId(draftId, 0), storeId: 'store-ming', employeePersonId: personId,
    customerName: '李欣', whenText: '15:00', note: '', status: 'pending_manager' as const, createdAt: '2026-10-27T02:00:00.000Z',
  };
  const next = { ...(await store.getDraft(draftId))!, status: 'confirmed' as const, closedAt: '2026-10-27T03:00:00.000Z' };
  await expect(store.commitConfirmingAppointments(next, [appointment])).rejects.toThrow('injected_before_commit');
  expect(await store.listAppointments({ employeePersonId: personId })).toEqual([]);
  expect(await store.getDraft(draftId)).toMatchObject({ status: 'confirming' });
  expect((await store.commitConfirmingAppointments(next, [appointment])).total).toBe(1);
  expect(await store.confirmPendingAppointment(appointment.appointmentId)).toBe('confirmed');
  expect((await store.commitConfirmingAppointments(next, [{ ...appointment, status: 'pending_manager' }])).claimed).toBe(false);
  expect(await store.listAppointments({ employeePersonId: personId, status: 'confirmed' })).toHaveLength(1);
  expect(await store.confirmPendingAppointment(appointment.appointmentId)).toBe('already');
  await client.end();

  const crash = await open(cluster.url);
  await crash.store.savePerson(person({ personId: 'person-appt', accountId: 'acct-appt', memberId: 'member-appt', displayName: '预约员', tier: 'employee' }));
  await crash.store.savePerson(person({ personId: 'person-appt-mgr', accountId: 'acct-appt-mgr', memberId: 'member-appt-mgr', displayName: '预约店长', tier: 'manager' }));
  const crashed = bind(crash.store, () => new Date('2026-10-27T12:00:00+08:00'));
  await crashed.handler.handleMessage({ memberId: 'member-appt', text: '预约 李欣 15:00' });
  const pending = await crash.store.getOpenDraft('person-appt');
  expect(await crash.store.claimPendingDraft(pending!.draftId)).toMatchObject({ status: 'confirming' });
  expect(await crash.store.listAppointments({ employeePersonId: 'person-appt' })).toEqual([]);
  await crash.close();
  const resumed = await open(cluster.url);
  const session = bind(resumed.store, () => new Date('2026-10-27T12:05:00+08:00'));
  await session.handler.runMaintenance();
  expect(await resumed.store.listAppointments({ employeePersonId: 'person-appt', status: 'pending_manager' })).toHaveLength(1);
  expect(await resumed.store.listAppointments({ employeePersonId: 'person-appt', status: 'confirmed' })).toEqual([]);
  await session.handler.runMaintenance();
  expect(await resumed.store.listAppointments({ employeePersonId: 'person-appt' })).toHaveLength(1);
  const looked = await session.handler.handleMessage({ memberId: 'member-appt', text: '预约结果' });
  expect(looked.replies.join('\n')).toContain('等店长确认 1');
  await session.handler.handleMessage({ memberId: 'member-appt', text: '预约 赵芳 16:00' });
  await session.handler.handleMessage({ memberId: 'member-appt', text: '对' });
  const other = bind(resumed.store, () => new Date('2026-10-27T12:06:00+08:00'));
  const replies = await Promise.all([
    session.handler.handleMessage({ memberId: 'member-appt-mgr', text: '确认预约 1' }),
    other.handler.handleMessage({ memberId: 'member-appt-mgr', text: '确认预约 1' }),
  ]);
  const confirmed = await resumed.store.listAppointments({ employeePersonId: 'person-appt', status: 'confirmed' });
  const waiting = await resumed.store.listAppointments({ employeePersonId: 'person-appt', status: 'pending_manager' });
  expect(confirmed.map(row => row.customerName)).toEqual(['李欣']);
  expect(waiting.map(row => row.customerName)).toEqual(['赵芳']);
  expect(replies.map(reply => reply.replies.join('\n')).some(text => text.includes('已经确认过') || text.includes('已确认李欣'))).toBe(true);
  expect(replies.map(reply => reply.replies.join('\n')).some(text => text.includes('已确认赵芳'))).toBe(false);
  await resumed.close();

  const raced = await open(cluster.url);
  await raced.store.savePerson(person({ personId: 'person-appt-race', accountId: 'acct-appt-race', memberId: 'member-appt-race', displayName: '预约并发', tier: 'employee' }));
  const left = bind(raced.store, () => new Date('2026-10-27T13:00:00+08:00'));
  const right = bind(raced.store, () => new Date('2026-10-27T13:00:00+08:00'));
  await left.handler.handleMessage({ memberId: 'member-appt-race', text: '预约 周琪 16:00' });
  await Promise.all([
    left.handler.handleMessage({ memberId: 'member-appt-race', text: '对' }),
    right.handler.handleMessage({ memberId: 'member-appt-race', text: '对' }),
  ]);
  expect(await raced.store.listAppointments({ employeePersonId: 'person-appt-race', status: 'pending_manager' })).toHaveLength(1);
  expect(await raced.store.listAppointments({ employeePersonId: 'person-appt-race', status: 'confirmed' })).toEqual([]);
  await raced.close();
});
