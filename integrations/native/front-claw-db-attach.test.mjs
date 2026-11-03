import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectRunnerDatabaseNetwork, disconnectRunnerDatabaseNetwork, frontClawDbNetwork, loadFrontClawDatabaseEnv, withDatabaseEnvFile } from './front-claw-db-attach.mjs';

function privateFile(contents, mode = 0o600) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'front-claw-db-')), 'front-claw-db.env');
  fs.writeFileSync(file, contents, { mode });
  return file;
}

test('reads only FRONT_CLAW_DATABASE_URL from a mode 600 file and does not put it on the docker argv', () => {
  const secret = 'postgres://frontclaw:super-secret-not-logged@172.20.0.2:5432/postgres';
  const file = privateFile(`# private\nFRONT_CLAW_DATABASE_URL=${secret}\n`);
  assert.equal(loadFrontClawDatabaseEnv(file), secret);
  const args = withDatabaseEnvFile(['run', '--name=qiwe-runner', '--entrypoint=node', 'image'], file);
  assert.deepEqual(args.slice(args.indexOf('--env-file'), args.indexOf('--env-file') + 2), ['--env-file', file]);
  assert.equal(args.some(arg => String(arg).includes('super-secret-not-logged')), false);
});

test('refuses a group-readable env file and a symlink', () => {
  const loose = privateFile('FRONT_CLAW_DATABASE_URL=postgres://local/db\n', 0o644);
  assert.throws(() => loadFrontClawDatabaseEnv(loose), /FRONT_CLAW_DB_ENV_UNREADABLE/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-claw-db-link-'));
  const real = path.join(dir, 'real.env');
  fs.writeFileSync(real, 'FRONT_CLAW_DATABASE_URL=postgres://local/db\n', { mode: 0o600 });
  const link = path.join(dir, 'link.env');
  fs.symlinkSync(real, link);
  assert.throws(() => loadFrontClawDatabaseEnv(link), /FRONT_CLAW_DB_ENV_UNREADABLE/);
});

test('uses FRONT_CLAW_DB_NETWORK when the runner must join claw-wecom-pg', () => {
  const previous = process.env.FRONT_CLAW_DB_NETWORK;
  process.env.FRONT_CLAW_DB_NETWORK = 'salon-pg-net';
  try {
    const calls = [];
    connectRunnerDatabaseNetwork({ invoke: args => { calls.push(args); }, runner: 'qiwe-runner-1' });
    assert.deepEqual(calls, [['network', 'connect', 'salon-pg-net', 'qiwe-runner-1']]);
    assert.equal(frontClawDbNetwork({}), 'claw-wecom-business-isolated-20261008-r1');
  } finally {
    if (previous === undefined) delete process.env.FRONT_CLAW_DB_NETWORK;
    else process.env.FRONT_CLAW_DB_NETWORK = previous;
  }
});

test('connects the runner to the business network and disconnects it without the database url', () => {
  const calls = [];
  const invoke = args => { calls.push(args); };
  connectRunnerDatabaseNetwork({ invoke, runner: 'qiwe-runner-1' });
  disconnectRunnerDatabaseNetwork({ invoke, runner: 'qiwe-runner-1' });
  assert.deepEqual(calls, [
    ['network', 'connect', 'claw-wecom-business-isolated-20261008-r1', 'qiwe-runner-1'],
    ['network', 'disconnect', 'claw-wecom-business-isolated-20261008-r1', 'qiwe-runner-1'],
  ]);
});
