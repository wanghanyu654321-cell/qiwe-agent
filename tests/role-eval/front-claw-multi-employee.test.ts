import { expect, it } from 'vitest';
import { WORKBENCH_ROLES, type WorkbenchRole } from '../../src/role-eval/workbench-access.js';
import { MemoryPerformanceStore, type Person } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler, type SendResult } from '../../src/role-eval/wecom-bot-unified-handler.js';

const roles = [...WORKBENCH_ROLES] as WorkbenchRole[];

function person(fields: Pick<Person, 'personId' | 'accountId' | 'memberId' | 'displayName' | 'storeId' | 'storeName' | 'tier'>): Person {
  return { roles, active: true, ...fields };
}

function salon() {
  const store = new MemoryPerformanceStore();
  const sent: { toPersonId: string; text: string }[] = [];
  let clock = new Date('2026-10-27T10:00:00+08:00');
  const now = () => clock;
  const send = async (message: { toPersonId: string; text: string }): Promise<SendResult> => { sent.push(message); return 'sent'; };
  const handler = createWecomBotHandler({
    mode: 'isolated-synthetic', store, now, resolve: memberId => store.getPersonByMember(memberId), send,
    model: { complete: async () => ({ type: 'chat', text: 'Front Claw 在。' }) },
  });
  const ming = { storeId: 'store-ming', storeName: '明川店' };
  const tian = { storeId: 'store-tian', storeName: '天澜店' };
  const people = {
    zhou: person({ personId: 'person-zhou', accountId: 'acct-zhou', memberId: 'member-zhou', displayName: '小周', ...ming, tier: 'employee' }),
    mei: person({ personId: 'person-mei', accountId: 'acct-mei', memberId: 'member-mei', displayName: '小美', ...ming, tier: 'employee' }),
    wen: person({ personId: 'person-wen', accountId: 'acct-wen', memberId: 'member-wen', displayName: '小文', ...ming, tier: 'employee' }),
    manager: person({ personId: 'person-mgr', accountId: 'acct-mgr', memberId: 'member-mgr', displayName: '周店长', ...ming, tier: 'manager' }),
    juan: person({ personId: 'person-juan', accountId: 'acct-juan', memberId: 'member-juan', displayName: '小娟', ...tian, tier: 'employee' }),
  };
  return { store, sent, handler, people, now, setClock(value: Date) { clock = value; }, send };
}

async function seed(world: ReturnType<typeof salon>) {
  for (const member of Object.values(world.people)) await world.store.savePerson(member);
}

it('lists who has not reported, lets a colleague report for someone in the same store, and keeps other employees out', async () => {
  const world = salon();
  await seed(world);
  const staged = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '27号明川店\n李欣：888（小美）' });
  expect(staged.replies.join('\n')).toContain('小美');
  expect(await world.store.listEntries()).toEqual([]);
  const meiEarly = await world.handler.handleMessage({ memberId: world.people.mei.memberId, text: '对' });
  expect(meiEarly.replies.join('\n')).not.toContain('已入账');
  expect(await world.store.listEntries()).toEqual([]);
  expect((await world.store.getOpenDraft(world.people.zhou.personId))?.status).toBe('pending');
  const saved = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '对' });
  expect(saved.replies.join('\n')).toContain('已入账');
  const rows = await world.store.listEntries({ status: 'recorded' });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ownerPersonId: 'person-mei', reporterPersonId: 'person-zhou', amount: 888, storeId: 'store-ming' });
  await world.handler.handleMessage({ memberId: world.people.juan.memberId, text: '27号天澜店\n周娜：100（小娟）' });
  await world.handler.handleMessage({ memberId: world.people.juan.memberId, text: '对' });
  const missing = await world.handler.handleMessage({ memberId: world.people.manager.memberId, text: '今天谁没报' });
  const list = missing.replies.join('\n');
  expect(list).toContain('小周');
  expect(list).toContain('小文');
  expect(list).not.toContain('小美');
  expect(list).not.toContain('小娟');
  const employeeList = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '今天谁没报' });
  expect(employeeList.replies.join('\n')).toContain('只有店长');
  const zhou = await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '我的进度' });
  const mei = await world.handler.handleMessage({ memberId: world.people.mei.memberId, text: '我的进度' });
  expect(zhou.replies.join('\n')).not.toContain('888');
  expect(mei.replies.join('\n')).toContain('888');
  expect(await world.store.listEntries({ storeId: 'store-tian', status: 'recorded' })).toHaveLength(1);
  expect(await world.store.listEntries({ reporterPersonId: 'person-zhou' })).toHaveLength(1);
});

it('sends one reminder and one close-void notice when two assistants share the store', async () => {
  const world = salon();
  await seed(world);
  const other = createWecomBotHandler({
    mode: 'isolated-synthetic', store: world.store, now: world.now,
    resolve: memberId => world.store.getPersonByMember(memberId), send: world.send,
    model: { complete: async () => ({ type: 'chat', text: 'Front Claw 在。' }) },
  });
  await world.handler.handleMessage({ memberId: world.people.zhou.memberId, text: '27号明川店\n李秋：98（小周）' });
  world.setClock(new Date('2026-10-27T10:31:00+08:00'));
  await Promise.all([world.handler.runMaintenance(), other.runMaintenance()]);
  const reminders = (await world.store.listNotifications()).filter(row => row.kind === 'reminder');
  expect(reminders).toHaveLength(1);
  expect(world.sent.filter(message => message.text.includes('还没确认'))).toHaveLength(1);
  world.setClock(new Date('2026-10-27T23:01:00+08:00'));
  await Promise.all([world.handler.runMaintenance(), other.runMaintenance()]);
  const voids = (await world.store.listNotifications()).filter(row => row.kind === 'void');
  expect(voids).toHaveLength(1);
  expect((await world.store.getOpenDraft(world.people.zhou.personId))).toBeNull();
  expect(await world.store.listEntries({ status: 'recorded' })).toEqual([]);
});
