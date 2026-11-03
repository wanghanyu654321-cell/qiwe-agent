import { DatabaseSync } from 'node:sqlite';
import { snapshotBinding, type WecomBotBinding } from './wecom-bot-bindings.js';
import type { AliasRecord, PerformanceStore } from './performance-store.js';
import type { SqlClient } from './performance-postgres.js';
import { PERFORMANCE_SCHEMA } from './performance-migration.js';

export interface WecomBotBindingStore {
  saveBinding(binding: WecomBotBinding): Promise<void>;
  listBindings(): Promise<WecomBotBinding[]>;
}

const BINDING_TABLES = ['wecom_bot_bindings', 'bot_bindings'] as const;
const ALIAS_TABLES = ['people_aliases', 'person_aliases', 'performance_aliases'] as const;

export function createMemoryBindingStore(): WecomBotBindingStore {
  const rows: WecomBotBinding[] = [];
  return {
    async saveBinding(binding) {
      const next = snapshotBinding(binding);
      const index = rows.findIndex(row => row.botId === next.botId && row.memberId === next.memberId);
      if (index >= 0) rows[index] = next;
      else rows.push(next);
    },
    async listBindings() {
      return rows.map(row => snapshotBinding(row));
    },
  };
}

export function createPostgresBindingStore(client: SqlClient): WecomBotBindingStore {
  const table = `${PERFORMANCE_SCHEMA}.wecom_bot_bindings`;
  return {
    async saveBinding(binding) {
      const row = snapshotBinding(binding);
      await client.query(
        `INSERT INTO ${table} (bot_id, member_id, corp_id, account_id, version, active) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (bot_id, member_id) DO UPDATE SET corp_id=EXCLUDED.corp_id, account_id=EXCLUDED.account_id, version=EXCLUDED.version, active=EXCLUDED.active`,
        [row.botId, row.memberId, row.corpId, row.accountId, row.version, row.active],
      );
    },
    async listBindings() {
      const { rows } = await client.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
      return rows.map(row => snapshotBinding({
        botId: row.bot_id,
        corpId: row.corp_id,
        memberId: row.member_id,
        accountId: row.account_id,
        version: typeof row.version === 'bigint' ? Number(row.version) : row.version,
        active: row.active === true,
      }));
    },
  };
}

export interface DirectoryRows { bindings: WecomBotBinding[]; aliases: AliasRecord[]; }

function activeFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function bindingFromColumns(row: Record<string, unknown>): WecomBotBinding {
  return snapshotBinding({
    botId: row.bot_id,
    corpId: row.corp_id,
    memberId: row.member_id,
    accountId: row.account_id,
    version: typeof row.version === 'bigint' ? Number(row.version) : row.version,
    active: activeFlag(row.active),
  });
}

function aliasFromColumns(row: Record<string, unknown>): AliasRecord {
  const storeId = row.store_id ?? row.storeId;
  const alias = row.alias;
  const personId = row.person_id ?? row.personId;
  if (typeof storeId !== 'string' || typeof alias !== 'string' || typeof personId !== 'string' || !storeId || !alias || !personId || storeId.length > 120 || alias.length > 120 || personId.length > 120) throw Error('directory_row');
  return { storeId, alias, personId };
}

/** Read employee bindings and people aliases out of the base SQLite file. The file is not modified. */
export function readSqliteDirectory(file: string): DirectoryRows {
  if (typeof file !== 'string' || !file.trim() || file.includes('\u0000')) throw Error('directory_sqlite');
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true }); }
  catch { throw Error('directory_sqlite'); }
  try {
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const bindings: WecomBotBinding[] = [];
    for (const table of BINDING_TABLES) {
      if (!present.has(table)) continue;
      const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
      if (names.has('body')) {
        for (const row of db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[]) bindings.push(snapshotBinding(JSON.parse(row.body)));
      } else {
        for (const row of db.prepare(`SELECT bot_id, corp_id, member_id, account_id, version, active FROM ${table}`).all() as Record<string, unknown>[]) bindings.push(bindingFromColumns(row));
      }
    }
    const aliases: AliasRecord[] = [];
    for (const table of ALIAS_TABLES) {
      if (!present.has(table)) continue;
      const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
      if (names.has('body')) {
        for (const row of db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[]) aliases.push(aliasFromColumns(JSON.parse(row.body)));
      } else {
        for (const row of db.prepare(`SELECT store_id, alias, person_id FROM ${table}`).all() as Record<string, unknown>[]) aliases.push(aliasFromColumns(row));
      }
    }
    return { bindings, aliases };
  } finally { db.close(); }
}

export async function applyDirectoryMigration(target: { store: Pick<PerformanceStore, 'importAlias'>; bindings: WecomBotBindingStore }, rows: DirectoryRows): Promise<{ bindings: number; aliases: number }> {
  const seen = new Set((await target.bindings.listBindings()).map(row => `${row.botId}\0${row.memberId}`));
  let bindings = 0;
  for (const binding of rows.bindings) {
    const key = `${binding.botId}\0${binding.memberId}`;
    if (seen.has(key)) continue;
    await target.bindings.saveBinding(binding);
    seen.add(key);
    bindings += 1;
  }
  let aliases = 0;
  for (const alias of rows.aliases) {
    if (await target.store.importAlias(alias)) aliases += 1;
  }
  return { bindings, aliases };
}
