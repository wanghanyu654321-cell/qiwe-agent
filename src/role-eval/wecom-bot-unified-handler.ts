import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { WorkbenchRole } from './workbench-access.js';
import {
  appointmentLineId, confirmEntryId, type Appointment, type AppointmentPayload, type Draft, type EntryPatch, type LedgerEntry, type MissingItem, type Notification, type Person, type ReportDraftItem, type ReportPayload,
} from './performance-store.js';
import type { PerformanceStore } from './performance-store.js';
import { matchPerson } from './people-match.js';
import { parseAppointmentUtterance, stagePendingAppointment, validateAppointmentFields, type AppointmentRequest } from './appointments.js';
import { parseEntryLine, parseReportText, validateReportFields, type ParsedReport } from './report-parse.js';
import {
  businessDate, DEFAULT_BUSINESS_CUTOFF, DEFAULT_TIME_ZONE, monthKey, REMINDER_DELAY_MS, shiftMonth, zonedDateTime,
} from './metrics.js';
import { customerAmount, formatDay, scrubReply } from './reply.js';
import { FRONT_CLAW, skillsFor, type AssistantSkill, type AssistantToolName } from './assistant-skills.js';
import { distinctStores, createAssistantTools } from './assistant-tools.js';
import { isClosedCommand, matchExactTool, parseTargetUtterance, validateTargetFields } from './assistant-commands.js';

export interface ModelInput {
  assistant: 'Front Claw';
  chosenRole: null;
  skills: AssistantSkill[];
  allowedTools: string[];
  text: string;
  signal: AbortSignal;
  deadline: number;
}
export type ModelOutput = { type: 'chat'; text: string } | { type: 'tool'; name: string; fields: Record<string, unknown> };
export type SendResult = 'sent' | 'not_sent' | 'unknown';

export interface WecomBotHandlerOptions {
  mode: 'isolated-synthetic';
  store: PerformanceStore;
  now: () => Date;
  cutoff?: string;
  timeZone?: string;
  resolve: (memberId: string) => Promise<Person | null>;
  send: (input: { toPersonId: string; text: string }) => Promise<SendResult>;
  model: { complete(input: ModelInput): Promise<ModelOutput> };
  onOutbound?: (text: string) => void;
}

export interface HandleResult { entry: 'unified'; replies: string[]; modelCalled: boolean; ledgerSettled?: boolean; }

const ASK = `${FRONT_CLAW}：这句还缺日期、金额或员工，请补全后再发。我不会猜。`;
const UNBOUND = `${FRONT_CLAW}：还没绑定你的身份，我先不办。请让管理员绑定后再发。`;
const CLOSED = `${FRONT_CLAW}：导出和文件还没开放。`;

type DraftCommand =
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'edit'; index: number; rest: string }
  | { type: 'remove'; index: number }
  | { type: 'pick'; index: number; name: string };

function draftCommand(text: string): DraftCommand | null {
  const trimmed = text.trim();
  if (trimmed === '全部确认' || trimmed === '对') return { type: 'confirm' };
  if (trimmed === '取消') return { type: 'cancel' };
  const edit = /^改\s*(\d+)\s*(.*)$/.exec(trimmed);
  if (edit?.[1]) return { type: 'edit', index: Number(edit[1]), rest: (edit[2] ?? '').trim() };
  const remove = /^删\s*(\d+)$/.exec(trimmed);
  if (remove?.[1]) return { type: 'remove', index: Number(remove[1]) };
  const pick = /^(\d+)\s*是\s*(\S+)$/.exec(trimmed);
  if (pick?.[1] && pick[2]) return { type: 'pick', index: Number(pick[1]), name: pick[2] };
  return null;
}

function toolsFor(tier: Person['tier']): AssistantToolName[] {
  const employee: AssistantToolName[] = ['report_numbers', 'my_progress', 'submit_appointment'];
  if (tier === 'employee') return employee;
  const manager: AssistantToolName[] = [...employee, 'get_summary', 'unreported', 'set_target', 'confirm_appointment'];
  if (tier === 'manager') return manager;
  return [...manager, 'stores_ranking'];
}

function proposedKey(item: ReportDraftItem): string {
  return `${item.customer ?? ''}|${item.amount}|${item.employeeId ?? `raw:${item.employeeName}`}|${item.note}`;
}
function recordedKey(entry: LedgerEntry): string {
  return `${entry.customerName ?? ''}|${entry.amount}|${entry.ownerPersonId}|${entry.note}`;
}

export function diffReport(recorded: readonly LedgerEntry[], incoming: readonly ReportDraftItem[]): { added: ReportDraftItem[]; missing: MissingItem[]; skipped: number } {
  const pool = recorded.map(entry => ({ entry, used: false }));
  const added: ReportDraftItem[] = [];
  for (const item of incoming) {
    const key = proposedKey(item);
    const hit = pool.find(row => !row.used && recordedKey(row.entry) === key);
    if (hit) hit.used = true;
    else added.push({ ...item });
  }
  return {
    added,
    missing: pool.filter(row => !row.used).map(row => ({
      entryId: row.entry.entryId,
      customer: row.entry.customerName,
      amount: row.entry.amount,
      employeeName: row.entry.ownerName,
      note: row.entry.note,
    })),
    skipped: pool.filter(row => row.used).length,
  };
}

function echoReport(storeName: string, businessDay: string, added: readonly ReportDraftItem[], missing: readonly MissingItem[], skipped: number): string {
  const lines = [`${FRONT_CLAW} 还没入账，${formatDay(businessDay)} ${storeName}：`];
  if (!added.length) lines.push('没有新的业绩。');
  added.forEach((item, index) => {
    const flag = item.employeeId ? '' : `，员工「${item.employeeName}」对不上，回复「${index + 1} 是姓名」`;
    lines.push(`${index + 1}. ${customerAmount(item.customer, item.amount, item.employeeName, item.note)}${flag}`);
  });
  if (skipped) lines.push(`已记下的 ${skipped} 笔先跳过。`);
  if (missing.length) {
    lines.push('这次没出现，先不删：');
    missing.forEach((item, index) => lines.push(`${index + 1}. ${customerAmount(item.customer, item.amount, item.employeeName, item.note)}`));
    lines.push('要删回复「删 1」。');
  }
  if (added.some(item => !item.employeeId)) lines.push('对上员工后再回复「对」。');
  else if (added.length) lines.push('回复「全部确认」或「对」。改一笔回复「改 3」。');
  return lines.join('\n');
}

function echoAppointment(items: readonly AppointmentRequest[]): string {
  const lines = [`${FRONT_CLAW} 预约还没提交：`];
  items.forEach((item, index) => lines.push(`${index + 1}. ${item.customer} ${item.whenText}${item.note ? ` ${item.note}` : ''}`));
  lines.push('回复「全部确认」或「对」。');
  return lines.join('\n');
}

export function createWecomBotHandler(options: WecomBotHandlerOptions) {
  if (options.mode !== 'isolated-synthetic') throw Error('invalid_bot_catalog');
  const cutoff = options.cutoff ?? DEFAULT_BUSINESS_CUTOFF;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const tools = createAssistantTools({ store: options.store, now: options.now, cutoff, timeZone });
  const businessDay = () => businessDate(options.now(), cutoff, timeZone);
  const STOPPED = `${FRONT_CLAW}：这次没处理完，没有入账。请再发一次。`;
  const turn = new AsyncLocalStorage<{ signal: AbortSignal; deadline: number }>();
  const writable = () => {
    const current = turn.getStore();
    return !!current && !current.signal.aborted && performance.now() < current.deadline;
  };

  async function forbiddenTokens(): Promise<string[]> {
    const tokens = new Set<string>();
    for (const person of await options.store.listPeople()) {
      for (const token of [person.personId, person.accountId, person.memberId, person.storeId]) {
        if (token.length >= 6) tokens.add(token);
      }
    }
    return [...tokens];
  }

  async function notify(kind: Notification['kind'], personId: string, body: string, relatedId: string): Promise<SendResult> {
    const clean = scrubReply(body, await forbiddenTokens());
    const notificationId = randomUUID();
    await options.store.insertNotification({
      notificationId, kind, recipientPersonId: personId, body: clean, status: 'pending', relatedId, createdAt: options.now().toISOString(), sentAt: null,
    });
    let result: SendResult;
    try {
      const sent = await options.send({ toPersonId: personId, text: clean });
      result = sent === 'sent' || sent === 'not_sent' || sent === 'unknown' ? sent : 'unknown';
    } catch {
      result = 'unknown';
    }
    try {
      await options.store.updateNotificationStatus(notificationId, result, result === 'sent' ? options.now().toISOString() : null);
    } catch {
      return 'unknown';
    }
    return result;
  }

  async function fresh(accountId: string): Promise<Person | null> {
    const person = await options.store.getPersonByAccount(accountId);
    return person?.active ? person : null;
  }

  async function pushManagers(storeId: string, actorId: string, kind: Notification['kind'], body: string, relatedId: string): Promise<SendResult> {
    const managers = (await options.store.listPeople()).filter(person => person.active && person.storeId === storeId && (person.tier === 'manager' || person.tier === 'owner'));
    const others = managers.filter(person => person.personId !== actorId);
    const targets = others.length ? others : managers;
    if (!targets.length) return 'not_sent';
    let worst: SendResult = 'sent';
    for (const manager of targets) {
      const result = await notify(kind, manager.personId, body, relatedId);
      if (result === 'unknown') worst = 'unknown';
      else if (result === 'not_sent' && worst === 'sent') worst = 'not_sent';
    }
    return worst;
  }

  function noticeState(result: SendResult): 'sent' | 'unknown' | 'none' {
    if (result === 'sent') return 'sent';
    if (result === 'unknown') return 'unknown';
    return 'none';
  }

  function entriesFromDraft(draft: Draft): LedgerEntry[] {
    if (draft.payload.type !== 'report') return [];
    const base = Date.parse(draft.createdAt);
    return draft.payload.added.flatMap((item, index) => {
      if (!item.employeeId) return [];
      return [{
        entryId: confirmEntryId(draft.draftId, index),
        storeId: draft.storeId,
        businessDay: draft.businessDay,
        customerName: item.customer,
        amount: item.amount,
        amountType: '业绩' as const,
        ownerPersonId: item.employeeId,
        ownerName: item.employeeName,
        reporterPersonId: draft.reporterPersonId,
        note: item.note,
        status: 'recorded' as const,
        disputed: false,
        createdAt: new Date(base + index).toISOString(),
      }];
    });
  }

  async function finishClaimed(draft: Draft): Promise<string> {
    if (draft.payload.type !== 'report') return `${FRONT_CLAW}：这张不是报数。`;
    const { added, missing, skipped } = draft.payload;
    const next: Draft = missing.length
      ? { ...draft, payload: { type: 'report', added: [], missing, skipped: skipped + added.length }, status: 'pending', closedAt: null }
      : { ...draft, status: 'confirmed', closedAt: options.now().toISOString() };
    await options.store.commitConfirmingDraft(next, entriesFromDraft(draft));
    if (missing.length) return `${FRONT_CLAW}：已入账 ${added.length} 笔。没出现的先不删。`;
    return `${FRONT_CLAW}：已入账 ${added.filter(item => item.employeeId).length} 笔。`;
  }

  function appointmentsFromDraft(draft: Draft): Appointment[] {
    if (draft.payload.type !== 'appointment') return [];
    const base = Date.parse(draft.createdAt);
    return draft.payload.items.map((item, index) => stagePendingAppointment({
      ...item,
      appointmentId: appointmentLineId(draft.draftId, index),
      storeId: draft.storeId,
      employeePersonId: draft.reporterPersonId,
      createdAt: new Date(base + index).toISOString(),
    }));
  }

  async function finishAppointment(draft: Draft): Promise<string> {
    if (draft.payload.type !== 'appointment') return `${FRONT_CLAW}：这张不是预约。`;
    const next: Draft = { ...draft, status: 'confirmed', closedAt: options.now().toISOString() };
    const result = await options.store.commitConfirmingAppointments(next, appointmentsFromDraft(draft));
    if (result.claimed) {
      const listed = await appointmentList(draft.storeId);
      const notice = await pushManagers(draft.storeId, draft.reporterPersonId, 'appointment', listed.text, draft.draftId);
      return `${FRONT_CLAW}：预约已提交 ${result.total} 笔，等店长确认。${noticeText(notice)}`;
    }
    return `${FRONT_CLAW}：预约已提交 ${result.total} 笔，等店长确认。`;
  }

  function noticeText(result: SendResult): string {
    if (result === 'sent') return '店长通知已记录为送达。';
    if (result === 'not_sent') return '店长通知未送达。';
    return '店长通知结果未知，没有自动重发。';
  }

  async function appointmentList(storeId: string): Promise<{ text: string; ids: string[] }> {
    const pending = await options.store.listAppointments({ storeId, status: 'pending_manager' });
    const people = await options.store.listPeople();
    const ids = pending.map(item => item.appointmentId);
    for (const manager of people.filter(person => person.active && person.storeId === storeId && (person.tier === 'manager' || person.tier === 'owner'))) {
      await options.store.setConfig(`appointment-view:${manager.personId}`, JSON.stringify(ids));
    }
    const lines = [`${FRONT_CLAW} 待确认预约：`];
    pending.forEach((item, index) => {
      const employee = people.find(person => person.personId === item.employeePersonId);
      lines.push(`${index + 1}. ${employee?.displayName ?? '同事'} ${item.customerName} ${item.whenText}${item.note ? ` ${item.note}` : ''} 口令 ${item.appointmentId.slice(0, 8)}`);
    });
    lines.push('回复「确认预约 1」只确认这次看到的第1笔。');
    return { text: lines.join('\n'), ids };
  }

  async function settleConfirming(): Promise<void> {
    for (const draft of await options.store.listDrafts({ status: 'confirming' })) {
      const person = await options.store.getPerson(draft.reporterPersonId);
      if (!person?.active || person.storeId !== draft.storeId || person.personId !== draft.reporterPersonId) continue;
      if (draft.kind === 'report') await finishClaimed(draft);
      else if (draft.kind === 'appointment') await finishAppointment(draft);
    }
  }

  async function explainLedger(actor: Person): Promise<string> {
    const current = await fresh(actor.accountId);
    if (!current?.active || current.personId !== actor.personId || current.storeId !== actor.storeId) return `${FRONT_CLAW}：当前身份不能查这家店的入账。`;
    const drafts = (await options.store.listDrafts({ kind: 'report' })).filter(draft => draft.reporterPersonId === current.personId && draft.storeId === current.storeId);
    if (drafts.some(draft => draft.status === 'confirming')) return `${FRONT_CLAW}：这张还在确认中。当前身份不能代入账。`;
    const confirmed = drafts.filter(draft => draft.status === 'confirmed' && draft.payload.type === 'report').sort((left, right) => (left.closedAt ?? '').localeCompare(right.closedAt ?? ''));
    const last = confirmed[confirmed.length - 1];
    if (!last || last.payload.type !== 'report') return `${FRONT_CLAW}：没有可查的入账。`;
    const count = last.payload.added.filter(item => item.employeeId).length;
    return `${FRONT_CLAW}：最近一次已入账 ${count} 笔。`;
  }

  async function explainAppointments(actor: Person): Promise<string> {
    const current = await fresh(actor.accountId);
    if (!current?.active || current.personId !== actor.personId || current.storeId !== actor.storeId) return `${FRONT_CLAW}：当前身份不能查这家店的预约。`;
    const confirming = (await options.store.listDrafts({ status: 'confirming', kind: 'appointment' })).some(draft => draft.reporterPersonId === current.personId && draft.storeId === current.storeId);
    if (confirming) return `${FRONT_CLAW}：这张预约还在确认中。当前身份不能代提交。`;
    const rows = await options.store.listAppointments({ storeId: current.storeId, employeePersonId: current.personId });
    if (!rows.length) return `${FRONT_CLAW}：没有可查的预约。`;
    const waiting = rows.filter(row => row.status === 'pending_manager').length;
    const confirmed = rows.filter(row => row.status === 'confirmed').length;
    const drafts = (await options.store.listDrafts({ kind: 'appointment' })).filter(draft => draft.reporterPersonId === current.personId && draft.storeId === current.storeId);
    const notices = (await options.store.listNotifications()).filter(notice => notice.kind === 'appointment' && drafts.some(draft => draft.draftId === notice.relatedId));
    const latest = notices.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
    const notice = !latest ? '还没有店长通知记录。' : latest.status === 'sent' ? '店长通知已记录为送达。' : latest.status === 'not_sent' ? '店长通知未送达。' : '店长通知结果未知，没有自动重发。';
    return `${FRONT_CLAW}：预约 ${rows.length} 笔，等店长确认 ${waiting} 笔，店长已确认 ${confirmed} 笔。${notice}`;
  }

  async function settleOpenNotifications(): Promise<void> {
    for (const notice of await options.store.listNotifications()) {
      if (notice.status !== 'pending') continue;
      await options.store.updateNotificationStatus(notice.notificationId, 'unknown', null);
    }
  }

  async function runMaintenance(): Promise<void> {
    const now = options.now();
    await settleOpenNotifications();
    await settleConfirming();
    for (const draft of await options.store.listDrafts({ status: 'pending', kind: 'report' })) {
      if (Date.parse(draft.expiresAt) <= now.getTime()) {
        draft.status = 'void';
        draft.closedAt = now.toISOString();
        await options.store.saveDraft(draft);
        continue;
      }
      if (draft.reminder === 'none' && now.getTime() - Date.parse(draft.createdAt) >= REMINDER_DELAY_MS) {
        if (!await options.store.claimDraftNotice(draft.draftId, 'reminder')) continue;
        const result = await notify('reminder', draft.reporterPersonId, `${FRONT_CLAW}：报数还没确认。回复「对」就入账，要改回复「改 1」。`, draft.draftId);
        draft.reminder = noticeState(result);
        await options.store.saveDraft(draft);
      }
    }
    for (const draft of await options.store.listDrafts({ status: 'void', kind: 'report' })) {
      if (draft.voidNotice !== 'none') continue;
      if (!await options.store.claimDraftNotice(draft.draftId, 'voidNotice')) continue;
      const result = await notify('void', draft.reporterPersonId, `${FRONT_CLAW}：这张报数过了打烊还没确认，已作废。请重新报一次。`, draft.draftId);
      draft.voidNotice = noticeState(result);
      await options.store.saveDraft(draft);
    }
  }

  async function resolveItems(storeId: string, report: ParsedReport): Promise<ReportDraftItem[]> {
    const people = await options.store.listPeople();
    const aliases = await options.store.listAliases(storeId);
    return report.entries.map(entry => {
      const person = matchPerson(people, aliases, storeId, entry.employeeName);
      return {
        customer: entry.customer,
        amount: entry.amount,
        employeeName: person?.displayName ?? entry.employeeName,
        employeeId: person?.personId ?? null,
        note: entry.note,
        amountType: '业绩',
      };
    });
  }

  async function stageReport(accountId: string, report: ParsedReport): Promise<string> {
    const actor = await fresh(accountId);
    if (!actor) return UNBOUND;
    const confirming = (await options.store.listDrafts({ status: 'confirming', kind: 'report' })).find(draft => draft.reporterPersonId === actor.personId && draft.storeId === actor.storeId);
    if (confirming) {
      if (!actor.active) return `${FRONT_CLAW}：这张还在确认中。当前身份不能代入账。`;
      await finishClaimed(confirming);
    }
    const open = await options.store.getOpenDraft(actor.personId);
    if (open && open.kind === 'appointment') return `${FRONT_CLAW}：还有预约没确认。先回复「对」或「取消」。`;
    const people = await options.store.listPeople();
    let storeId = actor.storeId;
    let storeName = actor.storeName;
    if (report.storeName) {
      const matches = distinctStores(people).filter(store => store.storeName === report.storeName);
      if (matches.length !== 1) return `${FRONT_CLAW}：店名我没对上，请写本店全名。我不会猜。`;
      if (matches[0]!.storeId !== actor.storeId) return `${FRONT_CLAW}：不能代报其他门店。请让那家店的同事自己报。`;
      storeId = matches[0]!.storeId;
      storeName = matches[0]!.storeName;
    }
    const incoming = await resolveItems(storeId, report);
    const recorded = await options.store.listEntries({ storeId, businessDay: report.businessDay, reporterPersonId: actor.personId, status: 'recorded' });
    const diff = diffReport(recorded, incoming);
    if (!diff.added.length && !diff.missing.length) {
      if (open) {
        open.status = 'void';
        open.voidNotice = 'sent';
        open.closedAt = options.now().toISOString();
        await options.store.saveDraft(open);
      }
      return `${FRONT_CLAW}：这些都记过了，没有新的。`;
    }
    const submitted = businessDay();
    const draft: Draft = {
      draftId: open?.draftId ?? randomUUID(),
      reporterPersonId: actor.personId,
      storeId,
      businessDay: report.businessDay,
      expiresAt: open?.expiresAt ?? zonedDateTime(submitted, cutoff, timeZone).toISOString(),
      kind: 'report',
      payload: { type: 'report', added: diff.added, missing: diff.missing, skipped: diff.skipped },
      status: 'pending',
      reminder: open?.reminder ?? 'none',
      voidNotice: open?.voidNotice ?? 'none',
      createdAt: open?.createdAt ?? options.now().toISOString(),
      closedAt: null,
    };
    if (!writable()) return STOPPED;
    await options.store.saveDraft(draft);
    return echoReport(storeName, report.businessDay, diff.added, diff.missing, diff.skipped);
  }

  async function stageAppointment(accountId: string, item: AppointmentRequest): Promise<string> {
    const actor = await fresh(accountId);
    if (!actor) return UNBOUND;
    const confirming = (await options.store.listDrafts({ status: 'confirming', kind: 'appointment' })).find(draft => draft.reporterPersonId === actor.personId && draft.storeId === actor.storeId);
    if (confirming) {
      if (!actor.active) return `${FRONT_CLAW}：这张预约还在确认中。当前身份不能代提交。`;
      await finishAppointment(confirming);
    }
    const existing = await options.store.listAppointments({ storeId: actor.storeId, employeePersonId: actor.personId });
    const same = existing.find(row => row.customerName === item.customer && row.whenText === item.whenText);
    if (same) return same.status === 'confirmed'
      ? `${FRONT_CLAW}：${item.customer} ${item.whenText} 店长已确认，没有重复提交。`
      : `${FRONT_CLAW}：${item.customer} ${item.whenText} 已经提交过，等店长确认。没有重复提交。`;
    const open = await options.store.getOpenDraft(actor.personId);
    if (open && open.kind === 'report') return `${FRONT_CLAW}：还有一张没确认的报数。先回复「对」或「取消」。`;
    if (open?.payload.type === 'appointment' && open.payload.items.some(row => row.customer === item.customer && row.whenText === item.whenText)) {
      return `${FRONT_CLAW}：${item.customer} ${item.whenText} 已经在这张待确认预约里。`;
    }
    const items = open?.payload.type === 'appointment' ? [...open.payload.items, item] : [item];
    const submitted = businessDay();
    const draft: Draft = {
      draftId: open?.draftId ?? randomUUID(),
      reporterPersonId: actor.personId,
      storeId: actor.storeId,
      businessDay: submitted,
      expiresAt: open?.expiresAt ?? zonedDateTime(submitted, cutoff, timeZone).toISOString(),
      kind: 'appointment',
      payload: { type: 'appointment', items },
      status: 'pending',
      reminder: open?.reminder ?? 'none',
      voidNotice: 'sent',
      createdAt: open?.createdAt ?? options.now().toISOString(),
      closedAt: null,
    };
    if (!writable()) return STOPPED;
    await options.store.saveDraft(draft);
    return echoAppointment(items);
  }

  async function confirmOpen(actor: Person, draft: Draft): Promise<string> {
    const current = await fresh(actor.accountId);
    if (!current) return UNBOUND;
    if (current.storeId !== draft.storeId) return `${FRONT_CLAW}：你已经不在这家店，这张不能入账。`;
    if (draft.payload.type === 'report' && draft.payload.added.some(item => !item.employeeId)) return `${FRONT_CLAW}：还有员工没对上，回复「1 是姓名」。我不会猜。`;
    if (draft.payload.type === 'report' && !draft.payload.added.length) return `${FRONT_CLAW}：没有要入账的新业绩。没出现的先不删。`;
    if (!writable()) return STOPPED;
    const claimed = await options.store.claimPendingDraft(draft.draftId);
    if (!claimed) {
      const currentDraft = await options.store.getDraft(draft.draftId);
      if (currentDraft && currentDraft.storeId === current.storeId && (currentDraft.status === 'confirming' || currentDraft.status === 'confirmed')) {
        if (currentDraft.payload.type === 'appointment') {
          if (currentDraft.status === 'confirming') {
            const submitted = await finishAppointment(currentDraft);
            return submitted.includes('没有重复') ? submitted : `${submitted}没有重复提交。`;
          }
          return `${FRONT_CLAW}：预约已提交 ${currentDraft.payload.items.length} 笔，等店长确认。没有重复提交。`;
        }
        if (currentDraft.payload.type === 'report') {
          if (currentDraft.status === 'confirming') await finishClaimed(currentDraft);
          const count = currentDraft.payload.added.filter(item => item.employeeId).length;
          return `${FRONT_CLAW}：已入账 ${count} 笔。没有重复入账。`;
        }
      }
      return `${FRONT_CLAW}：这张已经处理过，没有重复入账。`;
    }
    if (claimed.payload.type === 'appointment') return finishAppointment(claimed);
    return finishClaimed(claimed);
  }

  async function viewedAppointmentIds(personId: string): Promise<string[] | null> {
    const raw = await options.store.getConfig(`appointment-view:${personId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) return null;
      return parsed as string[];
    } catch { return null; }
  }

  async function managerConfirm(actor: Person, selection: { index?: number; token?: string }): Promise<string> {
    const current = await fresh(actor.accountId);
    if (!current || (current.tier !== 'manager' && current.tier !== 'owner')) return `${FRONT_CLAW}：这个只有店长能确认。`;
    const viewed = await viewedAppointmentIds(current.personId);
    const inStore = await options.store.listAppointments({ storeId: current.storeId });
    let appointmentId: string | undefined;
    if (selection.token) {
      const token = selection.token.toLowerCase();
      const matches = inStore.filter(row => row.appointmentId.startsWith(token));
      if (matches.length !== 1) return `${FRONT_CLAW}：这个口令对不上你看到的一笔预约。请发送「预约列表」。我不会猜下一笔。`;
      appointmentId = matches[0]!.appointmentId;
      if (selection.index && viewed?.[selection.index - 1] !== appointmentId) return `${FRONT_CLAW}：列表已经变了。请发送「预约列表」再确认。我不会猜下一笔。`;
    } else if (selection.index) {
      appointmentId = viewed?.[selection.index - 1];
      if (!appointmentId) return `${FRONT_CLAW}：还没有你看过的这一笔。请发送「预约列表」。我不会猜下一笔。`;
    } else return `${FRONT_CLAW}：要确认哪一笔？请发送「预约列表」。`;
    const chosen = inStore.find(row => row.appointmentId === appointmentId);
    if (!chosen || chosen.storeId !== current.storeId) return `${FRONT_CLAW}：这一笔不在你现在的门店。请发送「预约列表」。我不会猜下一笔。`;
    if (chosen.status === 'confirmed') return `${FRONT_CLAW}：${chosen.customerName}的预约已经确认过。请发送「预约列表」查看还没确认的。我不会确认下一笔。`;
    const outcome = await options.store.confirmPendingAppointment(chosen.appointmentId);
    if (outcome === 'already') return `${FRONT_CLAW}：${chosen.customerName}的预约已经确认过。请发送「预约列表」查看还没确认的。我不会确认下一笔。`;
    if (outcome !== 'confirmed') return `${FRONT_CLAW}：这一笔已经不在。请发送「预约列表」。我不会猜下一笔。`;
    const told = await notify('appointment_confirmed', chosen.employeePersonId, `${FRONT_CLAW}：店长已确认${chosen.customerName}的预约，请告诉顾客。`, chosen.appointmentId);
    return `${FRONT_CLAW}：已确认${chosen.customerName}的预约。${told === 'sent' ? '已通知预约人。' : told === 'not_sent' ? '预约人通知未送达。' : '预约人通知结果未知，没有自动重发。'}`;
  }

  async function correctable(actor: Person): Promise<LedgerEntry[]> {
    const entries = await options.store.listEntries({ storeId: actor.storeId, businessDay: businessDay(), status: 'recorded' });
    return entries.filter(entry => actor.tier !== 'employee' || entry.ownerPersonId === actor.personId || entry.reporterPersonId === actor.personId);
  }

  async function applyCorrection(actor: Person, index: number | null, rest: string): Promise<string> {
    const current = await fresh(actor.accountId);
    if (!current) return UNBOUND;
    const entries = await correctable(current);
    if (index === null) {
      if (!entries.length) return `${FRONT_CLAW}：没有可改的业绩。`;
      const lines = [`${FRONT_CLAW} 可改的业绩：`];
      entries.forEach((entry, entryIndex) => lines.push(`${entryIndex + 1}. ${customerAmount(entry.customerName, entry.amount, entry.ownerName, entry.note)}`));
      lines.push('回复「更正 1 900」。');
      return lines.join('\n');
    }
    if (!rest) return `${FRONT_CLAW}：第${index}笔要改成什么样？`;
    const entry = entries[index - 1];
    if (!entry) return `${FRONT_CLAW}：没有这一笔。`;
    let patch: EntryPatch;
    if (/^\d+$/.test(rest)) patch = { amount: Number(rest) };
    else {
      const parsed = parseEntryLine(rest);
      if (!parsed || parsed.length !== 1) return `${FRONT_CLAW}：这一笔我没看清，请按「顾客 金额（员工）」发。我不会猜。`;
      const line = parsed[0]!;
      const people = await options.store.listPeople();
      const aliases = await options.store.listAliases(current.storeId);
      const owner = matchPerson(people, aliases, current.storeId, line.employeeName);
      if (!owner) return `${FRONT_CLAW}：员工「${line.employeeName}」对不上，请说全名。我不会猜。`;
      patch = { customerName: line.customer, amount: line.amount, ownerPersonId: owner.personId, ownerName: owner.displayName, note: line.note };
    }
    if (patch.amount !== undefined && (!Number.isSafeInteger(patch.amount) || patch.amount <= 0)) return `${FRONT_CLAW}：金额我没看清。我不会猜。`;
    const saved = await options.store.reviseEntry(entry.entryId, patch, {
      revisionId: randomUUID(), editorPersonId: current.personId, reason: 'correction', createdAt: options.now().toISOString(),
    });
    await pushManagers(current.storeId, current.personId, 'correction', `${FRONT_CLAW}：${current.displayName}改了${saved.ownerName}的业绩，现为 ${saved.amount}。`, saved.entryId);
    return `${FRONT_CLAW}：已改好，并告诉店长。`;
  }

  async function dispute(actor: Person, index: number | null): Promise<string> {
    const current = await fresh(actor.accountId);
    if (!current) return UNBOUND;
    const entries = await options.store.listEntries({ storeId: current.storeId, businessDay: businessDay(), ownerPersonId: current.personId, status: 'recorded' });
    if (!entries.length) return `${FRONT_CLAW}：今天没有挂在你名下的业绩。`;
    if (index === null && entries.length > 1) {
      const lines = [`${FRONT_CLAW} 你名下有多笔：`];
      entries.forEach((entry, entryIndex) => lines.push(`${entryIndex + 1}. ${customerAmount(entry.customerName, entry.amount, entry.ownerName, entry.note)}`));
      lines.push('回复「不是我的 1」。');
      return lines.join('\n');
    }
    const entry = entries[(index ?? 1) - 1];
    if (!entry) return `${FRONT_CLAW}：没有这一笔。`;
    await options.store.reviseEntry(entry.entryId, { disputed: true }, {
      revisionId: randomUUID(), editorPersonId: current.personId, reason: 'not-mine', createdAt: options.now().toISOString(),
    });
    await pushManagers(current.storeId, current.personId, 'dispute', `${FRONT_CLAW}：${current.displayName}说${customerAmount(entry.customerName, entry.amount, entry.ownerName, entry.note)}不是自己的，先没删。`, entry.entryId);
    return `${FRONT_CLAW}：已告诉店长，这笔先不动。`;
  }

  async function handleDraft(actor: Person, draft: Draft, command: DraftCommand): Promise<string> {
    if (command.type === 'cancel') {
      draft.status = 'void';
      draft.voidNotice = 'sent';
      draft.closedAt = options.now().toISOString();
      await options.store.saveDraft(draft);
      return `${FRONT_CLAW}：已取消，没入账。`;
    }
    if (command.type === 'confirm') return confirmOpen(actor, draft);
    if (draft.payload.type === 'appointment') {
      const items = [...draft.payload.items];
      if (command.type === 'remove') {
        if (!items[command.index - 1]) return `${FRONT_CLAW}：没有这一笔。`;
        items.splice(command.index - 1, 1);
      } else if (command.type === 'edit') {
        if (!command.rest) return `${FRONT_CLAW}：第${command.index}笔要改成什么样？`;
        const parsed = parseAppointmentUtterance(command.rest.startsWith('预约') ? command.rest : `预约 ${command.rest}`);
        if (!parsed || !items[command.index - 1]) return `${FRONT_CLAW}：这一笔我没看清。我不会猜。`;
        items[command.index - 1] = parsed;
      } else return `${FRONT_CLAW}：这张是预约，回复「对」或「改 1」。`;
      if (!items.length) {
        draft.status = 'void';
        draft.voidNotice = 'sent';
        draft.closedAt = options.now().toISOString();
        await options.store.saveDraft(draft);
        return `${FRONT_CLAW}：预约已取消。`;
      }
      draft.payload = { type: 'appointment', items };
      await options.store.saveDraft(draft);
      return echoAppointment(items);
    }
    const payload: ReportPayload = { type: 'report', added: [...draft.payload.added], missing: [...draft.payload.missing], skipped: draft.payload.skipped };
    if (command.type === 'pick') {
      const item = payload.added[command.index - 1];
      if (!item) return `${FRONT_CLAW}：没有这一笔。`;
      const people = await options.store.listPeople();
      const aliases = await options.store.listAliases(draft.storeId);
      const person = matchPerson(people, aliases, draft.storeId, command.name);
      if (!person) return `${FRONT_CLAW}：${command.name}在本店对不上，请说全名。我不会猜。`;
      item.employeeId = person.personId;
      item.employeeName = person.displayName;
    } else if (command.type === 'edit') {
      if (!payload.added[command.index - 1]) return `${FRONT_CLAW}：没有这一笔。`;
      if (!command.rest) return `${FRONT_CLAW}：第${command.index}笔要改成什么样？把这一行发我。`;
      const parsed = parseEntryLine(command.rest);
      if (!parsed) return `${FRONT_CLAW}：这一行我没看清，请按「顾客 金额（员工）」发。我不会猜。`;
      const people = await options.store.listPeople();
      const aliases = await options.store.listAliases(draft.storeId);
      const replacement = parsed.map(entry => {
        const person = matchPerson(people, aliases, draft.storeId, entry.employeeName);
        return {
          customer: entry.customer,
          amount: entry.amount,
          employeeName: person?.displayName ?? entry.employeeName,
          employeeId: person?.personId ?? null,
          note: entry.note,
          amountType: '业绩' as const,
        };
      });
      payload.added.splice(command.index - 1, 1, ...replacement);
    } else if (command.type === 'remove') {
      const missing = payload.missing[command.index - 1];
      if (!missing) return `${FRONT_CLAW}：没有这一笔。`;
      const current = await fresh(actor.accountId);
      if (!current) return UNBOUND;
      const entry = await options.store.getEntry(missing.entryId);
      if (!entry || (current.tier === 'employee' && entry.reporterPersonId !== current.personId && entry.ownerPersonId !== current.personId)) return `${FRONT_CLAW}：这笔记不了。`;
      await options.store.reviseEntry(entry.entryId, { status: 'void' }, {
        revisionId: randomUUID(), editorPersonId: current.personId, reason: 'resend-remove', createdAt: options.now().toISOString(),
      });
      payload.missing.splice(command.index - 1, 1);
      await options.store.saveDraft({ ...draft, payload });
      await pushManagers(draft.storeId, current.personId, 'correction', `${FRONT_CLAW}：${current.displayName}删了${customerAmount(entry.customerName, entry.amount, entry.ownerName, entry.note)}。`, entry.entryId);
      return `${FRONT_CLAW}：已删，并告诉店长。`;
    }
    const storeName = (await options.store.listPeople()).find(person => person.storeId === draft.storeId)?.storeName ?? '';
    await options.store.saveDraft({ ...draft, payload });
    return echoReport(storeName, draft.businessDay, payload.added, payload.missing, payload.skipped);
  }

  async function applyModel(actor: Person, output: ModelOutput): Promise<string> {
    const current = await fresh(actor.accountId);
    if (!current) return UNBOUND;
    if (output.type === 'chat') {
      const text = output.text.trim();
      return text.startsWith(FRONT_CLAW) ? text : `${FRONT_CLAW}：${text}`;
    }
    if (!toolsFor(current.tier).includes(output.name as AssistantToolName)) return `${FRONT_CLAW}：这个我不能办。`;
    if (output.name === 'report_numbers') {
      const validated = validateReportFields(output.fields);
      if (!validated.ok) return ASK;
      return stageReport(current.accountId, validated.report);
    }
    if (output.name === 'my_progress') return (await tools.myProgress(current.accountId)).reply;
    if (output.name === 'unreported') return (await tools.unreported(current.accountId)).reply;
    if (output.name === 'stores_ranking') return (await tools.storesRanking(current.accountId)).reply;
    if (output.name === 'get_summary') return (await tools.getSummary(current.accountId)).reply;
    if (output.name === 'set_target') {
      const parsed = validateTargetFields(output.fields);
      if (!parsed.ok) return `${FRONT_CLAW}：目标没说清，请说员工和金额。我不会猜。`;
      const periodMonth = parsed.periodMonth ?? monthKey(businessDay());
      return (await tools.setTarget(current.accountId, { personName: parsed.personName, amount: parsed.amount, periodMonth })).reply;
    }
    if (output.name === 'submit_appointment') {
      const parsed = validateAppointmentFields(output.fields);
      if (!parsed.ok) return `${FRONT_CLAW}：预约没说清，请补顾客和时间。我不会猜。`;
      return stageAppointment(current.accountId, parsed.item);
    }
    if (output.name === 'confirm_appointment') {
      const index = output.fields.index;
      if (Object.keys(output.fields).some(key => key !== 'index') || typeof index !== 'number' || !Number.isInteger(index)) return `${FRONT_CLAW}：要确认哪一笔？回复「确认预约 1」。`;
      return managerConfirm(current, { index });
    }
    return `${FRONT_CLAW}：这个我不能办。`;
  }

  async function handleUnified(input: { memberId: string; text: string; signal: AbortSignal; deadline: number }, forbidden: string[]): Promise<HandleResult> {
    const replies: string[] = [];
    let modelCalled = false;
    const say = (text: string) => {
      const clean = scrubReply(text, forbidden);
      options.onOutbound?.(clean);
      replies.push(clean);
    };
    const finish = () => {
      const text = replies.join('\n');
      const ledgerSettled = /已入账|记过了|没有重复入账|预约已提交|店长已确认|没有重复提交|没有重复确认/.test(text) && !text.includes('没有入账');
      return { entry: 'unified' as const, replies, modelCalled, ...(ledgerSettled ? { ledgerSettled: true as const } : {}) };
    };
    const resolved = await options.resolve(input.memberId);
    const actor = resolved?.active ? await fresh(resolved.accountId) : null;
    if (!actor || actor.memberId !== input.memberId) {
      say(UNBOUND);
      return finish();
    }
    const text = input.text.trim();
    if (text === '入账结果') { say(await explainLedger(actor)); return finish(); }
    if (text === '预约结果') { say(await explainAppointments(actor)); return finish(); }
    if (text === '预约列表') {
      const current = await fresh(actor.accountId);
      if (!current || (current.tier !== 'manager' && current.tier !== 'owner')) { say(`${FRONT_CLAW}：预约列表只有店长能确认。`); return finish(); }
      say((await appointmentList(current.storeId)).text);
      return finish();
    }
    const openBefore = await options.store.getOpenDraft(actor.personId);
    if (!openBefore && (text === '对' || text === '全部确认')) {
      const explained = await explainLedger(actor);
      if (explained.includes('已入账')) { say(explained.replace(/。$/, '。没有重复入账。')); return finish(); }
      const booking = await explainAppointments(actor);
      if (!booking.includes('没有可查的预约')) { say(booking.includes('没有重复') ? booking : `${booking}没有重复提交。`); return finish(); }
    }
    if (!writable()) { say(STOPPED); return finish(); }
    if (isClosedCommand(text)) {
      say(CLOSED);
      return finish();
    }
    const open = await options.store.getOpenDraft(actor.personId);
    const command = open ? draftCommand(text) : null;
    if (open && command) {
      say(await handleDraft(actor, open, command));
      return finish();
    }
    if (text === '这笔不是我的') {
      say(await dispute(actor, null));
      return finish();
    }
    const disputePick = /^不是我的\s*(\d+)$/.exec(text);
    if (disputePick?.[1]) {
      say(await dispute(actor, Number(disputePick[1])));
      return finish();
    }
    if (text === '更正') {
      say(await applyCorrection(actor, null, ''));
      return finish();
    }
    const correction = /^更正\s+(\d+)(?:\s+([\s\S]+))?$/.exec(text);
    if (correction?.[1]) {
      say(await applyCorrection(actor, Number(correction[1]), (correction[2] ?? '').trim()));
      return finish();
    }
    const appointmentConfirm = /^确认预约\s+(?:(\d+)(?:\s+([0-9a-fA-F]{6,64}))?|([0-9a-fA-F]{6,64}))$/.exec(text);
    if (appointmentConfirm) {
      const index = appointmentConfirm[1] ? Number(appointmentConfirm[1]) : undefined;
      const token = appointmentConfirm[2] ?? appointmentConfirm[3];
      say(await managerConfirm(actor, { ...(index ? { index } : {}), ...(token ? { token } : {}) }));
      return finish();
    }
    const exact = matchExactTool(text);
    if (exact) {
      const current = await fresh(actor.accountId);
      if (!current) { say(UNBOUND); return finish(); }
      if (exact === 'my_progress') say((await tools.myProgress(current.accountId)).reply);
      else if (exact === 'unreported') say((await tools.unreported(current.accountId)).reply);
      else if (exact === 'stores_ranking') say((await tools.storesRanking(current.accountId)).reply);
      else say((await tools.getSummary(current.accountId, exact === 'snapshot')).reply);
      return finish();
    }
    const target = parseTargetUtterance(text);
    if (target) {
      const periodMonth = target.which === 'next' ? shiftMonth(monthKey(businessDay()), 1) : monthKey(businessDay());
      const personName = target.name || actor.displayName;
      say((await tools.setTarget(actor.accountId, { personName, amount: target.amount, periodMonth })).reply);
      return finish();
    }
    const appointment = parseAppointmentUtterance(text);
    if (appointment) {
      say(await stageAppointment(actor.accountId, appointment));
      return finish();
    }
    const parsed = parseReportText(text, businessDay());
    if (parsed.status === 'complete') {
      say(await stageReport(actor.accountId, parsed.report));
      return finish();
    }
    if (input.signal.aborted || performance.now() >= input.deadline) { say(STOPPED); return finish(); }
    say('收到，正在处理');
    modelCalled = true;
    const current = await fresh(actor.accountId);
    if (!current) { say(UNBOUND); return finish(); }
    const output = await options.model.complete({
      assistant: 'Front Claw',
      chosenRole: null,
      skills: skillsFor(current.roles),
      allowedTools: toolsFor(current.tier),
      text,
      signal: input.signal,
      deadline: input.deadline,
    });
    if (input.signal.aborted) return finish();
    if (performance.now() >= input.deadline) {
      say(`${FRONT_CLAW}：这次处理超时了，请再发一次。`);
      return finish();
    }
    say(await applyModel(current, output));
    return finish();
  }

  return {
    runMaintenance,
    async handleMessage(input: { memberId: string; text: string; signal?: AbortSignal; deadline?: number }): Promise<HandleResult> {
      const signal = input.signal ?? new AbortController().signal;
      const deadline = input.deadline ?? performance.now() + 30_000;
      const budget = { signal, deadline };
      return turn.run(budget, async () => {
        if ((signal.aborted || performance.now() >= deadline) && input.text.trim() !== '入账结果') return { entry: 'unified' as const, replies: [STOPPED], modelCalled: false };
        await runMaintenance();
        return await handleUnified({ memberId: input.memberId, text: input.text, signal, deadline }, await forbiddenTokens());
      });
    },
  };
}

export type { WorkbenchRole };
