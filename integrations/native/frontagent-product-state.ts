import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';

const stateDirectories = [
  'runtime/data', 'runtime/groups', 'drafts', 'manager', 'shadow', 'training',
  'training-runs', 'training-sessions', 'training-pi',
  'training-request-ledger-20261015', 'workbook-runner',
] as const;
const primaryDatabase = 'runtime/data/db/messages.db';
// These job-local dependency trees are not durable product state. Never follow their junctions.
const excludedDependencies = ['training-pi/node_modules', 'workbook-runner/node_modules'] as const;
type Entry = {path: string; kind: 'directory' | 'file'; hash: string; database: boolean};
export interface FrontagentStateSnapshot {
  sourceRoot: string;
  targetRoot: string;
  sourceHash: string;
  targetHash: string;
  /** Explicit copy-policy exclusions; this snapshot does not establish runner dependency readiness. */
  excludedDependencies: string[];
  counts: {files: number; directories: number; databases: number; users: number; activeAdmins: number; profiles: number; groups: number};
}

/** Recheck the writable snapshot topology before launch, without reading data or opening SQLite.
 * Content may legitimately change after login/migration. No target path receives the source-only
 * dependency exclusions: a restored dependency junction must also be refused.
 */
export function verifyFrontagentStateBoundary(options: {sourceRoot: string; targetRoot: string}): void {
  if (!path.isAbsolute(options.sourceRoot) || !path.isAbsolute(options.targetRoot)) throw new Error('State roots must be absolute independent paths');
  assertNoLinks(options.sourceRoot); assertNoLinks(options.targetRoot);
  const sourceRoot = fs.realpathSync(options.sourceRoot), targetRoot = fs.realpathSync(options.targetRoot);
  if (path.relative(path.resolve(options.targetRoot), targetRoot) !== '') throw new Error('Target state path resolves through an alias');
  if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) throw new Error('Source and target state paths overlap');
  if (!fs.lstatSync(targetRoot).isDirectory()) throw new Error('Target state root must be a directory');
  function visit(file: string): void {
    assertNoLinks(file);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Target state contains a symbolic link or junction');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error('Target state contains a hard link');
    } else throw new Error('Target state contains an unsupported file type');
  }
  visit(targetRoot);
}

function statIfPresent(file: string) {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Inspect every ancestor as well as the leaf: realpath alone silently accepts junctions.
function assertNoLinks(file: string): void {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = statIfPresent(current);
    if (stat?.isSymbolicLink()) throw new Error('State path contains a symbolic link or junction');
    if (stat && !stat.isDirectory() && current !== absolute) throw new Error('State ancestor is not a directory');
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function fileHash(file: string): string {
  assertNoLinks(file);
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('State file must be a regular file without hard links');
    let length: number;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function isDatabase(file: string): boolean {
  if (/\.(?:db|sqlite|sqlite3)$/i.test(file)) return true;
  const fd = fs.openSync(file, 'r'), header = Buffer.alloc(16);
  try { return fs.readSync(fd, header, 0, 16, 0) === 16 && header.equals(Buffer.from('SQLite format 3\0')); }
  finally { fs.closeSync(fd); }
}

function inventory(root: string, exclusions: readonly string[] = []): Entry[] {
  assertNoLinks(root);
  const entries: Entry[] = [];
  function visit(relative: string) {
    if (exclusions.includes(relative)) return;
    const absolute = path.join(root, relative);
    assertNoLinks(absolute);
    const stat = statIfPresent(absolute);
    if (!stat) return;
    if (stat.isDirectory()) {
      entries.push({path: relative, kind: 'directory', hash: '', database: false});
      for (const name of fs.readdirSync(absolute).sort()) visit(relative + '/' + name);
    } else if (stat.isFile()) {
      entries.push({path: relative, kind: 'file', hash: fileHash(absolute), database: isDatabase(absolute)});
    } else throw new Error('State contains an unsupported file type');
  }
  for (const relative of stateDirectories) {
    const stat = statIfPresent(path.join(root, relative));
    if (stat && !stat.isDirectory()) {
      assertNoLinks(path.join(root, relative));
      throw new Error('Persistent state root is not a directory');
    }
    visit(relative);
  }
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function treeHash(entries: Entry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function readDatabase(file: string): DatabaseSync {
  assertNoLinks(file);
  if (!statIfPresent(file)?.isFile() || fs.statSync(file).size === 0) throw new Error('Required state database is missing or empty');
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    db.exec('PRAGMA query_only=ON');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Invalid state database');
    return db;
  } catch { db.close(); throw new Error('Invalid state database'); }
}

function identityCounts(db: DatabaseSync) {
  try {
    const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
    const optionalCount = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? count(table) : 0;
    const activeAdmins = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'").get()?.count);
    if (activeAdmins < 1) throw new Error('No active admin');
    return {users: count('users'), activeAdmins, profiles: optionalCount('agent_profiles'), groups: optionalCount('registered_groups')};
  } catch { throw new Error('Original state requires an existing active administrator'); }
}

/** Copy only existing product state. Never initialize accounts, run source code, or publish a launch manifest.
 * The caller must keep the source quiescent. Any observed path/content change rejects the snapshot;
 * failures leave the new target for review and never remove source files. SQLite opens only the
 * private staging copies: even a readOnly SQLite connection can change the original WAL's SHM.
 */
export async function snapshotFrontagentState(options: {sourceRoot: string; targetRoot: string}): Promise<FrontagentStateSnapshot> {
  if (!path.isAbsolute(options.sourceRoot) || !path.isAbsolute(options.targetRoot)) throw new Error('State roots must be absolute independent paths');
  assertNoLinks(options.sourceRoot); assertNoLinks(options.targetRoot);
  const sourceRoot = fs.realpathSync(options.sourceRoot);
  const targetRoot = path.join(fs.realpathSync(path.dirname(options.targetRoot)), path.basename(options.targetRoot));
  if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) throw new Error('Source and target state paths overlap');
  if (statIfPresent(targetRoot)) throw new Error('Target state directory already exists');
  const before = inventory(sourceRoot, excludedDependencies), sourceHash = treeHash(before);
  if (!before.some(entry => entry.path === primaryDatabase && entry.kind === 'file')) throw new Error('Required state database is missing');
  if (!before.find(entry => entry.path === primaryDatabase)?.database || fs.statSync(path.join(sourceRoot, primaryDatabase)).size === 0) throw new Error('Required state database is empty');
  const databasePaths = new Set(before.filter(entry => entry.database).map(entry => entry.path));
  const sidecars = new Set([...databasePaths].flatMap(file => [file + '-wal', file + '-shm', file + '-journal']));
  // Unknown sidecars must not be silently dropped or treated as ordinary persistent files.
  if (before.some(entry => entry.kind === 'file' && /-(?:wal|shm|journal)$/.test(entry.path) && !sidecars.has(entry.path))) {
    throw new Error('State contains an orphan database sidecar');
  }
  assertNoLinks(targetRoot);
  fs.mkdirSync(targetRoot); // Exclusive creation; an existing destination is never merged.
  const stagingRoot = path.join(targetRoot, '.snapshot-staging');
  fs.mkdirSync(stagingRoot);
  // Byte-copy the DB and committed WAL into a private, non-runtime directory. The captured hashes
  // and final source inventory gate reject any source movement during these non-atomic reads.
  for (const entry of before.filter(item => item.database || (sidecars.has(item.path) && !item.path.endsWith('-shm')))) {
    const target = path.join(stagingRoot, entry.path);
    assertNoLinks(target);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    assertNoLinks(path.join(sourceRoot, entry.path));
    fs.copyFileSync(path.join(sourceRoot, entry.path), target, fs.constants.COPYFILE_EXCL);
    if (fileHash(target) !== entry.hash) throw new Error('Source state changed while staging database');
  }
  const primary = readDatabase(path.join(stagingRoot, primaryDatabase));
  let identities: ReturnType<typeof identityCounts>;
  try { identities = identityCounts(primary); } finally { primary.close(); }
  const copied = before.filter(entry => !sidecars.has(entry.path));
  for (const entry of copied) {
    const source = path.join(sourceRoot, entry.path), target = path.join(targetRoot, entry.path);
    assertNoLinks(source); assertNoLinks(target);
    if (entry.kind === 'directory') { fs.mkdirSync(target, {recursive: true}); continue; }
    if (!entry.database) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (fileHash(target) !== entry.hash) throw new Error('Source state changed while copying');
      continue;
    }
    const db = readDatabase(path.join(stagingRoot, entry.path));
    try {
      if (statIfPresent(target)) throw new Error('Target database already exists');
      await backup(db, target);
    } finally { db.close(); }
    // The backup inherits WAL mode. Normalize only the new target so reopening it needs no sidecars.
    assertNoLinks(target);
    const normalize = new DatabaseSync(target);
    try { normalize.exec('PRAGMA journal_mode=DELETE'); } finally { normalize.close(); }
    const check = readDatabase(target);
    try {
      if (entry.path === primaryDatabase && JSON.stringify(identityCounts(check)) !== JSON.stringify(identities)) throw new Error('Source state changed during database backup');
    } finally { check.close(); }
  }
  const after = inventory(sourceRoot, excludedDependencies);
  if (treeHash(after) !== sourceHash) throw new Error('Source state changed; snapshot is not stable');
  const targetEntries = inventory(targetRoot);
  if (targetEntries.length !== copied.length || targetEntries.some((entry, index) => {
    const original = copied[index];
    return !original || entry.path !== original.path || entry.kind !== original.kind || (!original.database && entry.hash !== original.hash);
  })) throw new Error('Target state changed or does not match the snapshot');
  // Delete only this invocation's staging tree, after checking its resolved boundary.
  assertNoLinks(stagingRoot);
  const resolvedStaging = fs.realpathSync(stagingRoot), resolvedTarget = fs.realpathSync(targetRoot);
  if (path.dirname(resolvedStaging) !== resolvedTarget || path.basename(resolvedStaging) !== '.snapshot-staging') throw new Error('Unsafe staging cleanup path');
  fs.rmSync(resolvedStaging, {recursive: true});
  if (treeHash(inventory(sourceRoot, excludedDependencies)) !== sourceHash) throw new Error('Source state changed; snapshot is not stable');
  return {
    sourceRoot, targetRoot, sourceHash, targetHash: treeHash(targetEntries),
    excludedDependencies: [...excludedDependencies],
    counts: {
      files: copied.filter(entry => entry.kind === 'file').length,
      directories: copied.filter(entry => entry.kind === 'directory').length,
      databases: databasePaths.size, ...identities,
    },
  };
}
