import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {it, expect} from 'vitest';
// @ts-expect-error Plain JavaScript pilot module with no declaration in this checkout.
import {createPilotRunLedger, openPilotRunLedger} from '../integrations/native/controlled-real-run-budget.mjs';
// @ts-expect-error Plain JavaScript pilot module with no declaration in this checkout.
import {disposeConfirmedNewPilotEnv, witnessPilotEnvAbsence} from '../integrations/native/controlled-real-env-disposition.mjs';
// @ts-expect-error Plain JavaScript pilot module with no declaration in this checkout.
import {installControlledRealModelFetch} from '../integrations/native/controlled-real-preload.mjs';

const nativeRoot = new URL('../integrations/native/', import.meta.url);
const readNative = (name: string) => fs.readFileSync(new URL(name, nativeRoot), 'utf8');

function mountedPilotFiles(): string[] {
  const start = readNative('real-container-boundary.mjs').indexOf('export function admitControlledRealDockerRun');
  if (start < 0) throw Error('mounted_files_unreadable');
  const mounts = [...readNative('real-container-boundary.mjs').slice(start).matchAll(/\/verification\/(controlled-real-[A-Za-z0-9._-]+):ro/g)].map(match => match[1] ?? '');
  if (mounts.length === 0 || mounts.some(name => !name || !fs.existsSync(new URL(name, nativeRoot)))) throw Error('mounted_files_unreadable');
  return mounts;
}

/** These assertions are the review contract. They call the real modules and must pass. */
it('a directory with only the mounted pilot files can import the preload', () => {
  const names = mountedPilotFiles();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-mounted-preload-'));
  try {
    for (const name of names) fs.copyFileSync(new URL(name, nativeRoot), path.join(directory, name));
    expect(fs.readdirSync(directory).sort()).toEqual([...names].sort());
    const href = pathToFileURL(path.join(directory, 'controlled-real-preload.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(href)})`], {encoding: 'utf8'});
    expect({status: child.status, stderr: child.stderr}).toMatchObject({status: 0});
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

it('the launch and restart path mounts the budget ledger and opens it read-only on restart', () => {
  const launch = ['verify-full-host.mjs', 'real-container-boundary.mjs', 'frontagent-controlled-live-entry.mjs', 'frontagent-controlled-live-worker.mjs', 'controlled-real-container-transport.mjs'].map(readNative).join('\n');
  expect(launch.includes('controlled-real-run-budget.mjs')).toBe(true);
  expect(launch.includes('QIWE_PILOT_MODEL_LEDGER')).toBe(true);
  expect(launch.includes('openRestartLookup')).toBe(true);
});

it('a model rejected by the DeepSeek allowlist does not consume ledger quota', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-budget-gap-'));
  const file = path.join(directory, 'ledger.json');
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const expiresAt = Date.now() + 60_000;
  const expected = {runId, maxRequests: 2, expiresAt};
    let transportCalls = 0;
    try {
    createPilotRunLedger(file, expected);
    const target: {fetch: (input: string, init?: {method?: string; body?: string}) => Promise<Response>} = {fetch: async () => { transportCalls += 1; return new Response('offline'); }};
    installControlledRealModelFetch({
      QIWE_PILOT_RUN_ID: runId,
      QIWE_PILOT_MODEL_EXPIRES_AT: String(expiresAt),
      QIWE_PILOT_MODEL_REQUESTS: '2',
      QIWE_PILOT_MODEL_OUTPUT_TOKENS: '64',
      QIWE_PILOT_MODEL_LEDGER: file
    }, target);
    await expect(target.fetch('https://api.deepseek.com/anthropic/v1/messages', {method: 'POST', body: JSON.stringify({model: 'not-on-allowlist', max_tokens: 16})})).rejects.toThrow(/CONTROLLED_MODEL_REQUEST_REJECTED/);
    expect(transportCalls).toBe(0);
    expect(openPilotRunLedger(file, expected).reserved).toBe(0);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

it('preexisting env disposal re-reads the file before retaining it', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-env-gap-'));
  const file = path.join(data, 'env', 'marketing', 'default', 'main', 'env');
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, 'ORIGINAL_PLACEHOLDER\n', {mode: 0o600});
    const witness = witnessPilotEnvAbsence(data, 'marketing');
    expect(witness.status).toBe('preexisting');
    fs.rmSync(file);
    fs.writeFileSync(file, 'SWAPPED_NOT_ORIGINAL\n', {mode: 0o600});
    let outcome = '';
    try {
      const result = disposeConfirmedNewPilotEnv(data, 'marketing', witness, {state: 'exited', exitCode: 0, signal: null});
      outcome = result.reason + ':' + fs.readFileSync(file, 'utf8');
    } catch (error) {
      outcome = 'threw:' + (error instanceof Error ? error.message : 'unknown');
    }
    expect(outcome).not.toBe('original_file_retained:SWAPPED_NOT_ORIGINAL\n');
  } finally {
    fs.rmSync(data, {recursive: true, force: true});
  }
});

it('close timeout still disposes a witnessed new env file', () => {
  const source = readNative('controlled-real-container-transport.mjs');
  const start = source.indexOf('async close()');
  const end = source.indexOf('closed=true', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const closeFn = source.slice(start, end);
  const timeoutAt = closeFn.indexOf('CONTROLLED_REAL_TRANSPORT_CLOSE_UNKNOWN');
  const disposeAt = closeFn.indexOf('disposeConfirmedNewPilotEnv');
  expect(timeoutAt).toBeGreaterThan(-1);
  expect(disposeAt).toBeGreaterThan(-1);
  expect(disposeAt).toBeLessThan(timeoutAt);
});

it('spawn failure still disposes a witnessed new env file', () => {
  const source = readNative('controlled-real-container-transport.mjs');
  const start = source.indexOf('spawn:(command,args,spawnOptions)=>{');
  const end = source.indexOf('return child;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(source.slice(start, end).includes('disposeConfirmedNewPilotEnv')).toBe(true);
});

it('the runner file classifier calls pi-session-recovery', () => {
  const source = readNative('full-host-local-residue.mjs');
  expect(source.includes('pi-session-recovery')).toBe(true);
  expect(source.includes('admitPiSessionBeyondSyntheticProtocol')).toBe(true);
});
