import type { SqlClient } from '../../src/role-eval/performance-postgres.js';

type Row = Record<string, unknown>;

/** Executes the narrow SQL shape used by the Postgres store. Not a server. */
export class MemorySql implements SqlClient {
  private tables = new Map<string, Row[]>();

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE TABLE/i.test(compact)) {
      const name = /CREATE TABLE IF NOT EXISTS (\w+)/i.exec(compact)?.[1];
      if (!name) throw Error(compact);
      if (!this.tables.has(name)) this.tables.set(name, []);
      return { rows: [] };
    }
    if (/^CREATE INDEX/i.test(compact)) return { rows: [] };
    if (/^INSERT /i.test(compact)) return { rows: [this.insert(compact, params)] as T[] };
    if (/^SELECT /i.test(compact)) return { rows: this.select(compact, params) as T[] };
    if (/^UPDATE /i.test(compact)) return { rows: this.update(compact, params) as T[] };
    throw Error(`unsupported sql: ${compact}`);
  }

  private rows(table: string): Row[] {
    const found = this.tables.get(table);
    if (!found) throw Error(`missing table ${table}`);
    return found;
  }

  private insert(sql: string, params: readonly unknown[]): Row {
    const match = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)(?: ON CONFLICT \(([^)]+)\) DO UPDATE SET (.+))?$/i.exec(sql);
    if (!match || !match[1] || !match[2]) throw Error(sql);
    const table = this.rows(match[1]);
    const columns = match[2].split(',').map(column => column.trim());
    const row: Row = {};
    columns.forEach((column, index) => { row[column] = params[index]; });
    if (match[4]) {
      const keys = match[4].split(',').map(key => key.trim());
      const index = table.findIndex(existing => keys.every(key => existing[key] === row[key]));
      if (index >= 0) {
        const next = { ...table[index] };
        for (const assignment of match[5]?.matchAll(/(\w+)=EXCLUDED\.(\w+)/g) ?? []) {
          const column = assignment[1];
          const source = assignment[2];
          if (column && source) next[column] = row[source];
        }
        table[index] = next;
        return next;
      }
    }
    table.push(row);
    return row;
  }

  private select(sql: string, params: readonly unknown[]): Row[] {
    const match = /^SELECT \* FROM (\w+)(?: WHERE (.+))?$/i.exec(sql);
    if (!match?.[1]) throw Error(sql);
    const table = this.rows(match[1]);
    if (!match[2]) return table.map(row => ({ ...row }));
    return table.filter(row => this.matches(match[2]!, params, row)).map(row => ({ ...row }));
  }

  private update(sql: string, params: readonly unknown[]): Row[] {
    const match = /^UPDATE (\w+) SET (.+) WHERE (\w+)=\$(\d+)$/i.exec(sql);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) throw Error(sql);
    const table = this.rows(match[1]);
    const key = match[3];
    const expected = params[Number(match[4]) - 1];
    const updated: Row[] = [];
    for (const row of table) {
      if (row[key] !== expected) continue;
      for (const assignment of match[2].matchAll(/(\w+)=\$(\d+)/g)) {
        const column = assignment[1];
        const index = assignment[2];
        if (column && index) row[column] = params[Number(index) - 1];
      }
      updated.push({ ...row });
    }
    return updated;
  }

  private matches(where: string, params: readonly unknown[], row: Row): boolean {
    return where.split(/\s+AND\s+/i).every(clause => {
      const match = /(\w+)=\$(\d+)/.exec(clause);
      if (!match?.[1] || !match[2]) throw Error(clause);
      return row[match[1]] === params[Number(match[2]) - 1];
    });
  }
}
