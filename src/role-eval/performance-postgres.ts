import type {
  AliasRecord, Appointment, Draft, DraftPayload, EntryFilter, EntryPatch, LedgerEntry,
  Notification, PerformanceStore, Person, Revision, RevisionMeta, Target,
} from './performance-store.js';
import { clone } from './performance-store.js';
import type { WorkbenchRole } from './workbench-access.js';
import { PERFORMANCE_MIGRATION_SQL, PERFORMANCE_SCHEMA } from './performance-migration.js';

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

const relation = (name: string) => `${PERFORMANCE_SCHEMA}.${name}`;

export function migrationStatements(sql: string): string[] {
  return sql.replace(/--[^\n]*/g, '').split(';').map(statement => statement.trim()).filter(statement => statement.length > 0);
}

export async function migratePerformance(client: SqlClient, sql = PERFORMANCE_MIGRATION_SQL): Promise<void> {
  for (const statement of migrationStatements(sql)) {
    const compact = statement.replace(/\s+/g, ' ').trim();
    if (/^(drop|alter)\b/i.test(compact)) throw Error('migration_not_additive');
    const createsSchema = new RegExp(`^CREATE SCHEMA IF NOT EXISTS ${PERFORMANCE_SCHEMA}$`, 'i').test(compact);
    if (!createsSchema && !compact.includes(`${PERFORMANCE_SCHEMA}.`)) throw Error('migration_schema');
    await client.query(statement);
  }
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('postgres_row');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw Error('postgres_row');
}
function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw Error('postgres_row');
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function personFrom(row: Row): Person {
  const roles = JSON.parse(text(row.roles_json)) as WorkbenchRole[];
  return {
    personId: text(row.person_id),
    accountId: text(row.account_id),
    memberId: text(row.member_id),
    displayName: text(row.display_name),
    storeId: text(row.store_id),
    storeName: text(row.store_name),
    tier: text(row.tier) as Person['tier'],
    roles,
    active: bool(row.active),
  };
}

function entryFrom(row: Row): LedgerEntry {
  return {
    entryId: text(row.entry_id),
    storeId: text(row.store_id),
    businessDay: text(row.business_day),
    customerName: nullableText(row.customer_name),
    amount: integer(row.amount),
    amountType: '业绩',
    ownerPersonId: text(row.owner_person_id),
    ownerName: text(row.owner_name),
    reporterPersonId: text(row.reporter_person_id),
    note: text(row.note),
    status: text(row.status) as LedgerEntry['status'],
    disputed: bool(row.disputed),
    createdAt: text(row.created_at),
  };
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

export function createPostgresPerformanceStore(client: SqlClient): PerformanceStore {
  async function one(sql: string, params: readonly unknown[]): Promise<Row | null> {
    const { rows } = await client.query<Row>(sql, params);
    return rows[0] ?? null;
  }
  async function many(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const { rows } = await client.query<Row>(sql, params);
    return rows;
  }
  return {
    async savePerson(person) {
      await client.query(
        `INSERT INTO ${relation('performance_people')} (person_id, account_id, member_id, display_name, store_id, store_name, tier, roles_json, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (person_id) DO UPDATE SET account_id=EXCLUDED.account_id, member_id=EXCLUDED.member_id, display_name=EXCLUDED.display_name, store_id=EXCLUDED.store_id, store_name=EXCLUDED.store_name, tier=EXCLUDED.tier, roles_json=EXCLUDED.roles_json, active=EXCLUDED.active`,
        [person.personId, person.accountId, person.memberId, person.displayName, person.storeId, person.storeName, person.tier, JSON.stringify(person.roles), person.active],
      );
    },
    async getPerson(personId) {
      const row = await one(`SELECT * FROM ${relation('performance_people')} WHERE person_id=$1`, [personId]);
      return row ? personFrom(row) : null;
    },
    async getPersonByAccount(accountId) {
      const rows = await many(`SELECT * FROM ${relation('performance_people')} WHERE account_id=$1`, [accountId]);
      return rows.length === 1 ? personFrom(rows[0]!) : null;
    },
    async getPersonByMember(memberId) {
      const rows = await many(`SELECT * FROM ${relation('performance_people')} WHERE member_id=$1`, [memberId]);
      return rows.length === 1 ? personFrom(rows[0]!) : null;
    },
    async listPeople() {
      return (await many(`SELECT * FROM ${relation('performance_people')}`)).map(personFrom);
    },
    async saveAlias(alias) {
      const person = await one(`SELECT * FROM ${relation('performance_people')} WHERE person_id=$1`, [alias.personId]);
      if (!person || text(person.store_id) !== alias.storeId) throw Error('alias_person');
      await client.query(
        `INSERT INTO ${relation('performance_aliases')} (store_id, alias, person_id) VALUES ($1,$2,$3)
         ON CONFLICT (store_id, alias) DO UPDATE SET person_id=EXCLUDED.person_id`,
        [alias.storeId, alias.alias, alias.personId],
      );
    },
    async listAliases(storeId) {
      const rows = storeId === undefined
        ? await many(`SELECT * FROM ${relation('performance_aliases')}`)
        : await many(`SELECT * FROM ${relation('performance_aliases')} WHERE store_id=$1`, [storeId]);
      return rows.map(row => ({ storeId: text(row.store_id), alias: text(row.alias), personId: text(row.person_id) }));
    },
    async insertEntries(entries) {
      for (const entry of entries) {
        await client.query(
          `INSERT INTO ${relation('performance_entries')} (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [entry.entryId, entry.storeId, entry.businessDay, entry.customerName, entry.amount, entry.amountType, entry.ownerPersonId, entry.ownerName, entry.reporterPersonId, entry.note, entry.status, entry.disputed, entry.createdAt],
        );
      }
    },
    async listEntries(filter) {
      const { sql, params } = whereEntries(filter);
      const rows = await many(`SELECT * FROM ${relation('performance_entries')}${sql}`, params);
      return rows.map(entryFrom).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async getEntry(entryId) {
      const row = await one(`SELECT * FROM ${relation('performance_entries')} WHERE entry_id=$1`, [entryId]);
      return row ? entryFrom(row) : null;
    },
    async reviseEntry(entryId, patch, meta) {
      const currentRow = await one(`SELECT * FROM ${relation('performance_entries')} WHERE entry_id=$1`, [entryId]);
      if (!currentRow) throw Error('missing_entry');
      const current = entryFrom(currentRow);
      const next: LedgerEntry = { ...current, ...definedPatch(patch) };
      await client.query(
        `UPDATE ${relation('performance_entries')} SET customer_name=$1, amount=$2, owner_person_id=$3, owner_name=$4, note=$5, status=$6, disputed=$7 WHERE entry_id=$8`,
        [next.customerName, next.amount, next.ownerPersonId, next.ownerName, next.note, next.status, next.disputed, entryId],
      );
      await client.query(
        `INSERT INTO ${relation('performance_revisions')} (revision_id, entry_id, editor_person_id, before_json, after_json, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [meta.revisionId, entryId, meta.editorPersonId, JSON.stringify(current), JSON.stringify(next), meta.reason, meta.createdAt],
      );
      return clone(next);
    },
    async listRevisions(entryId) {
      const rows = await many(`SELECT * FROM ${relation('performance_revisions')} WHERE entry_id=$1`, [entryId]);
      return rows.map(row => ({
        revisionId: text(row.revision_id),
        entryId: text(row.entry_id),
        editorPersonId: text(row.editor_person_id),
        beforeJson: text(row.before_json),
        afterJson: text(row.after_json),
        reason: text(row.reason),
        createdAt: text(row.created_at),
      }));
    },
    async saveTarget(target) {
      await client.query(
        `INSERT INTO ${relation('performance_targets')} (store_id, person_id, period_month, amount, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (store_id, person_id, period_month) DO UPDATE SET amount=EXCLUDED.amount, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [target.storeId, target.personId, target.periodMonth, target.amount, target.updatedBy, target.updatedAt],
      );
    },
    async getTarget(storeId, personId, periodMonth) {
      const row = await one(`SELECT * FROM ${relation('performance_targets')} WHERE store_id=$1 AND person_id=$2 AND period_month=$3`, [storeId, personId, periodMonth]);
      return row ? targetFrom(row) : null;
    },
    async listTargets(storeId) {
      const rows = storeId === undefined
        ? await many(`SELECT * FROM ${relation('performance_targets')}`)
        : await many(`SELECT * FROM ${relation('performance_targets')} WHERE store_id=$1`, [storeId]);
      return rows.map(targetFrom);
    },
    async saveDraft(draft) {
      await client.query(
        `INSERT INTO ${relation('performance_drafts')} (draft_id, reporter_person_id, store_id, business_day, expires_at, kind, payload_json, status, reminder, void_notice, created_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (draft_id) DO UPDATE SET reporter_person_id=EXCLUDED.reporter_person_id, store_id=EXCLUDED.store_id, business_day=EXCLUDED.business_day, expires_at=EXCLUDED.expires_at, kind=EXCLUDED.kind, payload_json=EXCLUDED.payload_json, status=EXCLUDED.status, reminder=EXCLUDED.reminder, void_notice=EXCLUDED.void_notice, created_at=EXCLUDED.created_at, closed_at=EXCLUDED.closed_at`,
        [draft.draftId, draft.reporterPersonId, draft.storeId, draft.businessDay, draft.expiresAt, draft.kind, JSON.stringify(draft.payload), draft.status, draft.reminder, draft.voidNotice, draft.createdAt, draft.closedAt],
      );
    },
    async getDraft(draftId) {
      const row = await one(`SELECT * FROM ${relation('performance_drafts')} WHERE draft_id=$1`, [draftId]);
      return row ? draftFrom(row) : null;
    },
    async getOpenDraft(reporterPersonId) {
      const rows = await many(`SELECT * FROM ${relation('performance_drafts')} WHERE reporter_person_id=$1 AND status=$2`, [reporterPersonId, 'pending']);
      const last = rows[rows.length - 1];
      return last ? draftFrom(last) : null;
    },
    async listDrafts(filter) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.status !== undefined) { params.push(filter.status); clauses.push(`status=$${params.length}`); }
      if (filter?.kind !== undefined) { params.push(filter.kind); clauses.push(`kind=$${params.length}`); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return (await many(`SELECT * FROM ${relation('performance_drafts')}${where}`, params)).map(draftFrom);
    },
    async saveAppointment(appointment) {
      await client.query(
        `INSERT INTO ${relation('performance_appointments')} (appointment_id, store_id, employee_person_id, customer_name, when_text, note, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (appointment_id) DO UPDATE SET status=EXCLUDED.status`,
        [appointment.appointmentId, appointment.storeId, appointment.employeePersonId, appointment.customerName, appointment.whenText, appointment.note, appointment.status, appointment.createdAt],
      );
    },
    async listAppointments(filter) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.storeId !== undefined) { params.push(filter.storeId); clauses.push(`store_id=$${params.length}`); }
      if (filter?.status !== undefined) { params.push(filter.status); clauses.push(`status=$${params.length}`); }
      if (filter?.employeePersonId !== undefined) { params.push(filter.employeePersonId); clauses.push(`employee_person_id=$${params.length}`); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return (await many(`SELECT * FROM ${relation('performance_appointments')}${where}`, params)).map(appointmentFrom).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async insertNotification(notification) {
      await client.query(
        `INSERT INTO ${relation('performance_notifications')} (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [notification.notificationId, notification.kind, notification.recipientPersonId, notification.body, notification.status, notification.relatedId, notification.createdAt, notification.sentAt],
      );
    },
    async updateNotificationStatus(notificationId, status, sentAt) {
      const updated = await client.query(`UPDATE ${relation('performance_notifications')} SET status=$1, sent_at=$2 WHERE notification_id=$3`, [status, sentAt, notificationId]);
      if (!updated.rows.length) {
        const existing = await one(`SELECT * FROM ${relation('performance_notifications')} WHERE notification_id=$1`, [notificationId]);
        if (!existing) throw Error('missing_notification');
      }
    },
    async listNotifications() {
      return (await many(`SELECT * FROM ${relation('performance_notifications')}`)).map(notificationFrom);
    },
    async getConfig(key) {
      const row = await one(`SELECT * FROM ${relation('performance_config')} WHERE key=$1`, [key]);
      return row ? text(row.value) : null;
    },
    async setConfig(key, value) {
      await client.query(
        `INSERT INTO ${relation('performance_config')} (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
        [key, value],
      );
    },
  };
}

function whereEntries(filter: EntryFilter | undefined): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    clauses.push(`${column}=$${params.length}`);
  };
  add('store_id', filter?.storeId);
  add('business_day', filter?.businessDay);
  add('reporter_person_id', filter?.reporterPersonId);
  add('owner_person_id', filter?.ownerPersonId);
  add('status', filter?.status);
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function targetFrom(row: Row): Target {
  return {
    storeId: text(row.store_id),
    personId: text(row.person_id),
    periodMonth: text(row.period_month),
    amount: integer(row.amount),
    updatedBy: text(row.updated_by),
    updatedAt: text(row.updated_at),
  };
}

function draftFrom(row: Row): Draft {
  return {
    draftId: text(row.draft_id),
    reporterPersonId: text(row.reporter_person_id),
    storeId: text(row.store_id),
    businessDay: text(row.business_day),
    expiresAt: text(row.expires_at),
    kind: text(row.kind) as Draft['kind'],
    payload: JSON.parse(text(row.payload_json)) as DraftPayload,
    status: text(row.status) as Draft['status'],
    reminder: text(row.reminder) as Draft['reminder'],
    voidNotice: text(row.void_notice) as Draft['voidNotice'],
    createdAt: text(row.created_at),
    closedAt: nullableText(row.closed_at),
  };
}

function appointmentFrom(row: Row): Appointment {
  return {
    appointmentId: text(row.appointment_id),
    storeId: text(row.store_id),
    employeePersonId: text(row.employee_person_id),
    customerName: text(row.customer_name),
    whenText: text(row.when_text),
    note: text(row.note),
    status: text(row.status) as Appointment['status'],
    createdAt: text(row.created_at),
  };
}

function notificationFrom(row: Row): Notification {
  return {
    notificationId: text(row.notification_id),
    kind: text(row.kind) as Notification['kind'],
    recipientPersonId: text(row.recipient_person_id),
    body: text(row.body),
    status: text(row.status) as Notification['status'],
    relatedId: text(row.related_id),
    createdAt: text(row.created_at),
    sentAt: nullableText(row.sent_at),
  };
}

export type { Revision };
