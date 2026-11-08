import { createHash } from 'node:crypto';
import type { WorkbenchRole } from './workbench-access.js';

/** Stable ledger id for one confirmed draft line. A replay inserts the same row. */
export function confirmEntryId(draftId: string, index: number): string {
  return createHash('sha256').update(`front-claw-confirm\n${draftId}\n${index}`).digest('hex');
}
/** Stable id for one appointment line on an employee-confirmed draft. A replay does not create another row. */
export function appointmentLineId(draftId: string, index: number): string {
  return createHash('sha256').update(`front-claw-appointment\n${draftId}\n${index}`).digest('hex');
}

export type Tier = 'employee' | 'manager' | 'owner';

export interface Person {
  personId: string;
  accountId: string;
  memberId: string;
  displayName: string;
  storeId: string;
  storeName: string;
  tier: Tier;
  roles: WorkbenchRole[];
  active: boolean;
}

export interface AliasRecord { storeId: string; alias: string; personId: string; }

export interface LedgerEntry {
  entryId: string;
  storeId: string;
  businessDay: string;
  customerName: string | null;
  amount: number;
  amountType: '业绩';
  ownerPersonId: string;
  ownerName: string;
  reporterPersonId: string;
  note: string;
  status: 'recorded' | 'void';
  disputed: boolean;
  createdAt: string;
}

export interface EntryPatch {
  customerName?: string | null;
  amount?: number;
  ownerPersonId?: string;
  ownerName?: string;
  note?: string;
  status?: 'recorded' | 'void';
  disputed?: boolean;
}

export interface Revision {
  revisionId: string;
  entryId: string;
  editorPersonId: string;
  beforeJson: string;
  afterJson: string;
  reason: string;
  createdAt: string;
}

export interface RevisionMeta { editorPersonId: string; reason: string; createdAt: string; revisionId: string; }

export interface Target {
  storeId: string;
  personId: string;
  periodMonth: string;
  amount: number;
  updatedBy: string;
  updatedAt: string;
}

export interface ReportDraftItem {
  customer: string | null;
  amount: number;
  employeeName: string;
  employeeId: string | null;
  note: string;
  amountType: '业绩';
}

export interface MissingItem {
  entryId: string;
  customer: string | null;
  amount: number;
  employeeName: string;
  note: string;
}

export interface ReportPayload { type: 'report'; added: ReportDraftItem[]; missing: MissingItem[]; skipped: number; }
export interface AppointmentPayload { type: 'appointment'; items: { customer: string; whenText: string; note: string }[]; }
export type DraftPayload = ReportPayload | AppointmentPayload;

export interface Draft {
  draftId: string;
  reporterPersonId: string;
  storeId: string;
  businessDay: string;
  expiresAt: string;
  kind: 'report' | 'appointment';
  payload: DraftPayload;
  status: 'pending' | 'confirming' | 'confirmed' | 'void';
  reminder: 'none' | 'claimed' | 'sent' | 'unknown';
  voidNotice: 'none' | 'claimed' | 'sent' | 'unknown';
  createdAt: string;
  closedAt: string | null;
}

export interface Appointment {
  appointmentId: string;
  storeId: string;
  employeePersonId: string;
  customerName: string;
  whenText: string;
  note: string;
  status: 'pending_manager' | 'confirmed';
  createdAt: string;
}

export interface Notification {
  notificationId: string;
  kind: 'reminder' | 'void' | 'correction' | 'dispute' | 'appointment' | 'appointment_confirmed';
  recipientPersonId: string;
  body: string;
  status: 'pending' | 'sent' | 'not_sent' | 'unknown';
  relatedId: string;
  createdAt: string;
  sentAt: string | null;
}

export interface EntryFilter {
  storeId?: string;
  businessDay?: string;
  reporterPersonId?: string;
  ownerPersonId?: string;
  status?: LedgerEntry['status'];
}

export interface PerformanceStore {
  savePerson(person: Person): Promise<void>;
  getPerson(personId: string): Promise<Person | null>;
  getPersonByAccount(accountId: string): Promise<Person | null>;
  getPersonByMember(memberId: string): Promise<Person | null>;
  listPeople(): Promise<Person[]>;
  saveAlias(alias: AliasRecord): Promise<void>;
  /** Insert an alias copied from the base SQLite file. Existing store+alias rows stay. */
  importAlias(alias: AliasRecord): Promise<boolean>;
  listAliases(storeId?: string): Promise<AliasRecord[]>;
  insertEntries(entries: LedgerEntry[]): Promise<void>;
  listEntries(filter?: EntryFilter): Promise<LedgerEntry[]>;
  getEntry(entryId: string): Promise<LedgerEntry | null>;
  reviseEntry(entryId: string, patch: EntryPatch, meta: RevisionMeta): Promise<LedgerEntry>;
  listRevisions(entryId: string): Promise<Revision[]>;
  saveTarget(target: Target): Promise<void>;
  getTarget(storeId: string, personId: string, periodMonth: string): Promise<Target | null>;
  listTargets(storeId?: string): Promise<Target[]>;
  saveDraft(draft: Draft): Promise<void>;
  /** One caller wins the none -> claimed transition. A lost claim must not send. */
  claimDraftNotice(draftId: string, field: 'reminder' | 'voidNotice'): Promise<boolean>;
  /** One caller moves a pending draft to confirming. A lost claim must not insert again. */
  claimPendingDraft(draftId: string): Promise<Draft | null>;
  /**
   * Insert these entries and store the draft's next status in one step.
   * Repeating the same entry ids does not add rows. The draft update runs only while it is confirming.
   */
  commitConfirmingDraft(draft: Draft, entries: readonly LedgerEntry[]): Promise<number>;
  /**
   * Insert employee-submitted appointments and store the draft's next status.
   * Existing ids stay as they are, including a manager confirmation already recorded.
   * claimed is true only for the caller that moved the draft out of confirming.
   */
  commitConfirmingAppointments(draft: Draft, appointments: readonly Appointment[]): Promise<{ total: number; claimed: boolean }>;
  /** Move one pending_manager row to confirmed. A second call does not create a row. */
  confirmPendingAppointment(appointmentId: string): Promise<'confirmed' | 'already' | 'missing'>;
  getDraft(draftId: string): Promise<Draft | null>;
  getOpenDraft(reporterPersonId: string): Promise<Draft | null>;
  listDrafts(filter?: { status?: Draft['status']; kind?: Draft['kind'] }): Promise<Draft[]>;
  saveAppointment(appointment: Appointment): Promise<void>;
  listAppointments(filter?: { storeId?: string; status?: Appointment['status']; employeePersonId?: string }): Promise<Appointment[]>;
  insertNotification(notification: Notification): Promise<void>;
  updateNotificationStatus(notificationId: string, status: Notification['status'], sentAt: string | null): Promise<void>;
  listNotifications(): Promise<Notification[]>;
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchesEntry(entry: LedgerEntry, filter: EntryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.storeId !== undefined && entry.storeId !== filter.storeId) return false;
  if (filter.businessDay !== undefined && entry.businessDay !== filter.businessDay) return false;
  if (filter.reporterPersonId !== undefined && entry.reporterPersonId !== filter.reporterPersonId) return false;
  if (filter.ownerPersonId !== undefined && entry.ownerPersonId !== filter.ownerPersonId) return false;
  if (filter.status !== undefined && entry.status !== filter.status) return false;
  return true;
}

export class MemoryPerformanceStore implements PerformanceStore {
  private people: Person[] = [];
  private aliases: AliasRecord[] = [];
  private entries: LedgerEntry[] = [];
  private revisions: Revision[] = [];
  private targets: Target[] = [];
  private drafts: Draft[] = [];
  private appointments: Appointment[] = [];
  private notifications: Notification[] = [];
  private config = new Map<string, string>();

  async savePerson(person: Person): Promise<void> {
    const next = clone(person);
    const index = this.people.findIndex(row => row.personId === next.personId);
    if (index >= 0) this.people[index] = next;
    else this.people.push(next);
  }
  async getPerson(personId: string): Promise<Person | null> {
    return clone(this.people.find(row => row.personId === personId) ?? null);
  }
  async getPersonByAccount(accountId: string): Promise<Person | null> {
    const rows = this.people.filter(row => row.accountId === accountId);
    return rows.length === 1 ? clone(rows[0]!) : null;
  }
  async getPersonByMember(memberId: string): Promise<Person | null> {
    const rows = this.people.filter(row => row.memberId === memberId);
    return rows.length === 1 ? clone(rows[0]!) : null;
  }
  async listPeople(): Promise<Person[]> {
    return clone(this.people);
  }
  async saveAlias(alias: AliasRecord): Promise<void> {
    const person = this.people.find(row => row.personId === alias.personId);
    if (!person || person.storeId !== alias.storeId) throw Error('alias_person');
    const next = clone(alias);
    const index = this.aliases.findIndex(row => row.storeId === next.storeId && row.alias === next.alias);
    if (index >= 0) this.aliases[index] = next;
    else this.aliases.push(next);
  }
  async importAlias(alias: AliasRecord): Promise<boolean> {
    const index = this.aliases.findIndex(row => row.storeId === alias.storeId && row.alias === alias.alias);
    if (index >= 0) return false;
    this.aliases.push(clone(alias));
    return true;
  }
  async listAliases(storeId?: string): Promise<AliasRecord[]> {
    return clone(this.aliases.filter(row => storeId === undefined || row.storeId === storeId));
  }
  async insertEntries(entries: LedgerEntry[]): Promise<void> {
    for (const entry of entries) this.entries.push(clone(entry));
  }
  async listEntries(filter?: EntryFilter): Promise<LedgerEntry[]> {
    return clone(this.entries.filter(entry => matchesEntry(entry, filter)).sort(byCreated));
  }
  async getEntry(entryId: string): Promise<LedgerEntry | null> {
    return clone(this.entries.find(entry => entry.entryId === entryId) ?? null);
  }
  async reviseEntry(entryId: string, patch: EntryPatch, meta: RevisionMeta): Promise<LedgerEntry> {
    const index = this.entries.findIndex(entry => entry.entryId === entryId);
    const current = this.entries[index];
    if (!current) throw Error('missing_entry');
    const beforeJson = JSON.stringify(current);
    const next: LedgerEntry = { ...current, ...definedPatch(patch) };
    const afterJson = JSON.stringify(next);
    this.entries[index] = next;
    this.revisions.push({
      revisionId: meta.revisionId,
      entryId,
      editorPersonId: meta.editorPersonId,
      beforeJson,
      afterJson,
      reason: meta.reason,
      createdAt: meta.createdAt,
    });
    return clone(next);
  }
  async listRevisions(entryId: string): Promise<Revision[]> {
    return clone(this.revisions.filter(row => row.entryId === entryId));
  }
  async saveTarget(target: Target): Promise<void> {
    const next = clone(target);
    const index = this.targets.findIndex(row => row.storeId === next.storeId && row.personId === next.personId && row.periodMonth === next.periodMonth);
    if (index >= 0) this.targets[index] = next;
    else this.targets.push(next);
  }
  async getTarget(storeId: string, personId: string, periodMonth: string): Promise<Target | null> {
    return clone(this.targets.find(row => row.storeId === storeId && row.personId === personId && row.periodMonth === periodMonth) ?? null);
  }
  async listTargets(storeId?: string): Promise<Target[]> {
    return clone(this.targets.filter(row => storeId === undefined || row.storeId === storeId));
  }
  async saveDraft(draft: Draft): Promise<void> {
    const next = clone(draft);
    const index = this.drafts.findIndex(row => row.draftId === next.draftId);
    if (index >= 0) this.drafts[index] = next;
    else this.drafts.push(next);
  }
  async claimDraftNotice(draftId: string, field: 'reminder' | 'voidNotice'): Promise<boolean> {
    const draft = this.drafts.find(row => row.draftId === draftId);
    if (!draft || draft[field] !== 'none') return false;
    draft[field] = 'claimed';
    return true;
  }
  async claimPendingDraft(draftId: string): Promise<Draft | null> {
    const draft = this.drafts.find(row => row.draftId === draftId);
    if (!draft || draft.status !== 'pending') return null;
    draft.status = 'confirming';
    return clone(draft);
  }
  async commitConfirmingDraft(draft: Draft, entries: readonly LedgerEntry[]): Promise<number> {
    const current = this.drafts.find(row => row.draftId === draft.draftId);
    if (current?.status === 'confirming') {
      for (const entry of entries) {
        if (!this.entries.some(row => row.entryId === entry.entryId)) this.entries.push(clone(entry));
      }
      const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
      this.drafts[index] = clone(draft);
    }
    return entries.filter(entry => this.entries.some(row => row.entryId === entry.entryId)).length;
  }
  async commitConfirmingAppointments(draft: Draft, appointments: readonly Appointment[]): Promise<{ total: number; claimed: boolean }> {
    const current = this.drafts.find(row => row.draftId === draft.draftId);
    const claimed = current?.status === 'confirming';
    if (claimed) {
      for (const appointment of appointments) {
        if (!this.appointments.some(row => row.appointmentId === appointment.appointmentId)) this.appointments.push(clone(appointment));
      }
      const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
      this.drafts[index] = clone(draft);
    }
    return { total: appointments.filter(appointment => this.appointments.some(row => row.appointmentId === appointment.appointmentId)).length, claimed };
  }
  async confirmPendingAppointment(appointmentId: string): Promise<'confirmed' | 'already' | 'missing'> {
    const row = this.appointments.find(appointment => appointment.appointmentId === appointmentId);
    if (!row) return 'missing';
    if (row.status === 'confirmed') return 'already';
    if (row.status !== 'pending_manager') return 'missing';
    row.status = 'confirmed';
    return 'confirmed';
  }
  async getDraft(draftId: string): Promise<Draft | null> {
    return clone(this.drafts.find(row => row.draftId === draftId) ?? null);
  }
  async getOpenDraft(reporterPersonId: string): Promise<Draft | null> {
    const rows = this.drafts.filter(row => row.reporterPersonId === reporterPersonId && row.status === 'pending');
    return rows.length ? clone(rows[rows.length - 1]!) : null;
  }
  async listDrafts(filter?: { status?: Draft['status']; kind?: Draft['kind'] }): Promise<Draft[]> {
    return clone(this.drafts.filter(row => (filter?.status === undefined || row.status === filter.status) && (filter?.kind === undefined || row.kind === filter.kind)));
  }
  async saveAppointment(appointment: Appointment): Promise<void> {
    const next = clone(appointment);
    const index = this.appointments.findIndex(row => row.appointmentId === next.appointmentId);
    if (index >= 0) this.appointments[index] = next;
    else this.appointments.push(next);
  }
  async listAppointments(filter?: { storeId?: string; status?: Appointment['status']; employeePersonId?: string }): Promise<Appointment[]> {
    return clone(this.appointments.filter(row => {
      if (filter?.storeId !== undefined && row.storeId !== filter.storeId) return false;
      if (filter?.status !== undefined && row.status !== filter.status) return false;
      if (filter?.employeePersonId !== undefined && row.employeePersonId !== filter.employeePersonId) return false;
      return true;
    }).sort(byCreated));
  }
  async insertNotification(notification: Notification): Promise<void> {
    this.notifications.push(clone(notification));
  }
  async updateNotificationStatus(notificationId: string, status: Notification['status'], sentAt: string | null): Promise<void> {
    const row = this.notifications.find(item => item.notificationId === notificationId);
    if (!row) throw Error('missing_notification');
    row.status = status;
    row.sentAt = sentAt;
  }
  async listNotifications(): Promise<Notification[]> {
    return clone(this.notifications);
  }
  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }
  async setConfig(key: string, value: string): Promise<void> {
    this.config.set(key, value);
  }
}

function definedPatch(patch: EntryPatch): EntryPatch {
  const next: EntryPatch = {};
  if (patch.customerName !== undefined) next.customerName = patch.customerName;
  if (patch.amount !== undefined) next.amount = patch.amount;
  if (patch.ownerPersonId !== undefined) next.ownerPersonId = patch.ownerPersonId;
  if (patch.ownerName !== undefined) next.ownerName = patch.ownerName;
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.disputed !== undefined) next.disputed = patch.disputed;
  return next;
}

function byCreated(left: { createdAt: string; entryId?: string; appointmentId?: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}
