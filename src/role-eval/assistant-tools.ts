import type { LedgerEntry, PerformanceStore, Person, Tier } from './performance-store.js';
import { matchPerson } from './people-match.js';
import {
  businessDate, DEFAULT_BUSINESS_CUTOFF, DEFAULT_TIME_ZONE, monthKey, monthPeriod,
  QIXUN_CONFIG_KEY, qixunWindow, scoreDay, scoreMonth, scoreXun, xunPeriod, type PeriodScore,
} from './metrics.js';
import { formatAmount, formatDay, formatScore } from './reply.js';
import { FRONT_CLAW } from './assistant-skills.js';

export interface ToolDeps {
  store: PerformanceStore;
  now: () => Date;
  cutoff?: string;
  timeZone?: string;
}

export interface ProgressData {
  today: PeriodScore;
  xun: PeriodScore;
  month: PeriodScore;
  qixun: { start: string; end: string; done: number } | null;
}

export interface RankStore { storeName: string; score: PeriodScore; }

export type ToolOk<T> = { ok: true; reply: string; data: T };
export type ToolNo = { ok: false; reply: string };
export type ToolResult<T> = ToolOk<T> | ToolNo;

const MANAGER_ONLY = `${FRONT_CLAW}：这个只有店长能看。`;
const OWNER_ONLY = `${FRONT_CLAW}：这个只有老板能看。`;
const UNBOUND = `${FRONT_CLAW}：还没绑定你的身份，我先不办。请让管理员绑定后再发。`;

export function distinctStores(people: readonly Person[]): { storeId: string; storeName: string }[] {
  const names = new Map<string, string>();
  for (const person of people) names.set(person.storeId, person.storeName);
  return [...names.entries()]
    .map(([storeId, storeName]) => ({ storeId, storeName }))
    .sort((left, right) => left.storeName.localeCompare(right.storeName, 'zh'));
}

function sumBetween(entries: readonly LedgerEntry[], storeId: string, start: string, end: string, ownerId?: string): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.status !== 'recorded' || entry.storeId !== storeId) continue;
    if (entry.businessDay < start || entry.businessDay > end) continue;
    if (ownerId !== undefined && entry.ownerPersonId !== ownerId) continue;
    total += entry.amount;
  }
  return total;
}

export function formatProgress(data: ProgressData): string {
  const lines = [
    FRONT_CLAW,
    formatScore('今天', '日完成率', data.today),
    formatScore('本旬', '旬完成率', data.xun),
    formatScore('本月', '月完成率', data.month),
  ];
  if (data.qixun) lines.push(`七旬 ${formatDay(data.qixun.start)}至${formatDay(data.qixun.end)} 已做 ${formatAmount(data.qixun.done)}`);
  return lines.join('\n');
}

export function createAssistantTools(deps: ToolDeps) {
  const cutoff = deps.cutoff ?? DEFAULT_BUSINESS_CUTOFF;
  const timeZone = deps.timeZone ?? DEFAULT_TIME_ZONE;
  const today = () => businessDate(deps.now(), cutoff, timeZone);

  async function load(accountId: string): Promise<Person | null> {
    const person = await deps.store.getPersonByAccount(accountId);
    return person?.active ? person : null;
  }

  function requireTier(person: Person, allowed: readonly Tier[]): ToolNo | null {
    if (allowed.includes(person.tier)) return null;
    return { ok: false, reply: allowed.includes('manager') ? MANAGER_ONLY : OWNER_ONLY };
  }

  async function progressData(person: Person, businessDay: string): Promise<ProgressData> {
    const month = monthPeriod(businessDay);
    const xun = xunPeriod(businessDay);
    const target = await deps.store.getTarget(person.storeId, person.personId, monthKey(businessDay));
    const monthTarget = target?.amount ?? 0;
    const entries = await deps.store.listEntries({ storeId: person.storeId, ownerPersonId: person.personId, status: 'recorded' });
    const window = qixunWindow(businessDay, await deps.store.getConfig(QIXUN_CONFIG_KEY));
    return {
      today: scoreDay(sumBetween(entries, person.storeId, businessDay, businessDay, person.personId), monthTarget, businessDay),
      xun: scoreXun(sumBetween(entries, person.storeId, xun.start, businessDay, person.personId), monthTarget, businessDay),
      month: scoreMonth(sumBetween(entries, person.storeId, month.start, businessDay, person.personId), monthTarget, businessDay),
      qixun: window
        ? { start: window.start, end: window.end, done: sumBetween(entries, person.storeId, window.start, businessDay < window.end ? businessDay : window.end, person.personId) }
        : null,
    };
  }

  async function storeMonthScore(storeId: string, businessDay: string): Promise<{ score: PeriodScore; entries: LedgerEntry[] }> {
    const month = monthPeriod(businessDay);
    const targets = await deps.store.listTargets(storeId);
    const monthTarget = targets.filter(target => target.periodMonth === monthKey(businessDay)).reduce((total, target) => total + target.amount, 0);
    const entries = await deps.store.listEntries({ storeId, status: 'recorded' });
    return { score: scoreMonth(sumBetween(entries, storeId, month.start, businessDay), monthTarget, businessDay), entries };
  }

  return {
    async myProgress(accountId: string): Promise<ToolResult<ProgressData>> {
      const person = await load(accountId);
      if (!person) return { ok: false, reply: UNBOUND };
      const blocked = requireTier(person, ['employee', 'manager', 'owner']);
      if (blocked) return blocked;
      const data = await progressData(person, today());
      return { ok: true, reply: formatProgress(data), data };
    },
    async unreported(accountId: string): Promise<ToolResult<{ names: string[] }>> {
      const person = await load(accountId);
      if (!person) return { ok: false, reply: UNBOUND };
      const blocked = requireTier(person, ['manager', 'owner']);
      if (blocked) return blocked;
      const businessDay = today();
      const people = (await deps.store.listPeople()).filter(row => row.active && row.storeId === person.storeId && (row.tier === 'employee' || row.tier === 'manager'));
      const entries = await deps.store.listEntries({ storeId: person.storeId, businessDay, status: 'recorded' });
      const reported = new Set(entries.map(entry => entry.ownerPersonId));
      const names = people.filter(row => !reported.has(row.personId)).map(row => row.displayName).sort((left, right) => left.localeCompare(right, 'zh'));
      const reply = names.length ? `${FRONT_CLAW} 今天还没报：\n${names.join('\n')}` : `${FRONT_CLAW}：今天都报过了。`;
      return { ok: true, reply, data: { names } };
    },
    async storesRanking(accountId: string): Promise<ToolResult<{ stores: RankStore[] }>> {
      const person = await load(accountId);
      if (!person) return { ok: false, reply: UNBOUND };
      const blocked = requireTier(person, ['owner']);
      if (blocked) return blocked;
      const businessDay = today();
      const people = await deps.store.listPeople();
      const stores: RankStore[] = [];
      for (const store of distinctStores(people)) {
        const { score } = await storeMonthScore(store.storeId, businessDay);
        stores.push({ storeName: store.storeName, score });
      }
      stores.sort((left, right) => {
        if (left.score.status !== right.score.status) return left.score.status === '进行中' ? -1 : 1;
        return (right.score.paceRate ?? -1) - (left.score.paceRate ?? -1);
      });
      const lines = [`${FRONT_CLAW} 门店排名`];
      stores.forEach((store, index) => lines.push(formatScore(`${index + 1}. ${store.storeName}`, '月完成率', store.score)));
      return { ok: true, reply: lines.join('\n'), data: { stores } };
    },
    async getSummary(accountId: string, snapshot = false): Promise<ToolResult<{ score: PeriodScore }>> {
      const person = await load(accountId);
      if (!person) return { ok: false, reply: UNBOUND };
      const blocked = requireTier(person, ['manager', 'owner']);
      if (blocked) return blocked;
      const businessDay = today();
      const { score, entries } = await storeMonthScore(person.storeId, businessDay);
      const monthTarget = score.fullMonthTarget;
      const todayEntries = entries.filter(entry => entry.businessDay === businessDay);
      const grouped = new Map<string, number>();
      for (const entry of todayEntries) grouped.set(entry.ownerName, (grouped.get(entry.ownerName) ?? 0) + entry.amount);
      const lines = [
        `${FRONT_CLAW}${snapshot ? ' 快照' : ''} ${person.storeName}`,
        formatScore('今天', '日完成率', scoreDay(sumBetween(entries, person.storeId, businessDay, businessDay), monthTarget, businessDay)),
      ];
      for (const [name, amount] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0], 'zh'))) lines.push(`${name} ${formatAmount(amount)}`);
      lines.push(formatScore('本月', '月完成率', score));
      return { ok: true, reply: lines.join('\n'), data: { score } };
    },
    async setTarget(accountId: string, input: { personName: string; amount: number; periodMonth: string }): Promise<ToolResult<{ personName: string; amount: number; periodMonth: string }>> {
      const person = await load(accountId);
      if (!person) return { ok: false, reply: UNBOUND };
      const blocked = requireTier(person, ['manager', 'owner']);
      if (blocked) return blocked;
      if (!Number.isSafeInteger(input.amount) || input.amount < 0 || !/^\d{4}-\d{2}$/.test(input.periodMonth) || !input.personName.trim()) {
        return { ok: false, reply: `${FRONT_CLAW}：目标没说清，请说员工和金额。我不会猜。` };
      }
      const people = await deps.store.listPeople();
      const aliases = await deps.store.listAliases();
      const scope = person.tier === 'owner' ? distinctStores(people) : [{ storeId: person.storeId, storeName: person.storeName }];
      const matches: Person[] = [];
      for (const store of scope) {
        const found = matchPerson(people, aliases, store.storeId, input.personName.trim());
        if (found) matches.push(found);
      }
      if (matches.length !== 1) {
        return { ok: false, reply: matches.length ? `${FRONT_CLAW}：这个名字对上不止一位，请说全名。我不会猜。` : `${FRONT_CLAW}：没有这个人，请说全名。我不会猜。` };
      }
      const targetPerson = matches[0]!;
      if (person.tier === 'manager' && targetPerson.storeId !== person.storeId) return { ok: false, reply: `${FRONT_CLAW}：不能改其他门店的目标。` };
      await deps.store.saveTarget({
        storeId: targetPerson.storeId,
        personId: targetPerson.personId,
        periodMonth: input.periodMonth,
        amount: input.amount,
        updatedBy: person.personId,
        updatedAt: deps.now().toISOString(),
      });
      return {
        ok: true,
        reply: `${FRONT_CLAW}：已把${targetPerson.displayName} ${input.periodMonth} 目标记为 ${input.amount}。`,
        data: { personName: targetPerson.displayName, amount: input.amount, periodMonth: input.periodMonth },
      };
    },
  };
}
