import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagerStore } from '../../src/role-eval/manager-store.js';
import { WorkbenchAccessStore } from '../../src/role-eval/workbench-access.js';
import { createWecomBotContext } from '../../src/role-eval/wecom-bot-context.js';
import { createBotReportHandler, STORE_RESULT_BUDGET_MS } from '../../src/role-eval/wecom-bot-handler.js';
import { createWecomBotAssembly, type WecomBotAssemblyOutcome } from '../../src/role-eval/wecom-bot-assembly.js';
import { offlineBotSdk } from '../fixtures/offline-bot-sdk.js';
import { createStoreBusinessPort } from '../../src/role-eval/front-claw-boot.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import { MemorySql } from './sql-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

const sheet = `27号明川店
李欣：888（合成美容师甲）
李秋：98（合成美容师甲）`;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'store-entry-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new ManagerStore(join(dir, 'ledger.sqlite'));
  const grants = new WorkbenchAccessStore(join(dir, 'grants.sqlite'));
  cleanups.push(() => ledger.close(), () => grants.close());
  grants.change('admin', { accountId: 'a', storeId: 'store-ming', roles: ['marketing', 'manager'], active: true, expectedVersion: 0, requestKey: 'open-a' });
  grants.change('admin', { accountId: 'b', storeId: 'store-tian', roles: ['marketing'], active: true, expectedVersion: 0, requestKey: 'open-b' });
  let member = 'member-a';
  let account = 'a';
  const authority = createWecomBotContext({
    mode: 'isolated-synthetic', botId: 'bot', corpId: 'corp', tenantId: 'tenant', stores: [{ id: 'store-ming' }, { id: 'store-tian' }],
    roles: ['marketing', 'manager'], store: grants, readSubject: async () => ({ botId: 'bot', memberId: member }),
    readBinding: async () => ({ botId: 'bot', corpId: 'corp', memberId: member, accountId: account, version: 1, active: true }),
    readNative: async id => ({ user: { id, role: 'member', status: 'active', must_change_password: false }, workspaceJid: 'web:home-' + id }),
  });
  cleanups.push(() => authority.close());
  const sql = new MemorySql();
  const submitted: string[] = [];
  let extractorCalls = 0;
  const conversations = {
    reportExtractor: () => { extractorCalls += 1; return new Promise(() => undefined); },
    beforeReply: () => undefined,
    route: async () => { submitted.push('marketing'); return { reply: '收到，正在处理，稍后回复你。' }; },
  };
  let frame: unknown;
  const employees = [
    { accountId: 'a', employeeId: 'employee-a', employeeName: '合成美容师甲', storeName: '明川店' },
    { accountId: 'b', employeeId: 'employee-b', employeeName: '合成美容师乙', storeName: '天澜店' },
  ];
  return {
    sql, submitted, extractorCalls: () => extractorCalls, employees, ledger, grants, authority,
    setFrame(content: string, who = member) {
      frame = { cmd: 'aibot_msg_callback', headers: { req_id: 'req-' + content.length }, body: { aibotid: 'bot', msgid: 'm-' + submitted.length + '-' + content.length, chattype: 'single', from: { userid: who }, msgtype: 'text', text: { content } } };
    },
    useTian() { member = 'member-b'; account = 'b'; },
    async port() {
      await migratePerformance(sql);
      const store = createPostgresPerformanceStore(sql);
      const unified = createWecomBotHandler({
        mode: 'isolated-synthetic', store, now: () => new Date('2026-10-20T02:00:00Z'),
        resolve: id => store.getPersonByMember(id), send: async () => 'sent',
        model: { complete: async () => ({ type: 'chat' as const, text: '未写入账本' }) },
      });
      return { store, port: createStoreBusinessPort(store, unified) };
    },
    handler(port: ReturnType<typeof createStoreBusinessPort>, storeId: string) {
      let seenDeadline = 0;
      const wrapped = { ...port, handleMessage: async (input: { memberId: string; text: string; signal?: AbortSignal; deadline?: number }) => {
        seenDeadline = (input.deadline ?? 0) - performance.now();
        return port.handleMessage(input);
      } };
      const handler = createBotReportHandler({
        mode: 'isolated-synthetic', authority, ledger, scope: { tenant: 'tenant', store: storeId, workspace: 'web:home-' + account },
        employees, readEvent: () => frame, now: () => new Date('2026-10-20T02:00:00Z'),
        conversations: conversations as never, storeAssistant: wrapped,
      });
      return { handler, deadlineGap: () => seenDeadline };
    },
  };
}

it('writes a merged sheet through the opened store and does not route it to 内容营销', async () => {
  const world = harness();
  const opened = await world.port();
  const live = world.handler(opened.port, 'store-ming');
  world.setFrame(sheet);
  const started = performance.now();
  const echo = await live.handler.handle({ correlationId: 'sheet', signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  expect(performance.now() - started).toBeLessThan(STORE_RESULT_BUDGET_MS);
  expect(live.deadlineGap()).toBeLessThanOrEqual(STORE_RESULT_BUDGET_MS);
  expect(live.deadlineGap()).toBeGreaterThan(14_000);
  expect(world.submitted).toEqual([]);
  expect(world.extractorCalls()).toBe(0);
  expect(echo.reply.body.stream.content).toContain('还没入账');
  expect(echo.reply.body.stream.content).not.toContain('收到，正在处理');
  expect(echo.reply.body.stream.content).not.toContain('内容营销');
  expect(await opened.store.listEntries()).toEqual([]);
  expect(await opened.store.listPeople()).toHaveLength(1);
  expect((await opened.store.listDrafts({ status: 'pending' }))).toHaveLength(1);
  world.setFrame('对');
  const saved = await live.handler.handle({ correlationId: 'confirm', signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  expect(saved.reply.body.stream.content).toContain('已入账');
  expect(world.submitted).toEqual([]);
  const reopened = createPostgresPerformanceStore(world.sql);
  const rows = await reopened.listEntries({ status: 'recorded' });
  expect(rows.map(row => [row.customerName, row.amount, row.ownerName, row.reporterPersonId])).toEqual([
    ['李欣', 888, '合成美容师甲', 'employee-a'],
    ['李秋', 98, '合成美容师甲', 'employee-a'],
  ]);
  expect(await reopened.listPeople()).toHaveLength(1);
  const before = (await reopened.listEntries({ status: 'recorded' })).length;
  world.setFrame('对');
  const repeat = await live.handler.handle({ correlationId: 'again', signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  expect(repeat.reply.body.stream.content).toContain('没有重复入账');
  expect(await reopened.listEntries({ status: 'recorded' })).toHaveLength(before);
  world.useTian();
  world.setFrame(`27号天澜店\n周娜：100（合成美容师乙）`);
  const foreign = await world.handler(opened.port, 'store-tian').handler.handle({ correlationId: 'tian', signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  expect(foreign.reply.body.stream.content).not.toContain('内容营销');
  const ming = await reopened.listEntries({ storeId: 'store-ming', status: 'recorded' });
  expect(ming).toHaveLength(2);
  const tianRows = await reopened.listEntries({ storeId: 'store-tian', status: 'recorded' });
  expect(tianRows.every(row => row.reporterPersonId === 'employee-b')).toBe(true);
});

it('keeps store questions on the store assistant and leaves marketing copy on the granted role', async () => {
  const world = harness();
  const opened = await world.port();
  const live = world.handler(opened.port, 'store-ming');
  const ask = async (text: string) => {
    world.submitted.length = 0;
    world.setFrame(text);
    const result = await live.handler.handle({ correlationId: text, signal: new AbortController().signal, deadline: performance.now() + 60_000 });
    return result.reply.body.stream.content;
  };
  expect(await ask('你好')).toContain('未写入账本');
  expect(world.submitted).toEqual([]);
  expect(await ask('今天进度')).toContain('今天 已做');
  expect(world.submitted).toEqual([]);
  expect(await ask('谁还没报')).toContain('合成美容师甲');
  expect(world.submitted).toEqual([]);
  expect(await ask('本月目标9w')).toContain('目标');
  expect((await opened.store.listTargets('store-ming'))[0]?.amount).toBe(90_000);
  expect(world.submitted).toEqual([]);
  expect(await ask('预约 李欣 15:00')).toContain('预约');
  expect(world.submitted).toEqual([]);
  expect(await ask('帮我写小红书文案')).toContain('收到，正在处理');
  expect(world.submitted).toEqual(['marketing']);
});

it('does not start a ledger write after the budget is already gone', async () => {
  const world = harness();
  const opened = await world.port();
  const unified = createWecomBotHandler({
    mode: 'isolated-synthetic', store: opened.store, now: () => new Date('2026-10-20T02:00:00Z'),
    resolve: async () => null, send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '不应调用' }) },
  });
  const aborted = await unified.handleMessage({ memberId: 'member-a', text: sheet, signal: AbortSignal.abort(), deadline: performance.now() + 60_000 });
  expect(aborted.replies.join('\n')).toContain('没有入账');
  const expired = await unified.handleMessage({ memberId: 'member-a', text: sheet, signal: new AbortController().signal, deadline: performance.now() - 1 });
  expect(expired.replies.join('\n')).toContain('没有入账');
  expect(await opened.store.listDrafts()).toEqual([]);
  expect(await opened.store.listEntries()).toEqual([]);
  expect(await opened.store.listPeople()).toEqual([]);
});

it('does not grant an employee the manager target command', async () => {
  const world = harness();
  const opened = await world.port();
  await opened.store.savePerson({
    personId: 'employee-a', accountId: 'a', memberId: 'member-a', displayName: '合成美容师甲',
    storeId: 'store-ming', storeName: '明川店', tier: 'employee', roles: ['marketing'], active: true,
  });
  const unified = createWecomBotHandler({
    mode: 'isolated-synthetic', store: opened.store, now: () => new Date('2026-10-20T02:00:00Z'),
    resolve: id => opened.store.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: '不应调用' }) },
  });
  const denied = await unified.handleMessage({ memberId: 'member-a', text: '本月目标9w', signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  expect(denied.replies.join('\n')).toContain('只有店长');
  expect(denied.modelCalled).toBe(false);
  expect(await opened.store.listTargets('store-ming')).toEqual([]);
});

it('returns the finished confirm after the request budget and does not insert it again', async () => {
  const world = harness();
  const opened = await world.port();
  const live = world.handler(opened.port, 'store-ming');
  const call = (id: string, signal = new AbortController().signal, deadline = performance.now() + 60_000) => live.handler.handle({ correlationId: id, signal, deadline });
  world.setFrame(sheet);
  await call('sheet');
  await expect(call('cancelled', AbortSignal.abort())).rejects.toThrow('authority_cancelled');
  expect(await opened.store.listEntries()).toEqual([]);
  expect(await opened.store.listDrafts({ status: 'pending' })).toHaveLength(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const original = opened.store.commitConfirmingDraft.bind(opened.store);
  opened.store.commitConfirmingDraft = async (draft, entries) => {
    entered = true;
    await gate;
    return original(draft, entries);
  };
  world.setFrame('对');
  const controller = new AbortController();
  const pending = call('slow-confirm', controller.signal);
  const started = Date.now();
  while (!entered) {
    if (Date.now() - started > 2_000) throw Error('confirm did not reach the ledger write');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();
  release();
  const saved = await pending;
  expect(saved.reply.body.stream.content).toContain('已入账');
  expect(saved.reply.body.stream.content).not.toContain('没有入账');
  const recorded = await opened.store.listEntries({ status: 'recorded' });
  expect(recorded).toHaveLength(2);
  world.setFrame('对');
  const repeat = await call('repeat');
  expect(repeat.reply.body.stream.content).toContain('没有重复入账');
  expect(await opened.store.listEntries({ status: 'recorded' })).toHaveLength(2);
  world.setFrame(sheet);
  const resent = await call('resend');
  expect(resent.reply.body.stream.content).toContain('记过了');
  expect(await opened.store.listEntries({ status: 'recorded' })).toHaveLength(2);
});

it('completes a claimed draft after the insert never ran and does not book it twice', async () => {
  const world = harness();
  const opened = await world.port();
  const live = world.handler(opened.port, 'store-ming');
  const call = (id: string) => live.handler.handle({ correlationId: id, signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  world.setFrame(sheet);
  await call('sheet');
  const draft = (await opened.store.listDrafts({ status: 'pending' }))[0];
  expect(await opened.store.claimPendingDraft(draft!.draftId)).toMatchObject({ status: 'confirming' });
  expect(await opened.store.listEntries()).toEqual([]);
  const person = await opened.store.getPerson('employee-a');
  person!.active = false;
  await opened.store.savePerson(person!);
  const restarted = createWecomBotHandler({
    mode: 'isolated-synthetic', store: opened.store, now: () => new Date('2026-10-20T02:00:00Z'),
    resolve: id => opened.store.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: '不应调用' }) },
  });
  await restarted.runMaintenance();
  expect(await opened.store.listEntries()).toEqual([]);
  expect((await opened.store.getDraft(draft!.draftId))?.status).toBe('confirming');
  person!.active = true;
  await opened.store.savePerson(person!);
  await restarted.runMaintenance();
  expect(await opened.store.listEntries({ status: 'recorded' })).toHaveLength(2);
  await restarted.runMaintenance();
  expect(await opened.store.listEntries({ status: 'recorded' })).toHaveLength(2);
  world.setFrame('入账结果');
  const looked = await call('lookup');
  expect(looked.reply.body.stream.content).toContain('已入账 2 笔');
  expect(looked.reply.body.stream.content).not.toContain('没有入账');
  world.setFrame('对');
  expect((await call('again')).reply.body.stream.content).toContain('没有重复入账');
  expect(await opened.store.listEntries({ status: 'recorded' })).toHaveLength(2);
});

it('does not finish another store when the reporter has left it', async () => {
  const world = harness();
  const opened = await world.port();
  const live = world.handler(opened.port, 'store-ming');
  world.setFrame(sheet);
  await live.handler.handle({ correlationId: 'sheet', signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  const draft = (await opened.store.listDrafts({ status: 'pending' }))[0];
  await opened.store.claimPendingDraft(draft!.draftId);
  const person = await opened.store.getPerson('employee-a');
  person!.storeId = 'store-tian';
  await opened.store.savePerson(person!);
  const restarted = createWecomBotHandler({
    mode: 'isolated-synthetic', store: opened.store, now: () => new Date('2026-10-20T02:00:00Z'),
    resolve: id => opened.store.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: '不应调用' }) },
  });
  await restarted.runMaintenance();
  expect(await opened.store.listEntries()).toEqual([]);
  expect((await opened.store.getDraft(draft!.draftId))?.status).toBe('confirming');
});

it('reports a settled confirm after the assembly budget and answers a later lookup', async () => {
  const world = harness();
  const opened = await world.port();
  const original = opened.store.commitConfirmingDraft.bind(opened.store);
  opened.store.commitConfirmingDraft = async (draft, entries) => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    return original(draft, entries);
  };
  const offline = offlineBotSdk();
  const outcomes: WecomBotAssemblyOutcome[] = [];
  const app = createWecomBotAssembly({
    mode: 'isolated-synthetic', botId: 'bot', corpId: 'corp', client: offline.client, requestTimeoutMs: 400,
    identity: {
      tenantId: 'tenant', stores: [{ id: 'store-ming' }], roles: ['marketing', 'manager'], store: world.grants,
      readBinding: async () => ({ botId: 'bot', corpId: 'corp', memberId: 'member-a', accountId: 'a', version: 1, active: true }),
      readNative: async id => ({ user: { id, role: 'member', status: 'active', must_change_password: false }, workspaceJid: 'web:home-' + id }),
    },
    businesses: [{ scope: { tenant: 'tenant', store: 'store-ming', workspace: 'web:home-a' }, employees: world.employees, ledger: world.ledger }],
    sender: { sdk: offline.sdk, fileSdk: offline.fileSdk }, storeAssistant: opened.port,
    onOutcome: outcome => { outcomes.push(outcome); },
  });
  cleanups.push(() => app.close());
  offline.authenticate();
  const frame = (content: string, id: string) => ({ cmd: 'aibot_msg_callback', headers: { req_id: 'req-' + id }, body: { msgid: id, aibotid: 'bot', msgtype: 'text', chattype: 'single', create_time: 1790000000, from: { userid: 'member-a', corpid: 'corp' }, text: { content } } });
  offline.frame(frame(sheet, 'sheet'));
  await app.idle();
  offline.frame(frame('对', 'confirm'));
  await app.idle();
  const settled = outcomes.at(-1);
  expect(settled?.state).toBe('handled');
  expect(settled?.detail).toBe('ledger_settled');
  expect(settled?.result?.result?.reply?.body?.stream?.content).toContain('已入账');
  expect(settled?.result?.result?.reply?.body?.stream?.content).not.toContain('没有入账');
  expect(await opened.store.listEntries({ status: 'recorded' })).toHaveLength(2);
  opened.store.commitConfirmingDraft = original;
  offline.frame(frame('入账结果', 'lookup'));
  await app.idle();
  const lookup = outcomes.at(-1);
  expect(lookup?.detail).toBe('event_handled');
  expect(lookup?.result?.result?.reply?.body?.stream?.content).toContain('已入账 2 笔');
  expect(await opened.store.listEntries({ status: 'recorded' })).toHaveLength(2);
});

it('submits an appointment once and keeps the manager confirmation on that same row', async () => {
  const world = harness();
  const opened = await world.port();
  const live = world.handler(opened.port, 'store-ming');
  const call = async (text: string) => {
    world.submitted.length = 0;
    world.setFrame(text);
    const result = await live.handler.handle({ correlationId: text, signal: new AbortController().signal, deadline: performance.now() + 60_000 });
    return result.reply.body.stream.content;
  };
  expect(await call('预约 李欣 15:00')).toContain('还没提交');
  expect(world.submitted).toEqual([]);
  expect(await opened.store.listAppointments()).toEqual([]);
  expect(await call('对')).toContain('预约已提交');
  expect(await opened.store.listAppointments({ status: 'pending_manager' })).toHaveLength(1);
  expect(await opened.store.listAppointments({ status: 'confirmed' })).toEqual([]);
  expect(await call('对')).toContain('没有重复提交');
  expect(await call('预约 李欣 15:00')).toContain('已经提交过');
  expect(await opened.store.listAppointments()).toHaveLength(1);
  expect(await call('预约结果')).toContain('等店长确认 1');
  expect(await call('确认预约 1')).toContain('已确认李欣');
  expect(await opened.store.listAppointments({ status: 'confirmed' })).toHaveLength(1);
  expect(await call('确认预约 1')).toContain('已经确认过');
  expect(await opened.store.listAppointments({ status: 'confirmed' })).toHaveLength(1);
});

it('does not submit a claimed appointment for an inactive or moved reporter', async () => {
  const world = harness();
  const opened = await world.port();
  await opened.store.savePerson({
    personId: 'employee-a', accountId: 'a', memberId: 'member-a', displayName: '合成美容师甲',
    storeId: 'store-ming', storeName: '明川店', tier: 'employee', roles: ['marketing'], active: true,
  });
  const unified = createWecomBotHandler({
    mode: 'isolated-synthetic', store: opened.store, now: () => new Date('2026-10-20T02:00:00Z'),
    resolve: id => opened.store.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: '不应调用' }) },
  });
  const say = (memberId: string, text: string) => unified.handleMessage({ memberId, text, signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  expect((await say('member-a', '预约 李欣 15:00')).replies.join('\n')).toContain('还没提交');
  const draft = (await opened.store.listDrafts({ status: 'pending', kind: 'appointment' }))[0];
  expect(await opened.store.claimPendingDraft(draft!.draftId)).toMatchObject({ status: 'confirming' });
  expect(await opened.store.listAppointments()).toEqual([]);
  const person = await opened.store.getPerson('employee-a');
  person!.active = false;
  await opened.store.savePerson(person!);
  await unified.runMaintenance();
  expect(await opened.store.listAppointments()).toEqual([]);
  person!.active = true;
  person!.storeId = 'store-tian';
  await opened.store.savePerson(person!);
  await unified.runMaintenance();
  expect(await opened.store.listAppointments()).toEqual([]);
  person!.storeId = 'store-ming';
  await opened.store.savePerson(person!);
  await unified.runMaintenance();
  const waiting = await opened.store.listAppointments({ storeId: 'store-ming', employeePersonId: 'employee-a', status: 'pending_manager' });
  expect(waiting).toHaveLength(1);
  await unified.runMaintenance();
  expect(await opened.store.listAppointments({ storeId: 'store-ming', employeePersonId: 'employee-a' })).toHaveLength(1);
  await opened.store.savePerson({
    personId: 'manager-a', accountId: 'manager-a', memberId: 'member-manager', displayName: '店长甲',
    storeId: 'store-ming', storeName: '明川店', tier: 'employee', roles: ['marketing'], active: true,
  });
  const denied = await say('member-manager', '确认预约 1');
  expect(denied.replies.join('\n')).toContain('只有店长');
  expect(await opened.store.listAppointments({ status: 'confirmed' })).toEqual([]);
  const manager = await opened.store.getPerson('manager-a');
  manager!.tier = 'manager';
  await opened.store.savePerson(manager!);
  expect((await say('member-manager', '预约列表')).replies.join('\n')).toContain('李欣');
  expect((await say('member-manager', '确认预约 1')).replies.join('\n')).toContain('已确认李欣');
  expect(await opened.store.confirmPendingAppointment(waiting[0]!.appointmentId)).toBe('already');
  expect(await opened.store.listAppointments({ status: 'confirmed' })).toHaveLength(1);
});

it('keeps 确认预约 1 on the appointment that was shown', async () => {
  const world = harness();
  const opened = await world.port();
  await opened.store.savePerson({
    personId: 'employee-a', accountId: 'a', memberId: 'member-a', displayName: '合成美容师甲',
    storeId: 'store-ming', storeName: '明川店', tier: 'manager', roles: ['manager'], active: true,
  });
  const unified = createWecomBotHandler({
    mode: 'isolated-synthetic', store: opened.store, now: () => new Date('2026-10-20T02:00:00Z'),
    resolve: id => opened.store.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: '不应调用' }) },
  });
  const say = (text: string) => unified.handleMessage({ memberId: 'member-a', text, signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  expect((await say('预约 李欣 15:00')).replies.join('\n')).toContain('还没提交');
  expect((await say('预约 李欣 16:00')).replies.join('\n')).toContain('还没提交');
  expect((await say('对')).replies.join('\n')).toContain('预约已提交');
  const shown = await opened.store.listAppointments({ status: 'pending_manager' });
  expect(shown.map(row => row.whenText)).toEqual(['15:00', '16:00']);
  const first = shown[0]!;
  const second = shown[1]!;
  expect((await say('确认预约 1')).replies.join('\n')).toContain('已确认李欣');
  expect((await opened.store.listAppointments({ status: 'confirmed' })).map(row => row.appointmentId)).toEqual([first.appointmentId]);
  expect((await say('确认预约 1')).replies.join('\n')).toContain('已经确认过');
  expect((await opened.store.listAppointments({ status: 'pending_manager' })).map(row => row.appointmentId)).toEqual([second.appointmentId]);
  const earlier = {
    appointmentId: 'earlier-sort', storeId: 'store-ming', employeePersonId: 'employee-a',
    customerName: '周娜', whenText: '09:00', note: '', status: 'pending_manager' as const, createdAt: '2000-01-01T00:00:00.000Z',
  };
  await opened.store.saveAppointment(earlier);
  expect((await opened.store.listAppointments({ status: 'pending_manager' }))[0]?.customerName).toBe('周娜');
  expect((await say('确认预约 1')).replies.join('\n')).toContain('已经确认过');
  expect((await opened.store.listAppointments({ status: 'pending_manager' })).map(row => row.customerName)).toEqual(['周娜', '李欣']);
  const token = second.appointmentId.slice(0, 8);
  expect((await say(`确认预约 1 ${token}`)).replies.join('\n')).toContain('列表已经变了');
  expect((await opened.store.listAppointments({ status: 'confirmed' })).map(row => row.appointmentId)).toEqual([first.appointmentId]);
  expect((await say('预约列表')).replies.join('\n')).toContain('周娜');
  expect((await say('确认预约 1')).replies.join('\n')).toContain('已确认周娜');
  const person = await opened.store.getPerson('employee-a');
  person!.tier = 'employee';
  await opened.store.savePerson(person!);
  expect((await say('确认预约 2')).replies.join('\n')).toContain('只有店长');
  person!.tier = 'manager';
  person!.storeId = 'store-tian';
  await opened.store.savePerson(person!);
  expect((await say('确认预约 2')).replies.join('\n')).toContain('不在你现在的门店');
  expect((await opened.store.listAppointments({ storeId: 'store-ming', status: 'pending_manager' })).map(row => row.whenText)).toEqual(['16:00']);
});

it('keeps a failed or unknown appointment notice without sending it again', async () => {
  const world = harness();
  const opened = await world.port();
  await opened.store.savePerson({
    personId: 'employee-a', accountId: 'a', memberId: 'member-a', displayName: '合成美容师甲',
    storeId: 'store-ming', storeName: '明川店', tier: 'employee', roles: ['marketing'], active: true,
  });
  await opened.store.savePerson({
    personId: 'manager-a', accountId: 'manager-a', memberId: 'member-manager', displayName: '店长甲',
    storeId: 'store-ming', storeName: '明川店', tier: 'manager', roles: ['manager'], active: true,
  });
  let mode: 'not_sent' | 'unknown' | 'sent' = 'not_sent';
  let failRecord = false;
  let sends = 0;
  const originalUpdate = opened.store.updateNotificationStatus.bind(opened.store);
  opened.store.updateNotificationStatus = async (id, status, sentAt) => {
    if (failRecord) throw Error('record_failed');
    return originalUpdate(id, status, sentAt);
  };
  const unified = createWecomBotHandler({
    mode: 'isolated-synthetic', store: opened.store, now: () => new Date('2026-10-20T02:00:00Z'),
    resolve: id => opened.store.getPersonByMember(id),
    send: async () => { sends += 1; if (mode === 'unknown') throw Error('delivery_lost'); return mode; },
    model: { complete: async () => ({ type: 'chat', text: '不应调用' }) },
  });
  const say = (memberId: string, text: string) => unified.handleMessage({ memberId, text, signal: new AbortController().signal, deadline: performance.now() + 60_000 });
  await say('member-a', '预约 李欣 15:00');
  const submitted = await say('member-a', '对');
  expect(submitted.replies.join('\n')).toContain('店长通知未送达');
  expect(submitted.replies.join('\n')).not.toContain('已收到');
  expect(await opened.store.listAppointments({ status: 'pending_manager' })).toHaveLength(1);
  expect(await opened.store.listAppointments({ status: 'confirmed' })).toEqual([]);
  expect((await opened.store.listNotifications()).map(row => row.status)).toEqual(['not_sent']);
  const sentBefore = sends;
  await unified.runMaintenance();
  expect(sends).toBe(sentBefore);
  mode = 'unknown';
  await say('member-a', '预约 周娜 16:00');
  const unknown = await say('member-a', '对');
  expect(unknown.replies.join('\n')).toContain('通知结果未知');
  expect((await opened.store.listNotifications()).some(row => row.status === 'unknown')).toBe(true);
  expect(await opened.store.listAppointments({ status: 'confirmed' })).toEqual([]);
  mode = 'sent';
  failRecord = true;
  await say('member-a', '预约 赵芳 17:00');
  const crashed = await say('member-a', '对');
  expect(crashed.replies.join('\n')).toContain('通知结果未知');
  failRecord = false;
  const pending = (await opened.store.listNotifications()).filter(row => row.status === 'pending');
  expect(pending).toHaveLength(1);
  const sendsAfterCrash = sends;
  await unified.runMaintenance();
  expect(sends).toBe(sendsAfterCrash);
  expect((await opened.store.listNotifications()).some(row => row.status === 'pending')).toBe(false);
  expect((await opened.store.listNotifications()).some(row => row.status === 'unknown')).toBe(true);
  expect((await say('member-manager', '预约列表')).replies.join('\n')).toContain('李欣');
  const before = sends;
  expect((await say('member-manager', '确认预约 1')).replies.join('\n')).toContain('已确认李欣');
  expect((await say('member-manager', '确认预约 1')).replies.join('\n')).toContain('已经确认过');
  expect(sends).toBe(before + 1);
  expect((await opened.store.listAppointments({ status: 'confirmed' })).map(row => row.customerName)).toEqual(['李欣']);
});
