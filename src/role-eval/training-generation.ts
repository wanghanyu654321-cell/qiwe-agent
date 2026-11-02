import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createTrainingSummaryService, type TrainingScope} from './training-knowledge.js';
import {isTrainingOutput, type TrainingOutput} from './training-output.js';

type Knowledge = ReturnType<typeof createTrainingSummaryService>;
export interface TrainingInput {requestKey: string; mode: 'question' | 'lesson'; query: string; persona: 'instructor' | 'executive' | 'chief';}
export interface TrainingContext {input: TrainingInput; sourceId: string; sources: ReturnType<Knowledge['search']>['matches'];}
export interface TrainingRun extends TrainingContext {
  id: string;
  actor: TrainingScope;
  inputHash: string;
  status: 'running' | 'ready' | 'failed' | 'unknown' | 'stale' | 'cancelled';
  createdAt: string;
  output: TrainingOutput | null;
  error: string | null;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
function parseInput(v: unknown): TrainingInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid_training_generation');
  const x = v as Record<string, unknown>;
  if (Object.keys(x).length !== 4 || !Object.keys(x).every(k => ['requestKey', 'mode', 'query', 'persona'].includes(k)) || typeof x.requestKey !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(x.requestKey) || !['question', 'lesson'].includes(String(x.mode)) || typeof x.query !== 'string' || !x.query.trim() || x.query.length > 2000 || !['instructor', 'executive', 'chief'].includes(String(x.persona))) throw Error('invalid_training_generation');
  return {requestKey: x.requestKey, mode: x.mode as TrainingInput['mode'], query: x.query, persona: x.persona as TrainingInput['persona']};
}

export function createTrainingGenerationService(options: {
  dir: string;
  scope: TrainingScope;
  knowledge: Knowledge;
  generate(context: TrainingContext, signal: AbortSignal): Promise<unknown>;
  timeoutMs?: number;
  assertCurrent?(): Promise<void>;
}) {
  // The trusted assembler supplies a tenant/store partitioned directory. This is
  // still the original training namespace, not a Native workspace or scheduler.
  const dir = options.dir, scope = clone(options.scope), owner = randomUUID();
  const overview = options.knowledge.overview.bind(options.knowledge);
  const search = options.knowledge.search.bind(options.knowledge);
  const generate = options.generate, assertCurrent = options.assertCurrent, timeoutMs = options.timeoutMs ?? 90000;
  type Active = {id: string; abort: AbortController; promise: Promise<void>};
  const active = new Map<string, Active>();
  let closed = false;
  fs.mkdirSync(dir, {recursive: true});
  const authorize = (actor: TrainingScope) => {
    if (actor.accountId !== scope.accountId || actor.workspaceJid !== scope.workspaceJid || scope.workspaceJid !== 'web:local-training') throw Error('training_scope_denied');
  };
  const file = (key: string) => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(key)) throw Error('invalid_training_generation');
    return path.join(dir, digest(JSON.stringify(scope) + key) + '.json');
  };
  const save = (run: TrainingRun) => {
    const target = file(run.input.requestKey), temp = target + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(run)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, target); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  const read = (key: string): TrainingRun => {
    const run = JSON.parse(fs.readFileSync(file(key), 'utf8')) as TrainingRun;
    if (run.actor?.accountId !== scope.accountId || run.actor.workspaceJid !== scope.workspaceJid || run.input?.requestKey !== key) throw Error('training_scope_denied');
    return run;
  };
  const owns = (run: TrainingRun): boolean => {
    if (active.get(run.input.requestKey)?.id !== run.id) return false;
    try {
      const claim = JSON.parse(fs.readFileSync(file(run.input.requestKey) + '.claim', 'utf8'));
      return claim.owner === owner && claim.id === run.id && claim.inputHash === run.inputHash;
    } catch { return false; }
  };
  // Claims are never stolen or removed. Only their owner can transition its
  // matching persisted running record; other instances are read-only/unknown.
  const publish = (run: TrainingRun): boolean => {
    if (!owns(run)) return false;
    const current = read(run.input.requestKey);
    if (current.id !== run.id || current.inputHash !== run.inputHash || current.status !== 'running') return false;
    save(run);
    return true;
  };
  const unknown = (run: TrainingRun): TrainingRun => ({...run, status: 'unknown', output: null, error: 'training_interrupted_unknown'});
  function get(actor: TrainingScope, key: string): TrainingRun {
    authorize(actor);
    const run = read(key);
    if (run.status === 'cancelled' || run.status === 'unknown') return clone(run);
    const source = overview();
    if (!source.available || source.sourceId !== run.sourceId) return clone({...run, status: 'stale', output: null, error: 'training_source_changed'} as TrainingRun);
    if (run.status === 'running' && !owns(run)) return clone(unknown(run));
    return clone(run);
  }
  function start(actor: TrainingScope, value: unknown): TrainingRun {
    authorize(actor);
    if (closed) throw Error('training_service_closed');
    const input = parseInput(value), inputHash = digest(JSON.stringify(input)), target = file(input.requestKey);
    if (fs.existsSync(target)) {
      const prior = get(actor, input.requestKey);
      if (prior.inputHash !== inputHash) throw Error('training_request_conflict');
      return prior;
    }
    const found = clone(search(input.query));
    if (found.status !== 'summary_matches' || !found.matches.length) throw Error('training_evidence_missing');
    // Bound approved excerpts, not full corpus or arbitrary model-chosen files.
    const sources = found.matches.filter(s => s.text.length <= 12000).slice(0, 6);
    if (!sources.length || JSON.stringify(sources).length > 28000) throw Error('training_evidence_too_large');
    const run: TrainingRun = {id: randomUUID(), actor: clone(scope), input, inputHash, sourceId: found.source.id, sources, status: 'running', createdAt: new Date().toISOString(), output: null, error: null};
    const fd = fs.openSync(target + '.claim', 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({owner, id: run.id, inputHash})); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    save(run);
    const abort = new AbortController();
    const entry: Active = {id: run.id, abort, promise: Promise.resolve()};
    active.set(input.requestKey, entry);
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const onAbort = () => rejectStop(Error('training_timeout'));
    abort.signal.addEventListener('abort', onAbort, {once: true});
    // Also consume the rejection if a synchronous port throws before the race.
    void stopped.catch(() => {});
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    entry.promise = (async () => {
      try {
        const context: TrainingContext = clone({input, sourceId: run.sourceId, sources});
        const output = clone(await Promise.race([generate(context, abort.signal), stopped]));
        if (assertCurrent) {
          try { await Promise.race([assertCurrent(), stopped]); }
          catch { throw Error(abort.signal.aborted ? 'training_timeout' : 'training_access_changed'); }
        }
        const current = overview();
        if (!current.available || current.sourceId !== run.sourceId) { run.status = 'stale'; run.error = 'training_source_changed'; }
        else if (abort.signal.aborted) throw Error('training_timeout');
        else if (!isTrainingOutput(output, input.mode, sources.map(s => s.id))) throw Error('training_output_unverified');
        else { run.status = 'ready'; run.output = output; }
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error && ['training_timeout', 'training_output_unverified', 'training_budget_exhausted', 'training_model_disabled', 'training_access_changed'].includes(error.message) ? error.message : 'training_model_unavailable';
        run.output = null;
      } finally {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', onAbort);
        try { publish(run); }
        finally { if (active.get(input.requestKey) === entry) active.delete(input.requestKey); }
      }
    })();
    void entry.promise.catch(() => {});
    return clone(run);
  }
  function cancel(actor: TrainingScope, key: string, expectedRunId?: string): TrainingRun {
    authorize(actor);
    const current = read(key);
    if (expectedRunId !== undefined && current.id !== expectedRunId) throw Error('training_run_conflict');
    if (current.status !== 'running') return get(actor, key);
    if (!owns(current)) return clone(unknown(current));
    const cancelled: TrainingRun = {...current, status: 'cancelled', output: null, error: 'training_cancelled'};
    if (!publish(cancelled)) return get(actor, key);
    // A failed disk write must not produce an abort-only, falsely cancelled run.
    active.get(key)!.abort.abort();
    return clone(cancelled);
  }
  function close(): void {
    closed = true;
    let failure: unknown;
    for (const [key, entry] of active) {
      try {
        const current = read(key);
        if (current.status === 'running' && owns(current)) publish(unknown(current));
      } catch (error) { failure ??= error; }
      finally { entry.abort.abort(); }
    }
    if (failure) throw failure;
  }
  return {start, get, cancel, close, settled: async (key: string) => { await active.get(key)?.promise; }};
}
