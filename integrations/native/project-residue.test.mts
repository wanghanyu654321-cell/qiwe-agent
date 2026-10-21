import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { scanAppointmentBootMetadata } from '../src/appointment-boot-inventory.js';

const fixtures: string[] = [];
const originalBlockers = [
  'NON_DATABASE_RESIDUE_UNVERIFIED',
  'EXTERNAL_WRITERS_UNVERIFIED',
  'WRITER_COVERAGE_INCOMPLETE',
  'OPAQUE_RUNTIME_METADATA_UNVERIFIED',
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-project-residue-'));
  fixtures.push(root);
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  return { root, data };
}

function scan(data: string) {
  const db = new Database(':memory:');
  try { return scanAppointmentBootMetadata(db, data); }
  finally { db.close(); }
}

function assertStillBlocked(report: ReturnType<typeof scan>) {
  expect(report.safe).toBe(false);
  expect(report.complete).toBe(false);
  expect(report.blockers).toEqual(expect.arrayContaining(originalBlockers));
  expect(report.records.every(record => record.disposition === 'blocked' || record.kind === 'observation/sqlite_snapshot')).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) {
    const resolved = fs.realpathSync(root);
    expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(resolved).startsWith('qiwe-project-residue-')).toBe(true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'linux')('reports unsupported project and data residue explicitly on Windows', () => {
  const { data } = fixture();
  const report = scan(data);
  assertStillBlocked(report);
  expect(report.blockers).toContain('RESIDUE:UNSUPPORTED_ROOT');
  expect(report.records.some(record => record.kind.startsWith('residue/project/'))).toBe(false);
});

it.skipIf(process.platform !== 'linux')('observes project .env and nested config as blocked metadata without reading or exposing content', () => {
  const { root, data } = fixture();
  const env = path.join(root, '.env');
  const config = path.join(root, 'config');
  fs.mkdirSync(path.join(data, 'config'));
  fs.mkdirSync(path.join(config, 'nested'), { recursive: true });
  const nested = path.join(config, 'nested', 'mount-allowlist.json');
  const secret = 'synthetic-secret-do-not-return';
  fs.writeFileSync(env, `TOKEN=${secret}\n`);
  fs.writeFileSync(nested, `{"password":"${secret}"}`);
  const before = [fs.readFileSync(env), fs.readFileSync(nested)];
  const read = fs.readFileSync.bind(fs);
  const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === 'string' && (file === env || file === nested || file.startsWith(root + path.sep)))
      throw Error('PROJECT_CONTENT_READ');
    return (read as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync);
  let report: ReturnType<typeof scan>;
  try { report = scan(data); }
  finally { readSpy.mockRestore(); }
  assertStillBlocked(report);
  expect(report.records.map(record => record.kind)).toEqual(expect.arrayContaining([
    'residue/project/env/file',
    'residue/project/config/directory',
    'residue/project/config/file',
  ]));
  expect(report.records.find(record => record.kind === 'residue/project/config/directory')?.key)
    .not.toBe(report.records.find(record => record.kind === 'residue/config/directory')?.key);
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(JSON.stringify(report)).not.toContain(root);
  expect(JSON.stringify(report)).not.toContain('mount-allowlist.json');
  expect(fs.readFileSync(env)).toEqual(before[0]);
  expect(fs.readFileSync(nested)).toEqual(before[1]);
});

it.skipIf(process.platform !== 'linux')('records absent project entries while preserving the original data IPC coverage and key namespace', () => {
  const { data } = fixture();
  for (const relative of ['ipc/source/input/main.json', 'ipc/source/agents/agent-a/input/agent.json', 'ipc/source/tasks-run/task-a/input/task.json']) {
    const file = path.join(data, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'synthetic opaque');
  }
  const report = scan(data);
  assertStillBlocked(report);
  expect(report.records.filter(record => record.kind === 'residue/project/env/root' && record.evidence.includes('root_absent'))).toHaveLength(1);
  expect(report.records.filter(record => record.kind === 'residue/project/config/root' && record.evidence.includes('root_absent'))).toHaveLength(1);
  expect(report.records.filter(record => record.kind === 'residue/ipc/input')).toHaveLength(3);
  const oldDataKey = report.records.find(record => record.kind === 'residue/ipc/input')?.key;
  expect(oldDataKey).toMatch(/^[a-f0-9]{64}$/);
  expect(report.records.find(record => record.kind === 'residue/project/env/root')?.key).not.toBe(oldDataKey);
});

it.skipIf(process.platform !== 'linux')('refuses to infer a project root from a data directory with another name', () => {
  const { root } = fixture();
  const arbitrary = path.join(root, 'arbitrary');
  fs.mkdirSync(arbitrary);
  fs.writeFileSync(path.join(root, '.env'), 'synthetic opaque');
  const report = scan(arbitrary);
  assertStillBlocked(report);
  expect(report.blockers).toContain('RESIDUE:PROJECT_ROOT_UNVERIFIED');
  expect(report.records.some(record => record.kind.startsWith('residue/project/'))).toBe(false);
});

it.skipIf(process.platform !== 'linux')('treats project .env directory and config symlink as unsafe entries', () => {
  const { root, data } = fixture();
  fs.mkdirSync(path.join(root, '.env'));
  fs.symlinkSync(data, path.join(root, 'config'), 'dir');
  const report = scan(data);
  assertStillBlocked(report);
  expect(report.blockers).toContain('RESIDUE:UNSAFE_ENTRY');
  expect(report.records.filter(record => record.kind === 'residue/project/env/unsafe')).toHaveLength(1);
  expect(report.records.filter(record => record.kind === 'residue/project/config/unsafe')).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('blocks a project .env symlink without exposing its target or content', () => {
  const { root, data } = fixture();
  const target = path.join(root, 'synthetic-private-target');
  const secret = 'synthetic-secret-never-report';
  fs.writeFileSync(target, secret);
  fs.symlinkSync(target, path.join(root, '.env'));
  const report = scan(data);
  assertStillBlocked(report);
  expect(report.blockers).toContain('RESIDUE:UNSAFE_ENTRY');
  expect(report.records.filter(record => record.kind === 'residue/project/env/unsafe')).toHaveLength(1);
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(JSON.stringify(report)).not.toContain(target);
  expect(fs.readFileSync(target, 'utf8')).toBe(secret);
});

it.skipIf(process.platform !== 'linux')('blocks an injected project .env metadata read error', () => {
  const { root, data } = fixture();
  fs.writeFileSync(path.join(root, '.env'), 'synthetic opaque');
  const lstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
    if (String(file).endsWith('/.env'))
      throw Object.assign(Error('synthetic project metadata denial'), { code: 'EACCES' });
    return (lstat as (file: fs.PathLike, options?: unknown) => fs.BigIntStats)(file, options);
  }) as typeof fs.lstatSync);
  const report = scan(data);
  assertStillBlocked(report);
  expect(report.blockers).toContain('RESIDUE:READ_ERROR');
  expect(JSON.stringify(report)).not.toContain('synthetic project metadata denial');
  expect(report.records.some(record => record.kind === 'residue/project/env/file')).toBe(false);
});

it.skipIf(process.platform !== 'linux')('blocks a project config directory replaced after its first metadata observation', () => {
  const { root, data } = fixture();
  const config = path.join(root, 'config');
  fs.mkdirSync(config);
  const original = fs.lstatSync(config, { bigint: true });
  const lstat = fs.lstatSync.bind(fs);
  let replaced = false;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
    const stat = (lstat as (file: fs.PathLike, options?: unknown) => fs.BigIntStats)(file, options);
    if (!replaced && String(file).endsWith('/config') && stat.ino === original.ino) {
      fs.renameSync(config, path.join(root, 'config-original'));
      fs.symlinkSync(data, config, 'dir');
      replaced = true;
    }
    return stat;
  }) as typeof fs.lstatSync);
  const report = scan(data);
  assertStillBlocked(report);
  expect(replaced).toBe(true);
  expect(report.blockers).toEqual(expect.arrayContaining(['RESIDUE:UNSAFE_ENTRY']));
});

it.skipIf(process.platform !== 'linux')('blocks project config nesting beyond the existing residue depth budget', () => {
  const { root, data } = fixture();
  // A 65-level project config tree crosses the existing depth cap of 64.
  let directory = path.join(root, 'config');
  fs.mkdirSync(directory);
  for (let i = 0; i < 65; i++) {
    directory = path.join(directory, 'd');
    fs.mkdirSync(directory);
  }
  const report = scan(data);
  assertStillBlocked(report);
  expect(report.blockers).toContain('RESIDUE:BUDGET');
});
