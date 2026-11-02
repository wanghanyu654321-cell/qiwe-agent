import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { WORKBENCH_ROLES, type WorkbenchRole } from '../../src/role-eval/workbench-access.js';
import { MemoryPerformanceStore, type Person } from '../../src/role-eval/performance-store.js';
import { createAssistantTools } from '../../src/role-eval/assistant-tools.js';
import { createWecomBotHandler, type ModelInput, type ModelOutput, type SendResult } from '../../src/role-eval/wecom-bot-handler.js';
import { QIXUN_CONFIG_KEY } from '../../src/role-eval/metrics.js';
import { CHATS } from './report-corpus.js';

const roles = [...WORKBENCH_ROLES] as WorkbenchRole[];

function person(fields: Pick<Person, 'personId' | 'accountId' | 'memberId' | 'displayName' | 'storeId' | 'storeName' | 'tier'> & { roles?: WorkbenchRole[] }): Person {
  return { roles, active: true, ...fields };
}

function salon() {
  const store = new MemoryPerformanceStore();
  const sent: { toPersonId: string; text: string }[] = [];
  const modelCalls: ModelInput[] = [];
  const outbound: string[] = [];
  let clock = new Date('2026-10-27T10:00:00+08:00');
  let sendResult: SendResult = 'sent';
  let respond: (input: ModelInput) => Promise<ModelOutput> = async () => ({ type: 'chat', text: 'Front Claw 在。' });
  const handler = createWecomBotHandler({
    mode: 'isolated-synthetic',
    store,
    now: () => clock,
    resolve: memberId => store.getPersonByMember(memberId),
    send: async message => { sent.push(message); return sendResult; },
    onOutbound: text => outbound.push(text),
    model: { complete: async input => { modelCalls.push(input); return respond(input); } },
  });
  const tools = createAssistantTools({ store, now: () => clock });
  const ming = { storeId: 'store-ming', storeName: '明川店' };
  const tian = { storeId: 'store-tian', storeName: '天澜店' };
  const people = {
    zhou: person({ personId: 'person-zhou', accountId: 'acct-zhou', memberId: 'member-zhou', displayName: '小周', ...ming, tier: 'employee' }),
    mei: person({ personId: 'person-mei', accountId: 'acct-mei', memberId: 'member-mei', displayName: '小美', ...ming, tier: 'employee' }),
    wen: person({ personId: 'person-wen', accountId: 'acct-wen', memberId: 'member-wen', displayName: '小文', ...ming, tier: 'employee' }),
    manager: person({ personId: 'person-mgr', accountId: 'acct-mgr', memberId: 'member-mgr', displayName: '周店长', ...ming, tier: 'manager' }),
    boss: person({ personId: 'person-boss', accountId: 'acct-boss', memberId: 'member-boss', displayName: '林老板', ...ming, tier: 'owner' }),
    juan: person({ personId: 'person-juan', accountId: 'acct-juan', memberId: 'member-juan', displayName: '小娟', ...tian, tier: 'employee' }),
    ping: person({ personId: 'person-ping', accountId: 'acct-ping', memberId: 'member-ping', displayName: '小平', ...tian, tier: 'employee' }),
  };
  return {
    store, sent, modelCalls, outbound, handler, tools, people,
    setClock(value: Date) { clock = value; },
    setSend(value: SendResult) { sendResult = value; },
    setModel(value: (input: ModelInput) => Promise<ModelOutput>) { respond = value; },
  };
}

async function seed(world: ReturnType<typeof salon>) {
  for (const member of Object.values(world.people)) await world.store.savePerson(member);
  await world.store.saveAlias({ storeId: 'store-tian', alias: '娟', personId: 'person-juan' });
  await world.store.saveAlias({ storeId: 'store-tian', alias: '娟娟', personId: 'person-juan' });
}

const report = `27号明川店
李欣：888（小美）
李秋：98（小周）
李秋：98（小周）`;

it('keeps one unified entry and leaves export closed', async () => {
  const source = readFileSync(new URL('../../src/role-eval/wecom-bot-handler.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/authorize\s*\(/);
  expect(source).not.toMatch(/handleManager|managerBypass|bypass/);
  const world = salon();
  await seed(world);
  for (const memberId of [world.people.zhou.memberId, world.people.manager.memberId, world.people.boss.memberId]) {
    const closed = await world.handler.handleMessage({ memberId, text: '导出 excel' });
    expect(closed.entry).toBe('unified');
    expect(closed.modelCalled).toBe(false);
    expect(closed.replies.join('\n')).toContain('还没开放');
    const file = await world.handler.handleMessage({ memberId, text: '文件' });
    expect(file.replies.join('\n')).toContain('还没开放');
  }
  world.setModel(async () => {
    expect(world.outbound.at(-1)).toBe('收到，正在处理');
    return { type: 'chat', text: 'Front Claw 在。' };
  });
  const chat = await world.handler.handleMessage({ memberId: world.people.manager.memberId, text: '帮我写一条朋友圈' });
  expect(chat.entry).toBe('unified');
  expect(chat.modelCalled).toBe(true);
  expect(world.modelCalls.at(-1)?.chosenRole).toBeNull();
  expect(world.modelCalls.at(-1)?.skills.map(skill => skill.key)).toEqual([...WORKBENCH_ROLES]);
  expect(chat.replies[0]).toBe('收到，正在处理');
});

it('does not mistake ordinary chat for a report', async () => {
  const world = salon();
  await seed(world);
  for (const text of CHATS) {
    world.modelCalls.length = 0;
    const result = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text });
    expect(result.entry).toBe('unified');
    expect(result.modelCalled).toBe(true);
    expect(world.modelCalls[0]?.chosenRole).toBeNull();
    expect(await world.store.listEntries()).toEqual([]);
    expect(await world.store.listDrafts()).toEqual([]);
  }
});

it('fast-paths a complete sheet, attributes the bracketed employee, and diffs a resend', async () => {
  const world = salon();
  await seed(world);
  const first = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: report });
  expect(world.modelCalls).toHaveLength(0);
  expect(first.replies[0]).not.toBe('收到，正在处理');
  expect(first.replies.join('\n')).toContain('1. 李欣 888 小美');
  expect(first.replies.join('\n')).toContain('李秋 98 小周');
  expect(await world.store.listEntries()).toEqual([]);
  const confirmed = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '对' });
  expect(confirmed.replies.join('\n')).toContain('已入账 3 笔');
  const rows = await world.store.listEntries({ status: 'recorded' });
  expect(rows.map(row => [row.customerName, row.amount, row.ownerName, row.reporterPersonId, row.amountType])).toEqual([
    ['李欣', 888, '小美', 'person-zhou', '业绩'],
    ['李秋', 98, '小周', 'person-zhou', '业绩'],
    ['李秋', 98, '小周', 'person-zhou', '业绩'],
  ]);
  const mei = await world.tools.myProgress(world.people.mei.accountId);
  const zhou = await world.tools.myProgress(world.people.zhou.accountId);
  expect(mei.ok && mei.data.today.done).toBe(888);
  expect(zhou.ok && zhou.data.today.done).toBe(196);
  const again = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: report });
  expect(again.replies.join('\n')).toContain('都记过了');
  expect(await world.store.listEntries({ status: 'recorded' })).toHaveLength(3);
  const extra = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: `${report}\n赵芳：35（小美）` });
  expect(extra.replies.join('\n')).toContain('已记下的 3 笔先跳过');
  expect(extra.replies.join('\n')).toContain('赵芳 35 小美');
  await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '全部确认' });
  expect(await world.store.listEntries({ status: 'recorded' })).toHaveLength(4);
  const shorter = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: `27号明川店\n李秋：98（小周）` });
  expect(shorter.replies.join('\n')).toContain('先不删');
  expect(await world.store.listEntries({ status: 'recorded' })).toHaveLength(4);
  const removed = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '删 1' });
  expect(removed.replies.join('\n')).toContain('已删');
  expect(await world.store.listEntries({ status: 'recorded' })).toHaveLength(3);
  expect(await world.store.listEntries({ status: 'void' })).toHaveLength(1);
  const voided = (await world.store.listEntries({ status: 'void' }))[0]!;
  const history = await world.store.listRevisions(voided.entryId);
  expect(history).toHaveLength(1);
  expect(JSON.parse(history[0]!.beforeJson).status).toBe('recorded');
  expect(world.sent.some(message => message.toPersonId === 'person-mgr' && message.text.includes('删了') && !message.text.includes('person-'))).toBe(true);
});

it('refuses cross-store reports and resolves same-store aliases without guessing', async () => {
  const world = salon();
  await seed(world);
  const refused = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '10.25天澜店\n周娜：1980（娟娟）' });
  expect(refused.modelCalled).toBe(false);
  expect(refused.replies.join('\n')).toContain('不能代报');
  expect(await world.store.listEntries()).toEqual([]);
  const proxy = await world.handler.handleMessage({ memberId: world.people.ping.memberId, text: '10.25天澜店\n周娜：1980（娟娟）' });
  expect(proxy.replies.join('\n')).toContain('小娟');
  expect(proxy.replies.join('\n')).not.toContain('对不上');
  await world.handler.handleMessage({ memberId: world.people.ping.memberId, text: '对' });
  const owned = await world.store.listEntries({ ownerPersonId: 'person-juan', status: 'recorded' });
  expect(owned).toHaveLength(1);
  expect(owned[0]?.reporterPersonId).toBe('person-ping');
  const unknown = await world.handler.handleMessage({ memberId: world.people.ping.memberId, text: '27号天澜店\n周娜：100（没有这个人）' });
  expect(unknown.replies.join('\n')).toContain('对不上');
  const premature = await world.handler.handleMessage({ memberId: world.people.ping.memberId, text: '对' });
  expect(premature.replies.join('\n')).toContain('不会猜');
  expect(await world.store.listEntries({ businessDay: '2026-10-27' })).toEqual([]);
  const picked = await world.handler.handleMessage({ memberId: world.people.ping.memberId, text: '1 是 小娟' });
  expect(picked.replies.join('\n')).not.toContain('对不上');
  await world.handler.handleMessage({ memberId: world.people.ping.memberId, text: '对' });
  expect(await world.store.listEntries({ businessDay: '2026-10-27', status: 'recorded' })).toHaveLength(1);
});

it('checks every tool again after a tier downgrade', async () => {
  const world = salon();
  await seed(world);
  const boss = world.people.boss;
  expect((await world.tools.storesRanking(boss.accountId)).ok).toBe(true);
  expect((await world.tools.unreported(boss.accountId)).ok).toBe(true);
  expect((await world.tools.getSummary(boss.accountId)).ok).toBe(true);
  expect((await world.tools.setTarget(boss.accountId, { personName: '小美', amount: 30000, periodMonth: '2026-10' })).ok).toBe(true);
  expect((await world.tools.myProgress(boss.accountId)).ok).toBe(true);
  const copy = await world.store.getPersonByAccount(boss.accountId);
  copy!.tier = 'owner';
  expect((await world.tools.storesRanking(boss.accountId)).ok).toBe(true);
  await world.store.savePerson({ ...boss, tier: 'manager' });
  const escalated = await world.store.getPersonByAccount(boss.accountId);
  escalated!.tier = 'owner';
  expect((await world.tools.storesRanking(boss.accountId)).ok).toBe(false);
  expect((await world.handler.handleMessage({ memberId: boss.memberId, text: '门店排名' })).replies.join('\n')).toContain('只有老板');
  expect((await world.tools.unreported(boss.accountId)).ok).toBe(true);
  expect((await world.tools.setTarget(boss.accountId, { personName: '小周', amount: 1000, periodMonth: '2026-10' })).ok).toBe(true);
  await world.store.savePerson({ ...boss, tier: 'employee' });
  expect((await world.tools.unreported(boss.accountId)).ok).toBe(false);
  expect((await world.tools.getSummary(boss.accountId)).ok).toBe(false);
  expect((await world.tools.setTarget(boss.accountId, { personName: '小周', amount: 1000, periodMonth: '2026-10' })).ok).toBe(false);
  expect((await world.handler.handleMessage({ memberId: boss.memberId, text: '这个月小王目标 3 万' })).replies.join('\n')).toContain('只有店长');
  expect((await world.tools.myProgress(boss.accountId)).ok).toBe(true);
  const sheet = await world.handler.handleMessage({ memberId: boss.memberId, text: '27号\n479(小美)' });
  expect(sheet.replies.join('\n')).toContain('479');
  await world.handler.handleMessage({ memberId: boss.memberId, text: '对' });
  expect(await world.store.listEntries({ reporterPersonId: boss.personId, status: 'recorded' })).toHaveLength(1);
  expect((await world.handler.handleMessage({ memberId: boss.memberId, text: '确认预约 1' })).replies.join('\n')).toContain('只有店长');
});

it('shows both rates, a one-store ranking array, and skips 七旬 until it is configured', async () => {
  const world = salon();
  await seed(world);
  world.setClock(new Date('2026-10-15T12:00:00+08:00'));
  await world.store.saveTarget({ storeId: 'store-ming', personId: 'person-mei', periodMonth: '2026-10', amount: 31000, updatedBy: 'person-mgr', updatedAt: '2026-10-01T00:00:00.000Z' });
  await world.store.insertEntries([
    { entryId: 'e-early', storeId: 'store-ming', businessDay: '2026-10-05', customerName: '林倩', amount: 10500, amountType: '业绩', ownerPersonId: 'person-mei', ownerName: '小美', reporterPersonId: 'person-zhou', note: '', status: 'recorded', disputed: false, createdAt: '2026-10-05T02:00:00.000Z' },
    { entryId: 'e-xun', storeId: 'store-ming', businessDay: '2026-10-12', customerName: '赵芳', amount: 4000, amountType: '业绩', ownerPersonId: 'person-mei', ownerName: '小美', reporterPersonId: 'person-zhou', note: '', status: 'recorded', disputed: false, createdAt: '2026-10-12T02:00:00.000Z' },
    { entryId: 'e-today', storeId: 'store-ming', businessDay: '2026-10-15', customerName: '李欣', amount: 1000, amountType: '业绩', ownerPersonId: 'person-mei', ownerName: '小美', reporterPersonId: 'person-zhou', note: '', status: 'recorded', disputed: false, createdAt: '2026-10-15T02:00:00.000Z' },
  ]);
  const progress = await world.tools.myProgress(world.people.mei.accountId);
  expect(progress.ok).toBe(true);
  if (!progress.ok) return;
  expect(progress.data.month.completionRate).toBeCloseTo(0.5);
  expect(progress.data.month.paceRate).toBeCloseTo(15500 / 15000);
  expect(progress.data.month.tier).toBe('high');
  expect(progress.data.xun.completionRate).toBeCloseTo(0.5);
  expect(progress.data.xun.paceRate).toBeCloseTo(1);
  expect(progress.data.xun.tier).toBe('high');
  expect(progress.data.qixun).toBeNull();
  expect(progress.reply).toContain('月完成率 50%');
  expect(progress.reply).toContain('进度达成率 103%');
  expect(progress.reply).toContain('旬完成率 50%');
  expect(progress.reply).toContain('进度达成率 100%');
  expect(progress.reply.split('\n').some(line => line.startsWith('七旬'))).toBe(false);
  await world.store.setConfig(QIXUN_CONFIG_KEY, '2026-10-10');
  const withQixun = await world.tools.myProgress(world.people.mei.accountId);
  expect(withQixun.ok).toBe(true);
  if (!withQixun.ok) return;
  expect(withQixun.data.qixun).toEqual({ start: '2026-10-10', end: '2026-12-18', done: 5000 });
  const qixunLine = withQixun.reply.split('\n').find(line => line.startsWith('七旬'));
  expect(qixunLine).toContain('5000');
  expect(qixunLine).not.toMatch(/进度达成率|差额|完成率/);
  await world.store.saveTarget({ storeId: 'store-ming', personId: 'person-mei', periodMonth: '2026-10', amount: 0, updatedBy: 'person-mgr', updatedAt: '2026-10-02T00:00:00.000Z' });
  const idle = await world.tools.myProgress(world.people.mei.accountId);
  expect(idle.ok).toBe(true);
  if (!idle.ok) return;
  expect(idle.data.month.status).toBe('未开始');
  expect(idle.data.month.gap).toBeNull();
  expect(idle.data.month.paceRate).toBeNull();
  expect(idle.data.month.completionRate).toBeNull();
  expect(idle.reply).toContain('未开始');
  expect(idle.reply).not.toMatch(/差额|进度达成率|月完成率|旬完成率|日完成率/);
  const only = salon();
  await only.store.savePerson(person({ personId: 'person-boss', accountId: 'acct-boss', memberId: 'member-boss', displayName: '林老板', storeId: 'store-ming', storeName: '明川店', tier: 'owner' }));
  const ranking = await only.tools.storesRanking('acct-boss');
  expect(ranking.ok).toBe(true);
  if (!ranking.ok) return;
  expect(Array.isArray(ranking.data.stores)).toBe(true);
  expect(ranking.data.stores).toHaveLength(1);
  expect(ranking.reply).toContain('门店排名');
  expect(ranking.reply).toContain('明川店');
});

it('lists who has no numbers and pushes the manager when an entry changes', async () => {
  const world = salon();
  await seed(world);
  await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '27号明川店\n李欣：888（小美）' });
  await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '对' });
  const missing = await world.handler.handleMessage({ memberId: world.people.manager.memberId, text: '谁还没报' });
  expect(missing.replies.join('\n')).toContain('小周');
  expect(missing.replies.join('\n')).toContain('小文');
  expect(missing.replies.join('\n')).not.toContain('小美');
  expect((await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '谁还没报' })).replies.join('\n')).toContain('只有店长');
  const denied = await world.handler.handleMessage({ memberId: world.people.wen.memberId, text: '更正 1 900' });
  expect(denied.replies.join('\n')).toContain('没有这一笔');
  const changed = await world.handler.handleMessage({ memberId: world.people.mei.memberId, text: '更正 1 900' });
  expect(changed.replies.join('\n')).toContain('已改好');
  const saved = (await world.store.listEntries({ ownerPersonId: 'person-mei', status: 'recorded' }))[0]!;
  expect(saved.amount).toBe(900);
  const history = await world.store.listRevisions(saved.entryId);
  expect(JSON.parse(history[0]!.beforeJson).amount).toBe(888);
  expect(JSON.parse(history[0]!.afterJson).amount).toBe(900);
  expect(world.sent.some(message => message.toPersonId === 'person-mgr' && message.text.includes('900') && !/person-|acct-|[0-9a-f]{8}-/.test(message.text))).toBe(true);
  const dispute = await world.handler.handleMessage({ memberId: world.people.mei.memberId, text: '这笔不是我的' });
  expect(dispute.replies.join('\n')).toContain('先不动');
  expect((await world.store.getEntry(saved.entryId))?.disputed).toBe(true);
  expect((await world.store.getEntry(saved.entryId))?.status).toBe('recorded');
});

it('reminds once, voids at cutoff, and confirms a backdated sheet before close', async () => {
  const world = salon();
  await seed(world);
  await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '10月24 明川店\n赵芳：35（小美）' });
  world.setClock(new Date('2026-10-27T10:29:00+08:00'));
  await world.handler.runMaintenance();
  expect(world.sent).toHaveLength(0);
  expect((await world.store.listDrafts())[0]?.reminder).toBe('none');
  world.setSend('not_sent');
  world.setClock(new Date('2026-10-27T10:30:00+08:00'));
  await world.handler.runMaintenance();
  expect(world.sent).toHaveLength(1);
  expect((await world.store.listDrafts())[0]?.reminder).toBe('none');
  world.setSend('unknown');
  await world.handler.runMaintenance();
  expect(world.sent).toHaveLength(2);
  expect((await world.store.listDrafts())[0]?.reminder).toBe('unknown');
  await world.handler.runMaintenance();
  expect(world.sent).toHaveLength(2);
  const other = salon();
  await seed(other);
  await other.handler.handleMessage({ memberId: other.people.zhou.memberId, text: '27号明川店\n李欣：888（小美）' });
  other.setClock(new Date('2026-10-27T22:40:00+08:00'));
  other.setClock(new Date('2026-10-27T23:00:00+08:00'));
  await other.handler.runMaintenance();
  expect(other.sent.map(message => message.text).join('\n')).toContain('已作废');
  expect(other.sent.map(message => message.text).join('\n')).not.toContain('还没确认。回复');
  expect((await other.store.listDrafts())[0]?.status).toBe('void');
  expect((await other.store.listDrafts())[0]?.reminder).toBe('none');
  expect((await other.store.listDrafts())[0]?.voidNotice).toBe('sent');
  await other.handler.runMaintenance();
  expect(other.sent).toHaveLength(1);
  const late = await other.handler.handleMessage({ memberId: other.people.zhou.memberId, text: '对' });
  expect(await other.store.listEntries()).toEqual([]);
  expect(late.replies.join('\n')).not.toContain('已入账');
  const backdated = salon();
  await seed(backdated);
  backdated.setClock(new Date('2026-10-27T18:00:00+08:00'));
  await backdated.handler.handleMessage({ memberId: backdated.people.zhou.memberId, text: '10月24 明川店\n赵芳：35（小美）' });
  const booked = await backdated.handler.handleMessage({ memberId: backdated.people.zhou.memberId, text: '对' });
  expect(booked.replies.join('\n')).toContain('已入账');
  expect((await backdated.store.listEntries())[0]?.businessDay).toBe('2026-10-24');
});

it('submits an appointment only after confirmation and tells the employee once the manager agrees', async () => {
  const world = salon();
  await seed(world);
  const staged = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '预约 林倩 明天 15:00 补色' });
  expect(staged.modelCalled).toBe(false);
  expect(staged.replies.join('\n')).toContain('还没提交');
  expect(await world.store.listAppointments()).toEqual([]);
  await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '预约 赵芳 后天 11:00' });
  const submitted = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '全部确认' });
  expect(submitted.replies.join('\n')).toContain('等店长确认');
  const pending = await world.store.listAppointments({ status: 'pending_manager' });
  expect(pending.map(item => item.customerName)).toEqual(['林倩', '赵芳']);
  expect(world.sent.some(message => message.toPersonId === 'person-mgr' && message.text.includes('1. 小周 林倩') && message.text.includes('2. 小周 赵芳'))).toBe(true);
  expect((await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '确认预约 1' })).replies.join('\n')).toContain('只有店长');
  const agreed = await world.handler.handleMessage({ memberId: world.people.manager.memberId, text: '确认预约 1' });
  expect(agreed.replies.join('\n')).toContain('已确认林倩');
  expect(world.sent.some(message => message.toPersonId === 'person-zhou' && message.text.includes('请告诉顾客'))).toBe(true);
  expect((await world.store.listAppointments({ status: 'confirmed' })).map(item => item.customerName)).toEqual(['林倩']);
  expect(await world.store.listAppointments({ status: 'pending_manager' })).toHaveLength(1);
});

it('asks instead of guessing when the model returns an invalid field', async () => {
  const world = salon();
  await seed(world);
  world.setModel(async () => ({ type: 'tool', name: 'report_numbers', fields: { businessDay: '2026-10-27', storeName: null, entries: [{ customer: '林倩', amount: '很多', employeeName: '小美', note: '' }] } }));
  const invalid = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '林倩来做了头发' });
  expect(invalid.replies[0]).toBe('收到，正在处理');
  expect(invalid.replies.join('\n')).toContain('不会猜');
  expect(await world.store.listEntries()).toEqual([]);
  expect(await world.store.listDrafts()).toEqual([]);
  const controller = new AbortController();
  world.setModel(async () => {
    controller.abort();
    return { type: 'tool', name: 'report_numbers', fields: { businessDay: '2026-10-27', storeName: '明川店', entries: [{ customer: '林倩', amount: 100, employeeName: '小美', note: '' }] } };
  });
  await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '还是没说清', signal: controller.signal });
  expect(await world.store.listDrafts()).toEqual([]);
  world.setModel(async () => ({ type: 'chat', text: '编号 person-zhou a1b2c3d4-e5f6-7890-abcd-ef1234567890' }));
  const scrubbed = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '你是谁' });
  expect(scrubbed.replies.join('\n')).not.toContain('person-zhou');
  expect(scrubbed.replies.join('\n')).not.toContain('a1b2c3d4');
  expect((await world.handler.handleMessage({ memberId: 'member-none', text: '27号\n479(小美)' })).replies.join('\n')).toContain('还没绑定');
});

it('rejects a manager target for another store and keeps the utterance on the unified path', async () => {
  const world = salon();
  await seed(world);
  const set = await world.handler.handleMessage({ memberId: world.people.manager.memberId, text: '这个月小美目标 3 万' });
  expect(set.modelCalled).toBe(false);
  expect(set.entry).toBe('unified');
  expect((await world.store.getTarget('store-ming', 'person-mei', '2026-10'))?.amount).toBe(30000);
  const blocked = await world.handler.handleMessage({ memberId: world.people.manager.memberId, text: '这个月小娟目标 1 万' });
  expect(blocked.replies.join('\n')).toContain('不会猜');
  expect(await world.store.getTarget('store-tian', 'person-juan', '2026-10')).toBeNull();
  const marketing = person({ personId: 'person-only', accountId: 'acct-only', memberId: 'member-only', displayName: '小文案', storeId: 'store-ming', storeName: '明川店', tier: 'employee', roles: ['marketing'] });
  await world.store.savePerson(marketing);
  world.modelCalls.length = 0;
  const chat = await world.handler.handleMessage({ memberId: marketing.memberId, text: '帮我写一条朋友圈' });
  expect(chat.entry).toBe('unified');
  expect(world.modelCalls[0]?.chosenRole).toBeNull();
  expect(world.modelCalls[0]?.skills.map(skill => skill.key)).toEqual(['marketing']);
});
