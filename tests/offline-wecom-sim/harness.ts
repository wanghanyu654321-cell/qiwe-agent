import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFakeCallbackKeys, openCallback, sealCallback, verifySignature, type CallbackEnvelope, type FakeCallbackKeys} from '../../scripts/offline-wecom-callback-crypt.mjs';
import {createNativeBotIdentityReader} from '../../src/role-eval/native-bot-identity.js';
import {createWecomBotBindingReader} from '../../src/role-eval/wecom-bot-bindings.js';
import {createWecomBotContext, type WecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {normalizeBotFrame} from '../../src/role-eval/wecom-bot-transport.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';

const FIXTURE_PATH = new URL('../../fixtures/offline-wecom-sim/samples.json', import.meta.url);
const SAMPLE_IDS = ['normal-text-qa', 'slow-long-reply', 'unknown-unauthorized-user'] as const;
const DENIAL = '当前成员没有绑定已授权的测试员工，离线模拟已拒绝，没有调用 Frontagent。';
const MAX_REPLY_CHARS = 3500;

export interface OfflineSimSample {
  id: typeof SAMPLE_IDS[number];
  kind: 'authorized' | 'unauthorized';
  text: string;
  memberId?: string;
  mockReply?: string;
  delayMs: number;
}
export interface OfflineSimFixture {
  description: string;
  piSamples: {source: string; names: string[]; included: false; reason: string};
  channel: {botId: string; corpId: string; receiveId: string};
  employee: {label: 'B店王伊君'; storeLabel: 'B店'; storeId: string; accountId: string; memberId: string; role: 'marketing'; workspaceJid: string};
  samples: [OfflineSimSample, OfflineSimSample, OfflineSimSample];
}
export interface FrontagentCall {
  accountId: string;
  label: 'B店王伊君';
  storeId: string;
  storeLabel: 'B店';
  text: string;
  messageId: string;
}
export interface FrontagentContext {signal: AbortSignal;}
export type FrontagentStub = (call: FrontagentCall, context: FrontagentContext) => Promise<string>;
export type SimOutcome = 'replied' | 'unauthorized' | 'deadline' | 'cancelled' | 'bad_signature' | 'decrypt_failed' | 'rejected_frame' | 'unknown';
export interface MappedEmployee {label: 'B店王伊君'; storeLabel: 'B店'; storeId: string; accountId: string; memberId: string;}
export interface SimResult {
  sampleId: string | null;
  outcome: SimOutcome;
  verifiedSignature: boolean;
  employee: MappedEmployee | null;
  frontagentCalls: number;
  replyPlaintext: string | null;
  replyEnvelope: CallbackEnvelope | null;
  elapsedMs: number;
  platformAck: false;
  phoneReceived: false;
  agentRestored: false;
}
export interface RunOptions {deadlineMs?: number; signal?: AbortSignal;}
export interface OfflineSimSession {
  readonly keys: FakeCallbackKeys;
  readonly fixture: OfflineSimFixture;
  readonly bindingRow: {botId: string; corpId: string; memberId: string; accountId: string; version: number; active: boolean};
  readonly calls: FrontagentCall[];
  buildFrame(sampleId: string): Record<string, unknown>;
  seal(frame: Record<string, unknown>): CallbackEnvelope;
  run(sampleId: string, options?: RunOptions): Promise<SimResult>;
  receive(envelope: CallbackEnvelope, options?: RunOptions): Promise<SimResult>;
  assertCurrent(): Promise<void>;
  close(): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function textOf(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null;
}

export function loadOfflineSimFixture(): OfflineSimFixture {
  const parsed: unknown = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const body = record(parsed);
  const pi = record(body?.piSamples);
  const channel = record(body?.channel);
  const employee = record(body?.employee);
  const samples = Array.isArray(body?.samples) ? body.samples : null;
  const description = body?.description;
  const piSource = pi?.source;
  const piReason = pi?.reason;
  const piNames = Array.isArray(pi?.names) && pi.names.every(name => typeof name === 'string') ? pi.names : null;
  if (!body || typeof description !== 'string' || !pi || pi.included !== false || !piNames || piNames.length !== 3 || typeof piReason !== 'string' || piSource !== 'integrations/native/pi-session-recovery.mjs') throw Error('fixture_rejected');
  if (!channel || channel.botId !== 'fake-bot-offline-sim' || channel.corpId !== 'fake-corp-offline-sim' || channel.receiveId !== 'fake-corp-offline-sim') throw Error('fixture_rejected');
  const storeId = textOf(employee?.storeId, 120);
  const accountId = textOf(employee?.accountId, 120);
  const memberId = textOf(employee?.memberId, 120);
  const workspaceJid = textOf(employee?.workspaceJid, 200);
  if (!employee || employee.label !== 'B店王伊君' || employee.storeLabel !== 'B店' || employee.role !== 'marketing' || !storeId || !accountId || !memberId || !workspaceJid) throw Error('fixture_rejected');
  if (!samples || samples.length !== 3) throw Error('fixture_rejected');
  const parsedSamples = samples.map((entry, index): OfflineSimSample => {
    const sample = record(entry);
    const id = SAMPLE_IDS[index];
    const kind = sample?.kind === 'authorized' || sample?.kind === 'unauthorized' ? sample.kind : null;
    const text = textOf(sample?.text, 4000);
    if (!sample || !id || sample.id !== id || !kind || !text || !Number.isSafeInteger(sample.delayMs) || (sample.delayMs as number) < 0) throw Error('fixture_rejected');
    const sampleMember = sample.memberId === undefined ? undefined : textOf(sample.memberId, 120);
    if (sample.memberId !== undefined && !sampleMember) throw Error('fixture_rejected');
    const mockReply = sample.mockReply === undefined ? undefined : textOf(sample.mockReply, MAX_REPLY_CHARS);
    if (sample.mockReply !== undefined && !mockReply) throw Error('fixture_rejected');
    const parsed: OfflineSimSample = {id, kind, text, delayMs: sample.delayMs as number};
    if (sampleMember) parsed.memberId = sampleMember;
    if (mockReply) parsed.mockReply = mockReply;
    return parsed;
  });
  const normal = parsedSamples[0];
  const slow = parsedSamples[1];
  const unknown = parsedSamples[2];
  if (!normal || !slow || !unknown || normal.kind !== 'authorized' || slow.kind !== 'authorized' || unknown.kind !== 'unauthorized') throw Error('fixture_rejected');
  if (normal.delayMs !== 0 || slow.delayMs < 50 || !normal.mockReply || !slow.mockReply || slow.mockReply.length < 800) throw Error('fixture_rejected');
  if (!unknown.memberId || unknown.memberId === memberId || unknown.mockReply !== undefined || normal.memberId !== undefined || slow.memberId !== undefined) throw Error('fixture_rejected');
  return {
    description,
    piSamples: {source: piSource, names: piNames, included: false, reason: piReason},
    channel: {botId: 'fake-bot-offline-sim', corpId: 'fake-corp-offline-sim', receiveId: 'fake-corp-offline-sim'},
    employee: {label: 'B店王伊君', storeLabel: 'B店', storeId, accountId, memberId, role: 'marketing', workspaceJid},
    samples: [normal, slow, unknown]
  };
}

function waitForReply(work: Promise<string>, signal: AbortSignal, deadlineAt: number, caller: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const reason = () => Error(caller.aborted ? 'cancelled' : 'deadline');
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value ?? '');
    };
    const onAbort = () => finish(reason());
    const timer = setTimeout(() => finish(reason()), Math.max(0, deadlineAt - performance.now()));
    if (signal.aborted || performance.now() >= deadlineAt) { finish(reason()); return; }
    signal.addEventListener('abort', onAbort);
    work.then(value => finish(signal.aborted || performance.now() >= deadlineAt ? reason() : null, value), error => finish(signal.aborted || performance.now() >= deadlineAt ? reason() : error instanceof Error ? error : Error('unknown')));
  });
}

export function openOfflineSimSession(options?: {frontagent?: FrontagentStub}): OfflineSimSession {
  const fixture = loadOfflineSimFixture();
  const keys = createFakeCallbackKeys();
  if (keys.receiveId !== fixture.channel.receiveId || !keys.token.startsWith('fake-token-')) throw Error('fake_key_rejected');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-offline-wecom-sim-'));
  const nativeFile = path.join(directory, 'native.sqlite');
  const writer = new DatabaseSync(nativeFile);
  writer.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, status TEXT, must_change_password INTEGER);
    CREATE TABLE registered_groups(jid TEXT PRIMARY KEY, created_by TEXT, is_home INTEGER, execution_mode TEXT);`);
  writer.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(fixture.employee.accountId, 'member', 'active', 0);
  writer.prepare('INSERT INTO registered_groups VALUES (?, ?, ?, ?)').run(fixture.employee.workspaceJid, fixture.employee.accountId, 1, 'container');
  writer.close();
  const readNative = createNativeBotIdentityReader(nativeFile);
  const store = new WorkbenchAccessStore(path.join(directory, 'access.sqlite'));
  store.change('synthetic-admin', {accountId: fixture.employee.accountId, storeId: fixture.employee.storeId, roles: ['marketing'], active: true, expectedVersion: 0, requestKey: 'offline-sim-open'});
  const bindingRow = {botId: fixture.channel.botId, corpId: fixture.channel.corpId, memberId: fixture.employee.memberId, accountId: fixture.employee.accountId, version: 1, active: true};
  let currentEvent: {reqId: string; botId: string; memberId: string} | null = null;
  const api = createWecomBotContext({
    mode: 'isolated-synthetic', botId: fixture.channel.botId, corpId: fixture.channel.corpId, tenantId: 'synthetic-tenant',
    stores: [{id: fixture.employee.storeId}], roles: ['marketing'], store,
    readSubject: async () => { if (!currentEvent) throw Error('access_denied'); return {botId: currentEvent.botId, memberId: currentEvent.memberId}; },
    readBinding: createWecomBotBindingReader(async () => [bindingRow]),
    readNative
  });
  const calls: FrontagentCall[] = [];
  const seen = new Map<string, Promise<SimResult>>();
  let lastContext: WecomBotContext | null = null;
  let closed = false;
  const answerFor = (messageId: string) => fixture.samples.find(sample => messageId === `offline-sim-msg-${sample.id}`) ?? null;
  const stub: FrontagentStub = options?.frontagent ?? (async (call, context) => {
    const sample = answerFor(call.messageId);
    if (!sample || sample.kind !== 'authorized' || !sample.mockReply || call.accountId !== fixture.employee.accountId || call.label !== 'B店王伊君') throw Error('frontagent_unexpected_employee');
    if (sample.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, sample.delayMs);
        const onAbort = () => { clearTimeout(timer); reject(Error('aborted')); };
        if (context.signal.aborted) { onAbort(); return; }
        context.signal.addEventListener('abort', onAbort, {once: true});
      });
    }
    if (context.signal.aborted) throw Error('aborted');
    return sample.mockReply;
  });
  function ensureOpen() { if (closed) throw Error('context_closed'); }
  function pack(started: number, outcome: SimOutcome, verifiedSignature: boolean, sampleId: string | null, employee: MappedEmployee | null, reply: {plaintext: string; envelope: CallbackEnvelope} | null): SimResult {
    return {sampleId, outcome, verifiedSignature, employee, frontagentCalls: calls.length, replyPlaintext: reply?.plaintext ?? null, replyEnvelope: reply?.envelope ?? null, elapsedMs: performance.now() - started, platformAck: false, phoneReceived: false, agentRestored: false};
  }
  function sealReply(messageId: string, content: string): {plaintext: string; envelope: CallbackEnvelope} | null {
    if (content.length < 1 || content.length > MAX_REPLY_CHARS) return null;
    const plaintext = JSON.stringify({msgtype: 'stream', stream: {id: `offline-sim-${messageId}`, finish: true, content}});
    return {plaintext, envelope: sealCallback(keys, plaintext)};
  }
  function handle(envelope: CallbackEnvelope, run: RunOptions | undefined): Promise<SimResult> {
    const started = performance.now();
    ensureOpen();
    const budget = run?.deadlineMs ?? 2000;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 10000) throw Error('invalid_deadline');
    const deadlineAt = performance.now() + budget;
    const caller = run?.signal ?? new AbortController().signal;
    if (!verifySignature(keys, envelope)) return Promise.resolve(pack(started, 'bad_signature', false, null, null, null));
    let plaintext = '';
    try { plaintext = openCallback(keys, envelope); } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return Promise.resolve(pack(started, message === 'bad_signature' ? 'bad_signature' : 'decrypt_failed', message !== 'bad_signature', null, null, null));
    }
    let parsed: unknown;
    try { parsed = JSON.parse(plaintext); } catch { return Promise.resolve(pack(started, 'decrypt_failed', true, null, null, null)); }
    let event;
    try { event = normalizeBotFrame(parsed); } catch { return Promise.resolve(pack(started, 'rejected_frame', true, null, null, null)); }
    if (event.action.kind !== 'text') return Promise.resolve(pack(started, 'rejected_frame', true, null, null, null));
    const prior = seen.get(event.messageId);
    if (prior) return prior;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (caller.aborted) controller.abort(); else caller.addEventListener('abort', onCallerAbort, {once: true});
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - performance.now()));
    const sampleId = answerFor(event.messageId)?.id ?? null;
    const text = event.action.text;
    let resolveSeen: (value: SimResult) => void = () => undefined;
    const pending = new Promise<SimResult>(resolve => { resolveSeen = resolve; });
    seen.set(event.messageId, pending);
    void (async () => {
      const budgetName = () => caller.aborted ? 'cancelled' as const : 'deadline' as const;
      try {
        currentEvent = {reqId: event.reqId, botId: event.botId, memberId: event.memberId};
        let context: WecomBotContext;
        try {
          context = await api.authorize({correlationId: event.reqId, signal: controller.signal, deadline: deadlineAt}, 'marketing');
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (message === 'authority_cancelled' || message === 'authority_timeout') { resolveSeen(pack(started, budgetName(), true, sampleId, null, null)); return; }
          if (message === 'access_denied' || message === 'authority_unavailable') {
            const reply = sealReply(event.messageId, DENIAL);
            resolveSeen(pack(started, reply ? 'unauthorized' : 'unknown', true, sampleId, null, reply));
            return;
          }
          resolveSeen(pack(started, 'unknown', true, sampleId, null, null));
          return;
        }
        const mapped: MappedEmployee = {label: 'B店王伊君', storeLabel: 'B店', storeId: context.identity.storeId, accountId: context.identity.accountId, memberId: context.channel.memberId};
        if (mapped.accountId !== fixture.employee.accountId || mapped.storeId !== fixture.employee.storeId || mapped.memberId !== fixture.employee.memberId) {
          const reply = sealReply(event.messageId, DENIAL);
          resolveSeen(pack(started, reply ? 'unauthorized' : 'unknown', true, sampleId, null, reply));
          return;
        }
        lastContext = context;
        if (controller.signal.aborted || performance.now() >= deadlineAt) { resolveSeen(pack(started, budgetName(), true, sampleId, mapped, null)); return; }
        const call = Object.freeze({accountId: mapped.accountId, label: mapped.label, storeId: mapped.storeId, storeLabel: mapped.storeLabel, text, messageId: event.messageId});
        calls.push(call);
        let answer = '';
        try { answer = await waitForReply(stub(call, {signal: controller.signal}), controller.signal, deadlineAt, caller); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          resolveSeen(pack(started, message === 'cancelled' || message === 'deadline' ? message : 'unknown', true, sampleId, mapped, null));
          return;
        }
        if (answer !== answerFor(event.messageId)?.mockReply) { resolveSeen(pack(started, 'unknown', true, sampleId, mapped, null)); return; }
        const reply = sealReply(event.messageId, answer);
        resolveSeen(pack(started, reply ? 'replied' : 'unknown', true, sampleId, mapped, reply));
      } catch {
        resolveSeen(pack(started, 'unknown', true, sampleId, null, null));
      } finally {
        clearTimeout(timer);
        caller.removeEventListener('abort', onCallerAbort);
      }
    })();
    return pending;
  }
  return {
    keys, fixture, bindingRow, calls,
    buildFrame(sampleId) {
      const sample = fixture.samples.find(item => item.id === sampleId);
      if (!sample) throw Error('fixture_rejected');
      return {cmd: 'aibot_msg_callback', headers: {req_id: `offline-sim-req-${sample.id}`}, body: {msgid: `offline-sim-msg-${sample.id}`, aibotid: fixture.channel.botId, msgtype: 'text', chattype: 'single', create_time: 1792458000, from: {userid: sample.memberId ?? fixture.employee.memberId, corpid: fixture.channel.corpId}, text: {content: sample.text}}};
    },
    seal(frame) { ensureOpen(); return sealCallback(keys, JSON.stringify(frame)); },
    run(sampleId, runOptions) { const frame = this.buildFrame(sampleId); return handle(sealCallback(keys, JSON.stringify(frame)), runOptions); },
    receive(envelope, runOptions) { return handle(envelope, runOptions); },
    assertCurrent() { ensureOpen(); if (!lastContext) throw Error('access_denied'); return api.assertCurrent(lastContext); },
    close() {
      if (closed) return;
      closed = true;
      api.close();
      readNative.close();
      store.close();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  };
}
