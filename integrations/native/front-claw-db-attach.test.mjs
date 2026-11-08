import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectRunnerDatabaseNetwork, describeFrontClawLaunch, describeRepositoryLaunchPath, disconnectRunnerDatabaseNetwork, frontClawDatabaseEnvFile, frontClawDbNetwork, FRONT_CLAW_DB_ENV_FILE, loadFrontClawDatabaseEnv, withDatabaseEnvFile } from './front-claw-db-attach.mjs';

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

test('describes the launch without copying the database url', () => {
  const secret = 'postgres://frontclaw:super-secret-not-logged@172.20.0.2:5432/postgres';
  const described = describeFrontClawLaunch({ FRONT_CLAW_DATABASE_URL: secret, FRONT_CLAW_DATABASE_HOST: 'claw-wecom-pg', FRONT_CLAW_DB_NETWORK: 'salon-pg-net' });
  assert.equal(described.databaseUrl, 'set');
  assert.equal(described.databaseHost, 'set');
  assert.equal(described.network, 'salon-pg-net');
  assert.equal(described.ledgerOpenedInPilotProcess, true);
  assert.equal(described.externalShellInspected, false);
  assert.equal(JSON.stringify(described).includes('super-secret-not-logged'), false);
  const empty = describeFrontClawLaunch({});
  assert.equal(empty.databaseUrl, 'unset');
  assert.equal(empty.dockerCliReadsEnvFile, false);
  assert.equal(empty.envFileOpenedBy, 'docker-cli-client');
  assert.equal(empty.bindSourceOpenedBy, 'daemon');
  const file = privateFile(`FRONT_CLAW_DATABASE_URL=${secret}\n`);
  const fromFile = describeFrontClawLaunch({ FRONT_CLAW_DB_ENV_FILE: file });
  assert.equal(fromFile.envFile, 'present');
  assert.equal(fromFile.dockerCliReadsEnvFile, true);
  assert.equal(fromFile.databaseUrl, 'unset');
  assert.equal(JSON.stringify(fromFile).includes('super-secret-not-logged'), false);
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

test('records that the live entry is a generated copy and this file does not pass the database url', () => {
  const described = describeRepositoryLaunchPath(['integrations/native/verify-full-host.mjs', '--controlled-real-pilot']);
  assert.equal(described.spawnedEntry, 'test-support/frontagent-controlled-live-entry.mjs');
  assert.equal(described.spawnedEntryIsGeneratedCopy, true);
  assert.equal(described.checkedInTestSupport, false);
  assert.equal(described.databaseUrlPassedByVerifyFullHost, false);
  assert.equal(described.externalShellInspected, false);
  assert.equal(described.coreDistDependsOnNative, false);
  assert.equal(JSON.stringify(described).includes('postgres://'), false);
  const verify = fs.readFileSync(new URL('./verify-full-host.mjs', import.meta.url), 'utf8');
  assert.match(verify, /test-support\/frontagent-controlled-live-entry\.mjs/);
  assert.match(verify, /copyFileSync\(path\.join\(here,name\),path\.join\(directory,'test-support',name\)\)/);
  assert.match(verify, /'frontagent-controlled-live-entry\.mjs','front-claw-db-attach\.mjs','controlled-real-container-transport\.mjs'/);
  assert.equal(verify.includes('FRONT_CLAW_DATABASE_URL'), false);
  assert.equal(verify.includes('--env-file'), false);
  assert.equal(fs.existsSync(new URL('../../test-support', import.meta.url)), false);
  const runtime = fs.readFileSync(new URL('./linux-runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /--network=none/);
  assert.equal(runtime.includes('FRONT_CLAW_DATABASE_URL'), false);
  const pilot = fs.readFileSync(new URL('../../src/role-eval/wecom-bot-pilot.ts', import.meta.url), 'utf8');
  assert.equal(pilot.includes('integrations/native'), false);
  assert.equal(frontClawDatabaseEnvFile({}), FRONT_CLAW_DB_ENV_FILE);
  assert.equal(frontClawDatabaseEnvFile({ FRONT_CLAW_DB_ENV_FILE: '/qiwe-control/front-claw-db.env' }), '/qiwe-control/front-claw-db.env');
  assert.throws(() => frontClawDatabaseEnvFile({ FRONT_CLAW_DB_ENV_FILE: 'relative.env' }), /FRONT_CLAW_DB_ENV_PATH/);
  const entry = fs.readFileSync(new URL('./frontagent-controlled-live-entry.mjs', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('./frontagent-controlled-live-worker.mjs', import.meta.url), 'utf8');
  const transport = fs.readFileSync(new URL('./controlled-real-container-transport.mjs', import.meta.url), 'utf8');
  assert.match(entry, /loadFrontClawDatabaseEnv\(frontClawDatabaseEnvFile\(\)\)/);
  assert.match(worker, /const databaseEnvFile=frontClawDatabaseEnvFile\(\)/);
  assert.match(worker, /databaseEnvFile\}/);
  assert.equal(worker.includes('FRONT_CLAW_DB_ENV_HOST_FILE'), false);
  assert.match(transport, /execFileSync\(localDocker,/);
  assert.match(transport, /spawn\(localDocker,/);
  assert.equal(entry.includes('postgres://'), false);
  assert.equal(worker.includes('postgres://'), false);
});

test('docker CLI env-file is opened by the client, while a bind source is a separate path', () => {
  const secret = 'postgres://frontclaw:super-secret-not-logged@127.0.0.1:5432/postgres';
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-claw-client-'));
  const clientFile = path.join(clientDir, 'front-claw-db.env');
  fs.writeFileSync(clientFile, `FRONT_CLAW_DATABASE_URL=${secret}\n`, { mode: 0o600 });
  const daemonOnly = '/host/not-mounted-into-this-client/front-claw-db.env';
  assert.equal(fs.existsSync(daemonOnly), false);
  assert.equal(loadFrontClawDatabaseEnv(daemonOnly), null);
  const skipped = withDatabaseEnvFile(['run', '--entrypoint=node', 'image'], daemonOnly);
  assert.equal(skipped.includes('--env-file'), false);
  const args = withDatabaseEnvFile(['run', '--name=qiwe-runner', '--entrypoint=node', 'image'], clientFile);
  const clientRead = fs.readFileSync(args[args.indexOf('--env-file') + 1], 'utf8');
  assert.match(clientRead, /FRONT_CLAW_DATABASE_URL=/);
  assert.equal(args.some(arg => String(arg).includes('super-secret-not-logged')), false);
  assert.equal(args.includes(daemonOnly), false);
  const transport = fs.readFileSync(new URL('./controlled-real-container-transport.mjs', import.meta.url), 'utf8');
  assert.match(transport, /withDatabaseEnvFile\(translated,options\.databaseEnvFile\)/);
  assert.match(transport, /execFileSync\(localDocker,/);
});
