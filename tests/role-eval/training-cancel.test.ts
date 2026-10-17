import {afterEach, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createTrainingSummaryService} from '../../src/role-eval/training-knowledge.js';
import {createTrainingGenerationService, type TrainingContext} from '../../src/role-eval/training-generation.js';

const scope = {accountId: 'synthetic-owner', workspaceJid: 'web:local-training'};
const input = {requestKey: 'synthetic-cancel', mode: 'question', query: '合成家访', persona: 'instructor'};
const answer = (id: string) => ({answer: '合成教学建议，待人工审核。', lesson: null, citations: [id], limitations: ['合成练习']});
const directories: string[] = [];
const services: ReturnType<typeof createTrainingGenerationService>[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close?.();
  for (const dir of directories.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-cancel-'));
  directories.push(dir);
  const body = '# 合成教学\n\n## 合成家访\n仅用于临时测试的访谈和复盘。';
  const sha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(dir, 'approval.json'), JSON.stringify({kind: 'user_provided_summary', scope, sha256, fileName: 'synthetic.md'}));
  fs.writeFileSync(path.join(dir, `summary-${sha256}.json`), JSON.stringify({scope, sha256, sourceText: body}));
  const knowledge = createTrainingSummaryService(dir, {...scope});
  const options = {dir: path.join(dir, 'runs'), scope: {...scope}, knowledge};
  return {dir, options, knowledge};
}
function service(options: Parameters<typeof createTrainingGenerationService>[0]) {
  const result = createTrainingGenerationService(options);
  services.push(result);
  return result;
}
function deferred() {
  let finish!: (value: unknown) => void;
  const promise = new Promise<unknown>(resolve => { finish = resolve; });
  return {promise, finish};
}

it('persists exact cancellation before abort and never publishes a late ignored-signal answer', async () => {
  const {options} = setup(), pending = deferred();
  let signal!: AbortSignal, context!: TrainingContext, observedStatus = '';
  const owner = service({...options, generate: async (ctx, abort) => {
    context = ctx; signal = abort;
    abort.addEventListener('abort', () => { observedStatus = observer.get(scope, input.requestKey).status; });
    return pending.promise;
  }});
  const observer = service({...options, generate: async () => { throw Error('must not replay'); }});
  const started = owner.start(scope, input);
  expect(owner.cancel(scope, input.requestKey)).toMatchObject({id: started.id, status: 'cancelled', output: null});
  expect(signal.aborted).toBe(true);
  expect(observedStatus).toBe('cancelled');
  expect(owner.cancel(scope, input.requestKey).status).toBe('cancelled');
  pending.finish(answer(context.sources[0]!.id));
  await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey).status).toBe('cancelled');
  expect(observer.start(scope, input).status).toBe('cancelled');
});

it('cannot cancel another instance, account, workspace or key and never silently replays it', async () => {
  const {options} = setup(), pending = deferred();
  let calls = 0, signal!: AbortSignal, citation = '';
  const owner = service({...options, generate: async (context, abort) => { calls++; signal = abort; citation = context.sources[0]!.id; return pending.promise; }});
  owner.start(scope, input);
  const fresh = service({...options, generate: async () => { calls++; throw Error('must not replay'); }});
  expect(fresh.cancel(scope, input.requestKey).status).toBe('unknown');
  expect(fresh.start(scope, input).status).toBe('unknown');
  expect(signal.aborted).toBe(false);
  expect(() => owner.cancel({...scope, accountId: 'other'}, input.requestKey)).toThrow('training_scope_denied');
  expect(() => owner.cancel({...scope, workspaceJid: 'other'}, input.requestKey)).toThrow('training_scope_denied');
  expect(() => owner.cancel(scope, 'missing')).toThrow();
  const otherAccount = service({...options, scope: {...scope, accountId: 'other'}, generate: async () => { throw Error('must not run'); }});
  expect(() => otherAccount.cancel({...scope, accountId: 'other'}, input.requestKey)).toThrow();
  pending.finish(answer(citation));
  await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey).status).toBe('ready');
  expect(calls).toBe(1);
});

it('cancels only the requested active run while another key completes', async () => {
  const {options} = setup(), first = deferred(), second = deferred();
  const signals = new Map<string, AbortSignal>(), ids = new Map<string, string>();
  const owner = service({...options, generate: async (ctx, signal) => {
    signals.set(ctx.input.requestKey, signal); ids.set(ctx.input.requestKey, ctx.sources[0]!.id);
    return ctx.input.requestKey === input.requestKey ? first.promise : second.promise;
  }});
  owner.start(scope, input); owner.start(scope, {...input, requestKey: 'second'});
  owner.cancel(scope, input.requestKey);
  expect(signals.get(input.requestKey)!.aborted).toBe(true);
  expect(signals.get('second')!.aborted).toBe(false);
  second.finish(answer(ids.get('second')!));
  await owner.settled('second');
  expect(owner.get(scope, 'second').status).toBe('ready');
  await owner.settled(input.requestKey);
});

it('cancel keeps finished ready, failed and source-stale runs terminal', async () => {
  for (const terminal of ['ready', 'failed', 'stale']) {
    const {dir, options} = setup();
    const owner = service({...options, generate: async ctx => {
      if (terminal === 'stale') fs.unlinkSync(path.join(dir, 'approval.json'));
      return answer(terminal === 'failed' ? 'forged' : ctx.sources[0]!.id);
    }});
    owner.start(scope, input); await owner.settled(input.requestKey);
    expect(owner.cancel(scope, input.requestKey).status).toBe(terminal);
  }
});

it('cancelled remains cancelled when approved sources are later revoked', async () => {
  const {dir, options} = setup();
  const owner = service({...options, generate: async () => new Promise(() => {})});
  owner.start(scope, input); owner.cancel(scope, input.requestKey);
  fs.unlinkSync(path.join(dir, 'approval.json'));
  await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey).status).toBe('cancelled');
});

it('close aborts owned work as unknown, blocks restarts and cannot overwrite a late result', async () => {
  const {options} = setup(), pending = deferred(); let signal!: AbortSignal, id = '';
  const owner = service({...options, generate: async (ctx, abort) => { signal = abort; id = ctx.sources[0]!.id; return pending.promise; }});
  owner.start(scope, input); owner.close(); owner.close();
  expect(signal.aborted).toBe(true);
  expect(owner.get(scope, input.requestKey).status).toBe('unknown');
  expect(() => owner.start(scope, {...input, requestKey: 'new'})).toThrow('training_service_closed');
  pending.finish(answer(id)); await owner.settled(input.requestKey);
  const fresh = service({...options, generate: async () => { throw Error('must not replay'); }});
  expect(fresh.cancel(scope, input.requestKey).status).toBe('unknown');
});

it('owns its scope, dependency references and deep private input/source snapshots', async () => {
  const {options} = setup(), pending = deferred(); let originalId = '';
  const mutableOptions = {...options, generate: async (ctx: TrainingContext) => {
    originalId = ctx.sources[0]!.id;
    ctx.input.query = 'mutated port input'; ctx.sources[0]!.id = 'mutated-port-id';
    return pending.promise;
  }};
  const owner = service(mutableOptions);
  mutableOptions.scope.accountId = 'changed-option';
  mutableOptions.knowledge = {overview: () => ({available: false}), search: () => { throw Error('changed dependency'); }} as unknown as typeof options.knowledge;
  const supplied = {...input}, started = owner.start(scope, supplied);
  supplied.query = 'changed caller input';
  started.actor.accountId = 'forged'; started.input.query = 'changed start return'; started.sources[0]!.id = 'changed start source';
  const running = owner.get(scope, input.requestKey);
  expect(running.actor).toEqual(scope); expect(running.input.query).toBe(input.query); expect(running.sources[0]!.id).toBe(originalId);
  running.input.query = 'changed get input'; running.sources[0]!.text = 'changed get text';
  pending.finish(answer(originalId)); await owner.settled(input.requestKey);
  const result = owner.get(scope, input.requestKey);
  expect(result.status).toBe('ready'); expect(result.input.query).toBe(input.query);
  expect(result.sources[0]!.text).toContain('访谈');
  result.output!.citations[0] = 'changed returned output';
  expect(owner.get(scope, input.requestKey).output!.citations).toEqual([originalId]);
});

it('snapshots retained knowledge search results before handing independent excerpts to generate', async () => {
  const {options, knowledge} = setup(), found = knowledge.search(input.query), pending = deferred();
  const retainedKnowledge = {...knowledge, search: () => found};
  const originalId = found.matches[0]!.id;
  const owner = service({...options, knowledge: retainedKnowledge, generate: async () => pending.promise});
  owner.start(scope, input); found.matches[0]!.id = 'late-reader-change'; found.matches[0]!.text = 'late-reader-text';
  pending.finish(answer(originalId)); await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey).status).toBe('ready');
  expect(owner.get(scope, input.requestKey).sources[0]!.id).toBe(originalId);
});

it('rechecks current access before publishing and fails closed without leaking the access error', async () => {
  const {options} = setup(), pending = deferred(); let allowed = true, checks = 0, id = '';
  const owner = service({...options, assertCurrent: async () => { checks++; if (!allowed) throw Error('secret-account-token'); }, generate: async ctx => { id = ctx.sources[0]!.id; return pending.promise; }});
  owner.start(scope, input); allowed = false; pending.finish(answer(id)); await owner.settled(input.requestKey);
  expect(checks).toBe(1);
  expect(owner.get(scope, input.requestKey)).toMatchObject({status: 'failed', output: null, error: 'training_access_changed'});
  expect(JSON.stringify(owner.get(scope, input.requestKey))).not.toContain('secret-account-token');
});

it('cancellation wins while publication authorization is pending and snapshots the generated output', async () => {
  const {options} = setup(), auth = deferred(); let entered!: () => void, checked = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let produced!: ReturnType<typeof answer>;
  const owner = service({...options, assertCurrent: async () => { checked = true; entered(); await auth.promise; }, generate: async ctx => { produced = answer(ctx.sources[0]!.id); return produced; }});
  owner.start(scope, input); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(checked).toBe(true); await reached;
  owner.cancel(scope, input.requestKey); produced.answer = 'mutated late output'; auth.finish(undefined);
  await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey)).toMatchObject({status: 'cancelled', output: null});
});

it('retained generated output cannot mutate the published result across an authorization await', async () => {
  const {options} = setup(), auth = deferred(); let entered!: () => void, checked = false;
  const reached = new Promise<void>(resolve => { entered = resolve; }); let produced!: ReturnType<typeof answer>;
  const owner = service({...options, assertCurrent: async () => { checked = true; entered(); await auth.promise; }, generate: async ctx => { produced = answer(ctx.sources[0]!.id); return produced; }});
  owner.start(scope, input); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(checked).toBe(true); await reached; produced.answer = 'late mutation'; auth.finish(undefined); await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey).output!.answer).toBe('合成教学建议，待人工审核。');
});

it('retains training_timeout for a hung generator rather than calling it cancelled', async () => {
  const {options} = setup();
  const owner = service({...options, timeoutMs: 10, generate: async () => new Promise(() => {})});
  owner.start(scope, input); await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey)).toMatchObject({status: 'failed', error: 'training_timeout', output: null});
  expect(owner.cancel(scope, input.requestKey).status).toBe('failed');
});

it('does not overwrite a persisted terminal result even while its old promise is active', async () => {
  const {options} = setup(), pending = deferred(); let id = '';
  const owner = service({...options, generate: async ctx => { id = ctx.sources[0]!.id; return pending.promise; }});
  owner.start(scope, input);
  const file = fs.readdirSync(options.dir).find(name => name.endsWith('.json'))!;
  const disk = JSON.parse(fs.readFileSync(path.join(options.dir, file), 'utf8'));
  fs.writeFileSync(path.join(options.dir, file), JSON.stringify({...disk, status: 'failed', error: 'training_model_disabled'}));
  expect(owner.cancel(scope, input.requestKey).status).toBe('failed');
  pending.finish(answer(id)); await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey)).toMatchObject({status: 'failed', error: 'training_model_disabled'});
});

it('refuses cancellation and late publication when its persisted claim owner has changed', async () => {
  const {options} = setup(), pending = deferred(); let id = '', signal!: AbortSignal;
  const owner = service({...options, generate: async (ctx, abort) => { id = ctx.sources[0]!.id; signal = abort; return pending.promise; }});
  owner.start(scope, input);
  const claim = fs.readdirSync(options.dir).find(name => name.endsWith('.claim'))!;
  fs.writeFileSync(path.join(options.dir, claim), JSON.stringify({owner: 'other-process'}));
  expect(owner.cancel(scope, input.requestKey).status).toBe('unknown');
  expect(signal.aborted).toBe(false);
  pending.finish(answer(id)); await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey).status).toBe('unknown');
});

it('rejects a mismatched expected run ID before cancelling the active run sharing that key', async () => {
  const {options} = setup(); let signal!: AbortSignal;
  const owner = service({...options, generate: async (_context, abort) => { signal = abort; return new Promise(() => {}); }});
  const started = owner.start(scope, input);
  expect(() => owner.cancel(scope, input.requestKey, 'another-directory-run')).toThrow('training_run_conflict');
  expect(owner.get(scope, input.requestKey)).toMatchObject({id: started.id, status: 'running'});
  expect(signal.aborted).toBe(false);
  expect(owner.cancel(scope, input.requestKey, started.id).status).toBe('cancelled');
  await owner.settled(input.requestKey);
});

it.each(['ready', 'failed', 'stale', 'cancelled', 'unknown'] as const)('rejects a mismatched expected ID for a %s run instead of returning a false successful match', async status => {
  const {dir, options} = setup();
  const owner = service({...options, generate: async ctx => {
    if (status === 'unknown' || status === 'cancelled') return new Promise(() => {});
    if (status === 'stale') fs.unlinkSync(path.join(dir, 'approval.json'));
    return answer(status === 'failed' ? 'forged' : ctx.sources[0]!.id);
  }});
  const started = owner.start(scope, input);
  if (status === 'cancelled') owner.cancel(scope, input.requestKey);
  if (status === 'unknown') owner.close();
  await owner.settled(input.requestKey);
  expect(owner.get(scope, input.requestKey).status).toBe(status);
  expect(() => owner.cancel(scope, input.requestKey, 'different-run')).toThrow('training_run_conflict');
  expect(owner.cancel(scope, input.requestKey, started.id)).toMatchObject({id: started.id, status});
});
