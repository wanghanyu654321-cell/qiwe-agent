import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {executeSmokeChild, runLiveModelSmoke, singleRequestFetch} from '../../integrations/native/live-model-smoke.js';

const roots: string[] = [];
function fixture(text = 'ANTHROPIC_API_KEY=synthetic-key\nANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nANTHROPIC_MODEL=deepseek-flash\nMINICLAW_AGENT_RUNTIME=pi\nAGENT_RUNTIME=pi\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-smoke-test-'));
  roots.push(root);
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, text);
  return {root, envFile};
}
afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});});

describe('limited live model launcher', () => {
  it('requires explicit --live before reading any env or invoking a child', async () => {
    const result = await runLiveModelSmoke({args: [], envFile: 'nonexistent'});
    expect(result).toMatchObject({status: 'explicit-live-required', completed: false});
  });

  it.each([
    ['ANTHROPIC_API_KEY=\n', 'configuration-rejected'],
    ['ANTHROPIC_API_KEY=synthetic-key\nANTHROPIC_BASE_URL=https://api.deepseek.com.evil/anthropic\nANTHROPIC_MODEL=deepseek-flash\n', 'configuration-rejected'],
    ['ANTHROPIC_API_KEY=synthetic-key\nANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nANTHROPIC_MODEL=other-model\n', 'configuration-rejected'],
  ])('rejects incomplete or unapproved provider configuration', async (text, status) => {
    const {envFile} = fixture(text);
    const result = await runLiveModelSmoke({args: ['--live'], envFile, runChild: () => {throw Error('must not start');}});
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain('synthetic-key');
  });

  it('isolates every call, disables retries/resources, and passes only selected environment values', async () => {
    const {envFile} = fixture();
    const before = fs.readFileSync(envFile);
    const seen: string[] = [];
    for (let index = 0; index < 2; index++) {
      const result = await runLiveModelSmoke({args: ['--live'], envFile, runChild: async (launch: {cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number}) => {
        seen.push(launch.cwd);
        expect(fs.existsSync(path.join(launch.cwd, 'data/config/claude-provider.json'))).toBe(false);
        const settings = JSON.parse(fs.readFileSync(path.join(launch.cwd, 'data/config/pi-agent/settings.json'), 'utf8'));
        expect(settings).toMatchObject({retry: {enabled: false, provider: {maxRetries: 0}}, compaction: {enabled: false}, packages: [], extensions: []});
        expect(launch.env.ANTHROPIC_API_KEY).toBe('synthetic-key');
        expect(launch.env.PI_OFFLINE).toBe('1');
        expect(launch.env.NODE_OPTIONS).toBeUndefined();
        expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(launch.timeoutMs).toBeLessThanOrEqual(95_000);
        return {status: 'passed', completed: true, exactMatch: true, responseLength: 35, elapsedMs: 1, rawSecret: 'synthetic-key'};
      }});
      expect(result).toMatchObject({status: 'passed', completed: true, exactMatch: true});
      expect(JSON.stringify(result)).not.toContain('synthetic-key');
    }
    expect(seen[0]).not.toBe(seen[1]);
    for (const cwd of seen) expect(fs.existsSync(cwd)).toBe(false);
    expect(fs.readFileSync(envFile)).toEqual(before);
  });

  it('returns sanitized failure and removes private state when a child throws upstream text', async () => {
    const {envFile} = fixture();
    let cwd = '';
    const result = await runLiveModelSmoke({args: ['--live'], envFile, runChild: async (launch: {cwd: string}) => {
      cwd = launch.cwd;
      throw Error('synthetic-key upstream private response');
    }});
    expect(result).toMatchObject({status: 'failed', completed: false});
    expect(JSON.stringify(result)).not.toMatch(/synthetic-key|private response/);
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('terminates a child that never completes and discards stdout/stderr', async () => {
    const {root} = fixture();
    const script = path.join(root, 'stall.cjs');
    fs.writeFileSync(script, 'console.log("synthetic-key"); console.error("private-response"); setInterval(() => {}, 1000);');
    const started = Date.now();
    const evidence = await executeSmokeChild({cwd: root, env: {}, timeoutMs: 100, args: [script]});
    expect(evidence).toMatchObject({status: 'timeout', completed: false});
    expect(Date.now() - started).toBeLessThan(5000);
    expect(JSON.stringify(evidence)).not.toMatch(/synthetic-key|private-response/);
  });

  it('preserves sanitized failed-child phase and attempts on a nonzero exit', async () => {
    const {root} = fixture();
    const script = path.join(root, 'failed.cjs');
    fs.writeFileSync(script, 'process.send({status:"failed",completed:false,exactMatch:false,responseLength:0,elapsedMs:31,phase:"import-helper",errorCode:"module-missing",requestAttempts:0,raw:"synthetic-key"}, () => process.exit(1));');
    const evidence = await executeSmokeChild({cwd: root, env: {}, timeoutMs: 5000, args: [script]});
    expect(evidence).toMatchObject({status: 'failed', elapsedMs: 31, phase: 'import-helper', errorCode: 'module-missing', requestAttempts: 0});
    expect(JSON.stringify(evidence)).not.toContain('synthetic-key');
  });

  it('accepts one exact endpoint POST, caps output, and rejects retry or redirect routing', async () => {
    const fetchOnce = singleRequestFetch(async input => {
      const request = input as Request;
      expect(request.redirect).toBe('error');
      expect(await request.json()).toMatchObject({model: 'deepseek-flash', max_tokens: 128});
      return new Response('synthetic-success');
    });
    await expect(fetchOnce('https://api.deepseek.com/other', {method: 'POST'})).rejects.toThrow('MODEL_SMOKE_REQUEST_REJECTED');
    await expect(fetchOnce('https://api.deepseek.com/anthropic/v1/messages', {method: 'GET'})).rejects.toThrow('MODEL_SMOKE_REQUEST_REJECTED');
    const init = {method: 'POST', body: JSON.stringify({model: 'deepseek-flash', max_tokens: 32000})};
    expect(await (await fetchOnce('https://api.deepseek.com/anthropic/v1/messages', init)).text()).toBe('synthetic-success');
    await expect(fetchOnce('https://api.deepseek.com/anthropic/v1/messages', init)).rejects.toThrow('MODEL_SMOKE_REQUEST_REJECTED');
  });

  it('admits at most one transport request when calls arrive concurrently', async () => {
    const fetchOnce = singleRequestFetch(async () => new Response('ok'));
    const init = {method: 'POST', body: JSON.stringify({model: 'deepseek-flash'})};
    const outcomes = await Promise.allSettled([
      fetchOnce('https://api.deepseek.com/anthropic/v1/messages', init),
      fetchOnce('https://api.deepseek.com/anthropic/v1/messages', init),
    ]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  });

  it('suppresses actual original SDK ancestor contexts and executable extensions without a model call', async () => {
    const {root} = fixture();
    const cwd = path.join(root, 'nested');
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(agentDir, 'extensions'), {recursive: true});
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'private ancestor context must never enter the prompt');
    fs.writeFileSync(path.join(agentDir, 'extensions', 'danger.mjs'), 'throw Error("extension must never execute");');
    const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const sdkUrl = pathToFileURL(path.resolve(project, '../claw-agent-phase-one/.local/full-instance/stage/app/node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
    const entryUrl = pathToFileURL(path.join(project, 'integrations/native/live-model-smoke.ts')).href;
    const script = path.join(root, 'resources.mjs');
    fs.writeFileSync(script, `
globalThis.fetch = async () => {throw Error('network forbidden');};
const {suppressResourceDiscovery} = await import(${JSON.stringify(entryUrl)});
const {DefaultResourceLoader, SettingsManager} = await import(${JSON.stringify(sdkUrl)});
suppressResourceDiscovery(DefaultResourceLoader);
const loader = new DefaultResourceLoader({cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(agentDir)}, settingsManager: SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)})});
await loader.reload();
const empty = loader.getAgentsFiles().agentsFiles.length === 0 && loader.getSkills().skills.length === 0 && loader.getExtensions().extensions.length === 0;
process.send({status: empty ? 'passed' : 'failed', completed: empty, exactMatch: empty, responseLength: 0, elapsedMs: 1}, () => process.exit(empty ? 0 : 1));
`);
    const result = await executeSmokeChild({cwd: root, env: {PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot}, timeoutMs: 10_000, args: [script]});
    expect(result).toMatchObject({status: 'passed', completed: true});
  }, 15_000);

  it('reaches original helper with a synthetic key while all provider transport is sealed', async () => {
    const {root, envFile} = fixture();
    const guard = path.join(root, 'sealed.mjs');
    fs.writeFileSync(guard, 'globalThis.fetch = async () => {throw Error("SYNTHETIC_TRANSPORT_BLOCKED");};');
    const result = await runLiveModelSmoke({args: ['--live'], envFile, runChild: launch => executeSmokeChild({
      ...launch, timeoutMs: 15_000, args: ['--import', pathToFileURL(guard).href, ...launch.args],
    })});
    expect(result).toMatchObject({status: 'failed', phase: 'complete', errorCode: 'query-failed', requestAttempts: 1});
  }, 20_000);
});
