/** Explicit connectivity probe only. Never import/start a host or WeCom client. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
import {registerHooks} from 'node:module';

const entry = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(entry), '../..');
const original = path.resolve(project, '../claw-agent-phase-one/.local/full-instance/stage/app');
const endpoint = 'https://api.deepseek.com/anthropic';
const expected = 'QIWE_MODEL_CONNECTIVITY_OK';
const timeoutMs = 95_000;

type Evidence = {
  status: string; completed: boolean; exactMatch: boolean; responseLength: number; elapsedMs: number;
  phase: string; errorCode: string; requestAttempts: number | null;
};
export type SmokeLaunch = {cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; args: string[]};
type Options = {args: string[]; envFile?: string; runChild?: (launch: SmokeLaunch) => Promise<unknown>};
const failed = (status: string): Evidence => ({status, completed: false, exactMatch: false, responseLength: 0, elapsedMs: 0,
  phase: 'launcher', errorCode: 'child-no-receipt', requestAttempts: null});

function safeEvidence(value: unknown): Evidence {
  if (!value || typeof value !== 'object') return failed('failed');
  const result = value as Record<string, unknown>;
  if (result.status === 'timeout') return failed('timeout');
  if (!['passed', 'failed'].includes(String(result.status)) ||
      typeof result.completed !== 'boolean' || typeof result.exactMatch !== 'boolean' ||
      !Number.isSafeInteger(result.responseLength) || Number(result.responseLength) < 0 || Number(result.responseLength) > 1_000_000 ||
      !Number.isSafeInteger(result.elapsedMs) || Number(result.elapsedMs) < 0 || Number(result.elapsedMs) > timeoutMs) return failed('failed');
  const passed = result.status === 'passed' && result.completed && result.exactMatch;
  return {status: passed ? 'passed' : 'failed', completed: result.completed, exactMatch: result.exactMatch,
    responseLength: Number(result.responseLength), elapsedMs: Number(result.elapsedMs),
    phase: ['launcher', 'import-sdk', 'import-helper', 'query', 'complete'].includes(String(result.phase)) ? String(result.phase) : 'launcher',
    errorCode: ['none', 'module-missing', 'native-module-unavailable', 'sdk-version-mismatch', 'startup-failed', 'query-failed', 'response-mismatch'].includes(String(result.errorCode)) ? String(result.errorCode) : 'child-no-receipt',
    requestAttempts: result.requestAttempts === 0 || result.requestAttempts === 1 ? result.requestAttempts : null};
}

/** Child stdout/stderr is discarded, including provider exceptions and fatal errors. */
export function executeSmokeChild(launch: SmokeLaunch): Promise<unknown> {
  return new Promise(resolve => {
    let receipt: unknown;
    let timedOut = false;
    const child = spawn(process.execPath, launch.args, {cwd: launch.cwd, env: launch.env,
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, launch.timeoutMs);
    child.on('message', value => {receipt = safeEvidence(value);});
    child.once('error', () => {clearTimeout(timer); resolve(failed('failed'));});
    child.once('close', code => {
      clearTimeout(timer);
      const result = safeEvidence(receipt);
      resolve(timedOut ? {...result, status: 'timeout', completed: false, exactMatch: false} :
        code === 0 ? result : {...result, status: 'failed', exactMatch: false});
    });
  });
}

export async function runLiveModelSmoke(options: Options): Promise<Evidence> {
  // This check happens before reading configuration or creating a process/directory.
  if (options.args.length !== 1 || options.args[0] !== '--live') return failed('explicit-live-required');
  let config: Record<string, string | undefined>;
  try {
    config = parseEnv(fs.readFileSync(options.envFile ?? path.join(project, '.local/live-model/.env'), 'utf8'));
  } catch {return failed('configuration-rejected');}
  if (!config.ANTHROPIC_API_KEY?.trim() || config.ANTHROPIC_AUTH_TOKEN?.trim() ||
      config.ANTHROPIC_BASE_URL !== endpoint || config.ANTHROPIC_MODEL !== 'deepseek-flash' ||
      config.MINICLAW_AGENT_RUNTIME !== 'pi' || config.AGENT_RUNTIME !== 'pi') return failed('configuration-rejected');

  let cwd: string | undefined;
  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-model-connectivity-'));
    const agentDir = path.join(cwd, 'data/config/pi-agent');
    fs.mkdirSync(agentDir, {recursive: true});
    fs.mkdirSync(path.join(cwd, 'home'));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
      retry: {enabled: false, maxRetries: 0, provider: {maxRetries: 0, timeoutMs: 85_000}},
      compaction: {enabled: false}, defaultThinkingLevel: 'off', packages: [], extensions: [],
      skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false,
    }), {mode: 0o600});
    // No inherited model/provider credentials, NODE_OPTIONS, proxy, or project settings.
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY.trim(), ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_MODEL: 'deepseek-flash', MINICLAW_AGENT_RUNTIME: 'pi', AGENT_RUNTIME: 'pi',
      PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, LOG_LEVEL: 'silent',
      HOME: path.join(cwd, 'home'), USERPROFILE: path.join(cwd, 'home'),
      TEMP: cwd, TMP: cwd, QIWE_MODEL_SMOKE_CHILD: '1',
    };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    return safeEvidence(await (options.runChild ?? executeSmokeChild)({cwd, env, timeoutMs,
      args: [entry, '--smoke-worker']}));
  } catch {return failed('failed');}
  finally {
    if (cwd) {
      // Only the exact mkdtemp-owned path is removed. Original source and env are never written.
      const resolved = path.resolve(cwd);
      if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('qiwe-model-connectivity-')) {
        fs.rmSync(resolved, {recursive: true, force: true});
      }
    }
  }
}

/** One POST only, no redirects/retries/catalog traffic; bound generated text to 128 tokens. */
export function singleRequestFetch(transport: typeof fetch, onRequest: () => void = () => {}): typeof fetch {
  let requests = 0;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== `${endpoint}/v1/messages` || request.method !== 'POST' || requests !== 0) {
      throw Error('MODEL_SMOKE_REQUEST_REJECTED');
    }
    // Reserve synchronously before reading the body to close concurrent admission.
    requests++;
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    if (body.model !== 'deepseek-flash') throw Error('MODEL_SMOKE_REQUEST_REJECTED');
    onRequest();
    body.max_tokens = 128;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(85_000)]);
    return transport(new Request(request, {body: JSON.stringify(body), redirect: 'error', signal}));
  };
}

export function suppressResourceDiscovery(loader: {prototype: {reload: (...args: unknown[]) => Promise<void>}}): void {
  // Constructor starts empty; avoiding reload also avoids package-manager ancestor scans.
  loader.prototype.reload = async function () {};
}

async function worker(): Promise<void> {
  const started = Date.now();
  let phase = 'import-sdk';
  let requestAttempts = 0;
  const progress = () => {process.send?.({...failed('failed'), phase, errorCode: 'none', requestAttempts, elapsedMs: Date.now() - started});};
  try {
    if (!process.send || process.env.QIWE_MODEL_SMOKE_CHILD !== '1') throw Error('CHILD_ONLY');
    progress();
    const sdkRoot = path.join(original, 'node_modules/@earendil-works/pi-coding-agent');
    const version = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;
    if (version !== '0.84.2') throw Object.assign(Error('SDK_VERSION_REQUIRES_REVIEW'), {code: 'SDK_VERSION_REQUIRES_REVIEW'});
    globalThis.fetch = singleRequestFetch(globalThis.fetch, () => {requestAttempts++; progress();});
    const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
    // sdkQuery fixes its loader arguments. In this disposable child only, bypass
    // reload so constructor-initialized empty resources cannot discover ancestors,
    // packages, global skills/extensions, prompts or context. No Agent loop changes.
    suppressResourceDiscovery(sdk.DefaultResourceLoader);
    // N's installed tsx/esbuild is Linux-only. Node 24 strips erasable TS; resolve
    // N's compiled-style relative .js source imports to existing .ts files only.
    const sourcePrefix = pathToFileURL(path.join(original, 'src') + path.sep).href;
    registerHooks({resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(sourcePrefix) && specifier.startsWith('.') && specifier.endsWith('.js')) {
        const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
      }
      return nextResolve(specifier, context);
    }});
    phase = 'import-helper'; progress();
    const {sdkQuery} = await import(pathToFileURL(path.join(original, 'src/sdk-query.ts')).href);
    phase = 'query'; progress();
    const response = await sdkQuery(`Reply with exactly this text: ${expected}`, {timeout: 85_000});
    const evidence: Evidence = {status: response === expected ? 'passed' : 'failed',
      completed: typeof response === 'string' && response.length > 0, exactMatch: response === expected,
      responseLength: typeof response === 'string' ? response.length : 0, elapsedMs: Date.now() - started,
      phase: 'complete', errorCode: response === expected ? 'none' : response ? 'response-mismatch' : 'query-failed', requestAttempts};
    process.send!(evidence, () => process.exit(evidence.status === 'passed' ? 0 : 1));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const errorCode = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' ? 'module-missing' :
      code === 'ERR_DLOPEN_FAILED' ? 'native-module-unavailable' : code === 'SDK_VERSION_REQUIRES_REVIEW' ? 'sdk-version-mismatch' :
      phase === 'query' ? 'query-failed' : 'startup-failed';
    if (process.send) process.send({...failed('failed'), phase, errorCode, requestAttempts, elapsedMs: Date.now() - started}, () => process.exit(1));
    else process.exitCode = 1;
  }
}

// Imports/default invocation never connect. Only the parent emits sanitized output.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(entry)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--smoke-worker') void worker();
  else void runLiveModelSmoke({args: process.argv.slice(2)}).then(evidence => {
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (evidence.status !== 'passed') process.exitCode = 1;
  }).catch(() => {process.stdout.write(`${JSON.stringify(failed('failed'))}\n`); process.exitCode = 1;});
}
