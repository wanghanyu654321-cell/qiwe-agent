import { readFileSync } from 'node:fs';
import { MemoryPerformanceStore, type PerformanceStore } from './performance-store.js';
import { PERFORMANCE_MIGRATION_PATH, PERFORMANCE_MIGRATION_SQL } from './performance-migration.js';
import { createPostgresPerformanceStore, migratePerformance, type SqlClient } from './performance-postgres.js';

/** Set this to the claw-wecom-pg connection string. Unset uses the in-memory store. */
export const FRONT_CLAW_DATABASE_URL = 'FRONT_CLAW_DATABASE_URL';

export interface OpenedPerformanceStore {
  store: PerformanceStore;
  driver: 'memory' | 'postgres';
  close(): Promise<void>;
}

/** Prefer the checked-in migration file, which startup applies as-is. */
export function readPerformanceMigration(): string {
  try {
    return readFileSync(PERFORMANCE_MIGRATION_PATH, 'utf8');
  } catch {
    return PERFORMANCE_MIGRATION_SQL;
  }
}

/**
 * Startup entry for the performance store.
 * When FRONT_CLAW_DATABASE_URL is set, opens Postgres and applies migration 007.
 * When it is missing or blank, returns the in-memory store.
 */
export async function openPerformanceStore(env: Record<string, string | undefined> = process.env): Promise<OpenedPerformanceStore> {
  const url = env[FRONT_CLAW_DATABASE_URL]?.trim() ?? '';
  if (!url) return { store: new MemoryPerformanceStore(), driver: 'memory', async close() {} };
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  const client: SqlClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const result = await pool.query(sql, params ? [...params] : []);
      return { rows: result.rows as T[] };
    },
  };
  try {
    await migratePerformance(client, readPerformanceMigration());
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    store: createPostgresPerformanceStore(client),
    driver: 'postgres',
    async close() { await pool.end(); },
  };
}
