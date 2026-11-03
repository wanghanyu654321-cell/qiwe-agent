/** pg 8 is CJS. Node ESM exposes Pool only on `default`; `require('pg')` exposes Pool directly. */

export interface PgPoolConstructor {
  new (config: { connectionString: string }): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; end: () => Promise<void> };
}

export function resolvePgPool(loaded: unknown): PgPoolConstructor | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): PgPoolConstructor | undefined => {
    if (depth > 4 || value === null || value === undefined || seen.has(value)) return undefined;
    if (typeof value !== 'object' && typeof value !== 'function') return undefined;
    seen.add(value);
    if (typeof value === 'function') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.Pool === 'function') return record.Pool as PgPoolConstructor;
    if ('default' in record) return walk(record.default, depth + 1);
    return undefined;
  };
  return walk(loaded, 0);
}

export async function loadPgPool(): Promise<PgPoolConstructor> {
  let Pool: PgPoolConstructor | undefined;
  try {
    Pool = resolvePgPool(await import('pg'));
  } catch {
    Pool = undefined;
  }
  if (!Pool) {
    try {
      const { createRequire } = await import('node:module');
      Pool = resolvePgPool(createRequire(import.meta.url)('pg'));
    } catch {
      Pool = undefined;
    }
  }
  if (!Pool) throw Error('FRONT_CLAW_DATABASE_UNAVAILABLE:PG_POOL');
  return Pool;
}
