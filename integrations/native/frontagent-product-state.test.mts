import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {snapshotFrontagentState, verifyFrontagentStateBoundary} from './frontagent-product-state.ts';

const selected = ['drafts', 'manager', 'shadow', 'training', 'training-runs', 'training-sessions', 'training-pi', 'training-request-ledger-20261015', 'workbook-runner'];
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontagent-state-test-'));
  const sourceRoot = path.join(root, 'source'), targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'runtime/data/db'), {recursive: true});
  const db = new DatabaseSync(path.join(sourceRoot, 'runtime/data/db/messages.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, status TEXT, password_hash TEXT);
    CREATE TABLE agent_profiles(id TEXT PRIMARY KEY, owner_user_id TEXT);
    CREATE TABLE registered_groups(jid TEXT PRIMARY KEY, folder TEXT, created_by TEXT);
    CREATE TABLE workspace_agent_profiles(group_folder TEXT, agent_profile_id TEXT);
    INSERT INTO users VALUES('original-admin','admin','active','synthetic-hash');
    INSERT INTO users VALUES('original-member','member','disabled','synthetic-other-hash');
    INSERT INTO agent_profiles VALUES('original-profile','original-admin');
    INSERT INTO registered_groups VALUES('web:original','original-group','original-admin');
    INSERT INTO workspace_agent_profiles VALUES('original-group','original-profile');`);
  const write = (relative: string, text = 'synthetic persisted state') => {
    const file = path.join(sourceRoot, relative); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text);
  };
  write('runtime/groups/original-group/CLAUDE.md');
  for (const name of selected) write(`${name}/retained.json`);
  for (const name of ['local-owner.json', 'owner-session.json', 'runtime/server.mjs', 'runtime/web/index.html', 'node_modules/secret.txt', 'logs/output.log']) write(name, 'synthetic credential or executable');
  t.after(() => {
    db.close();
    const real = fs.realpathSync(root);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(real).startsWith('frontagent-state-test-'));
    fs.rmSync(real, {recursive: true, force: true});
  });
  return {root, sourceRoot, targetRoot, db, write};
}
function hashes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) result[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(root); return result;
}

test('backs up committed WAL rows and retains original identities, relations and files without changing source', async t => {
  const f = fixture(t);
  const secondary = new DatabaseSync(path.join(f.sourceRoot, 'manager/reports.sqlite'));
  secondary.exec('PRAGMA journal_mode=WAL; CREATE TABLE reports(id TEXT); INSERT INTO reports VALUES(\'original-report\')');
  try {
    assert.ok(fs.statSync(path.join(f.sourceRoot, 'runtime/data/db/messages.db-wal')).size > 0);
    const before = hashes(f.sourceRoot);
    const result = await snapshotFrontagentState(f);
    assert.deepEqual(hashes(f.sourceRoot), before);
    const copy = new DatabaseSync(path.join(f.targetRoot, 'runtime/data/db/messages.db'), {readOnly: true});
    try {
      for (const table of ['users', 'agent_profiles', 'registered_groups', 'workspace_agent_profiles']) {
        assert.deepEqual(copy.prepare(`SELECT * FROM ${table}`).all(), f.db.prepare(`SELECT * FROM ${table}`).all());
      }
    } finally { copy.close(); }
    const reports = new DatabaseSync(path.join(f.targetRoot, 'manager/reports.sqlite'), {readOnly: true});
    try { assert.equal(reports.prepare('SELECT id FROM reports').get()?.id, 'original-report'); } finally { reports.close(); }
    for (const name of selected) assert.equal(fs.readFileSync(path.join(f.targetRoot, name, 'retained.json'), 'utf8'), 'synthetic persisted state');
    assert.equal(fs.readFileSync(path.join(f.targetRoot, 'runtime/groups/original-group/CLAUDE.md'), 'utf8'), 'synthetic persisted state');
    assert.equal(result.counts.users, 2); assert.equal(result.counts.activeAdmins, 1);
    assert.equal(result.counts.profiles, 1); assert.equal(result.counts.groups, 1); assert.equal(result.counts.databases, 2);
    assert.match(result.sourceHash, /^[a-f0-9]{64}$/); assert.match(result.targetHash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result).includes('synthetic-hash'));
    for (const name of ['local-owner.json', 'owner-session.json', 'runtime/server.mjs', 'runtime/web', 'node_modules', 'logs']) assert.equal(fs.existsSync(path.join(f.targetRoot, name)), false);
    assert.ok(Object.keys(hashes(f.targetRoot)).every(name => !/-wal$|-shm$/.test(name)));
  } finally { secondary.close(); }
});

for (const mode of ['disabled', 'missing-users', 'missing-db', 'empty-db'] as const) test(`refuses ${mode} rather than initializing an administrator`, async t => {
  const f = fixture(t);
  if (mode === 'disabled') f.db.exec("UPDATE users SET status='disabled'");
  if (mode === 'missing-users') f.db.exec('DROP TABLE users');
  if (mode === 'missing-db' || mode === 'empty-db') {
    const other = path.join(f.root, 'invalid'); fs.mkdirSync(path.join(other, 'runtime/data/db'), {recursive: true});
    if (mode === 'empty-db') fs.writeFileSync(path.join(other, 'runtime/data/db/messages.db'), '');
    f.sourceRoot = other;
  }
  const before = hashes(f.sourceRoot);
  await assert.rejects(snapshotFrontagentState(f), /state|admin|database/i);
  assert.deepEqual(hashes(f.sourceRoot), before);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'manifest.json')), false);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'runtime/data/db/messages.db')), false);
});

test('rejects overlapping or existing destinations without overwriting them', async t => {
  const f = fixture(t);
  for (const targetRoot of [f.sourceRoot, path.join(f.sourceRoot, 'copy'), f.root]) {
    await assert.rejects(snapshotFrontagentState({...f, targetRoot}), /overlap|exist|independent/i);
  }
  fs.mkdirSync(f.targetRoot); fs.writeFileSync(path.join(f.targetRoot, 'keep'), 'keep');
  await assert.rejects(snapshotFrontagentState(f), /exist/i);
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'keep'), 'utf8'), 'keep');
});

test('rejects links in selected trees and aliased source or destination ancestors', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const link = path.join(f.sourceRoot, 'drafts/escape'); fs.symlinkSync(outside, link, 'junction');
  await assert.rejects(snapshotFrontagentState(f), /link/i);
  fs.unlinkSync(link);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.sourceRoot, alias, 'junction');
  await assert.rejects(snapshotFrontagentState({...f, sourceRoot: alias}), /link/i);
  await assert.rejects(snapshotFrontagentState({...f, targetRoot: path.join(alias, 'copy')}), /link|overlap/i);
});

test('excludes only the two known dependency junctions while retaining their sibling state files', async t => {
  const f = fixture(t);
  const dependencies = path.join(f.root, 'external-dependencies');
  fs.mkdirSync(dependencies); fs.writeFileSync(path.join(dependencies, 'not-state.js'), 'synthetic dependency');
  const excluded = ['training-pi/node_modules', 'workbook-runner/node_modules'];
  for (const relative of excluded) fs.symlinkSync(dependencies, path.join(f.sourceRoot, relative), 'junction');
  const before = hashes(f.sourceRoot), dependencyBefore = hashes(dependencies);
  const result = await snapshotFrontagentState(f);
  assert.deepEqual(result.excludedDependencies, excluded);
  assert.deepEqual(hashes(f.sourceRoot), before);
  assert.deepEqual(hashes(dependencies), dependencyBefore);
  for (const relative of excluded) {
    assert.ok(fs.lstatSync(path.join(f.sourceRoot, relative)).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(f.targetRoot, relative)), false);
    assert.equal(fs.readFileSync(path.join(f.targetRoot, path.dirname(relative), 'retained.json'), 'utf8'), 'synthetic persisted state');
  }
  fs.symlinkSync(dependencies, path.join(f.sourceRoot, 'drafts/node_modules'), 'junction');
  await assert.rejects(snapshotFrontagentState({...f, targetRoot: path.join(f.root, 'second-target')}), /link/i);
});

test('rejects concurrent source changes and leaves partial target for review without a launch manifest', async t => {
  const f = fixture(t);
  const pending = snapshotFrontagentState(f);
  f.write('drafts/retained.json', 'changed while backup is asynchronous');
  await assert.rejects(pending, /changed|stable/i);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'manifest.json')), false);
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, 'drafts/retained.json'), 'utf8'), 'changed while backup is asynchronous');
});

test('startup boundary refuses a target-root junction pointing to original state', t => {
  const f = fixture(t), before = hashes(f.sourceRoot);
  fs.symlinkSync(f.sourceRoot, f.targetRoot, 'junction');
  assert.throws(() => verifyFrontagentStateBoundary(f), /link|overlap/i);
  assert.deepEqual(hashes(f.sourceRoot), before);
});

test('startup boundary refuses a nested data/db junction pointing to original state', t => {
  const f = fixture(t), before = hashes(f.sourceRoot);
  fs.mkdirSync(path.join(f.targetRoot, 'runtime/data'), {recursive: true});
  fs.symlinkSync(path.join(f.sourceRoot, 'runtime/data/db'), path.join(f.targetRoot, 'runtime/data/db'), 'junction');
  assert.throws(() => verifyFrontagentStateBoundary(f), /link/i);
  assert.deepEqual(hashes(f.sourceRoot), before);
});

test('startup boundary refuses a nested hardlink to an original state file', t => {
  const f = fixture(t), before = hashes(f.sourceRoot);
  fs.mkdirSync(path.join(f.targetRoot, 'runtime/data/nested'), {recursive: true});
  fs.linkSync(path.join(f.sourceRoot, 'drafts/retained.json'), path.join(f.targetRoot, 'runtime/data/nested/linked.json'));
  assert.throws(() => verifyFrontagentStateBoundary(f), /hard.?link/i);
  assert.deepEqual(hashes(f.sourceRoot), before);
});

for (const relative of ['training-pi/node_modules', 'workbook-runner/node_modules']) test(`startup boundary refuses restored dependency junction ${relative}`, t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.targetRoot, path.dirname(relative)), {recursive: true});
  fs.symlinkSync(f.sourceRoot, path.join(f.targetRoot, relative), 'junction');
  assert.throws(() => verifyFrontagentStateBoundary(f), /link|dependenc/i);
});

test('startup boundary accepts an existing independent snapshot after login and migration writes without changing source', async t => {
  const f = fixture(t), before = hashes(f.sourceRoot);
  await snapshotFrontagentState(f);
  const copy = new DatabaseSync(path.join(f.targetRoot, 'runtime/data/db/messages.db'));
  try { copy.exec("CREATE TABLE login_sessions(id TEXT); INSERT INTO login_sessions VALUES('new-session')"); }
  finally { copy.close(); }
  fs.writeFileSync(path.join(f.targetRoot, 'drafts/retained.json'), 'changed only in isolated copy');
  assert.doesNotThrow(() => verifyFrontagentStateBoundary(f));
  assert.deepEqual(hashes(f.sourceRoot), before);
  assert.throws(() => verifyFrontagentStateBoundary({...f, targetRoot: f.sourceRoot}), /overlap|independent/i);
  assert.throws(() => verifyFrontagentStateBoundary({...f, targetRoot: path.join(f.sourceRoot, 'runtime')}), /overlap|independent/i);
});
