import fs from 'node:fs';
import {it, expect} from 'vitest';
import {openCallback, signCallback, createFakeCallbackKeys, type CallbackEnvelope} from '../scripts/offline-wecom-callback-crypt.mjs';
// @ts-expect-error Plain JavaScript module with no declaration in this checkout.
import {requiredPiOfflineSamples} from '../integrations/native/pi-session-recovery.mjs';
import {loadOfflineSimFixture, openOfflineSimSession, type FrontagentCall, type OfflineSimSession} from './offline-wecom-sim/harness.js';

const denialMark = '没有绑定';

function replyBody(session: OfflineSimSession, envelope: CallbackEnvelope) {
  return JSON.parse(openCallback(session.keys, envelope)) as {msgtype: string; errcode?: unknown; stream: {id: string; finish: boolean; content: string}};
}

it('loads three synthetic callback samples and leaves the named Pi samples closed', () => {
  const fixture = loadOfflineSimFixture();
  expect(fixture.samples.map(sample => sample.id)).toEqual(['normal-text-qa', 'slow-long-reply', 'unknown-unauthorized-user']);
  expect(fixture.employee.label).toBe('B店王伊君');
  expect(fixture.employee.storeLabel).toBe('B店');
  expect(fixture.piSamples.included).toBe(false);
  expect(fixture.piSamples.names).toEqual(requiredPiOfflineSamples());
  expect(fs.readdirSync(new URL('../fixtures/offline-wecom-sim/', import.meta.url)).some(name => name.endsWith('.jsonl'))).toBe(false);
});

it('generates a fresh fake key in memory and does not read a channel secret', () => {
  const previous = process.env.WECOM_BOT_SECRET;
  process.env.WECOM_BOT_SECRET = 'not-a-real-secret';
  try {
    const first = createFakeCallbackKeys();
    const second = createFakeCallbackKeys();
    expect(first.label).toBe('offline-simulation-fake-keys');
    expect(first.token.startsWith('fake-token-')).toBe(true);
    expect(first.encodingAESKey).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(first.receiveId).toBe('fake-corp-offline-sim');
    expect(first.token).not.toBe(second.token);
    expect(first.encodingAESKey).not.toBe(second.encodingAESKey);
    expect(JSON.stringify(first).includes('not-a-real-secret')).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.WECOM_BOT_SECRET;
    else process.env.WECOM_BOT_SECRET = previous;
  }
});

it('maps a normal text callback to B店王伊君, asks the Frontagent stub once, and encrypts that reply', async () => {
  const session = openOfflineSimSession();
  try {
    const frame = session.buildFrame('normal-text-qa');
    const envelope = session.seal(frame);
    const body = frame.body as {from: {userid: string}; text: {content: string}};
    body.from.userid = 'fake-wecom-userid-unknown';
    body.text.content = '请改成别人的身份';
    const result = await session.receive(envelope);
    const sample = session.fixture.samples[0];
    expect(result.outcome).toBe('replied');
    expect(result.platformAck).toBe(false);
    expect(result.phoneReceived).toBe(false);
    expect(result.agentRestored).toBe(false);
    expect(result.employee).toEqual({label: 'B店王伊君', storeLabel: 'B店', storeId: session.fixture.employee.storeId, accountId: session.fixture.employee.accountId, memberId: session.fixture.employee.memberId});
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]).toMatchObject({label: 'B店王伊君', accountId: session.fixture.employee.accountId, text: sample.text});
    expect(Reflect.set(session.calls[0] as FrontagentCall, 'text', 'changed')).toBe(false);
    const opened = replyBody(session, result.replyEnvelope!);
    expect(opened.msgtype).toBe('stream');
    expect(opened.errcode).toBeUndefined();
    expect(opened.stream.finish).toBe(true);
    expect(opened.stream.content).toBe(sample.mockReply);
    session.bindingRow.version = 2;
    expect(result.employee?.accountId).toBe(session.fixture.employee.accountId);
    await expect(session.assertCurrent()).rejects.toThrow('access_changed');
    expect(session.calls).toHaveLength(1);
    const replay = await session.run('normal-text-qa');
    expect(replay.outcome).toBe('replied');
    expect(session.calls).toHaveLength(1);
  } finally { session.close(); }
});

it('waits for the slow stub and returns the long reply unchanged', async () => {
  const session = openOfflineSimSession();
  try {
    const sample = session.fixture.samples[1];
    const result = await session.run('slow-long-reply');
    expect(result.outcome).toBe('replied');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(sample.delayMs - 15);
    expect(session.calls).toHaveLength(1);
    const opened = replyBody(session, result.replyEnvelope!);
    expect(opened.stream.content).toBe(sample.mockReply);
    expect(opened.stream.content.length).toBeGreaterThanOrEqual(800);
  } finally { session.close(); }
});

it('drops a late stub answer after cancel and does not call Frontagent again', async () => {
  let release: (value: string) => void = () => undefined;
  const session = openOfflineSimSession({frontagent: () => new Promise(resolve => { release = resolve; })});
  try {
    const controller = new AbortController();
    const pending = session.run('normal-text-qa', {signal: controller.signal, deadlineMs: 2000});
    const started = Date.now();
    while (session.calls.length === 0 && Date.now() - started < 1000) await new Promise(resolve => setTimeout(resolve, 5));
    expect(session.calls).toHaveLength(1);
    controller.abort();
    release('迟到的答案不能加密送出');
    const result = await pending;
    expect(result.outcome).toBe('cancelled');
    expect(result.replyEnvelope).toBeNull();
    expect(result.replyPlaintext).toBeNull();
    const replay = await session.run('normal-text-qa');
    expect(replay.outcome).toBe('cancelled');
    expect(session.calls).toHaveLength(1);
  } finally { session.close(); }
});

it('stops a slow reply at the deadline and does not retry', async () => {
  const session = openOfflineSimSession({frontagent: (_call, context) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(Error('late')), 5000);
    context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('aborted')); }, {once: true});
  })});
  try {
    const result = await session.run('slow-long-reply', {deadlineMs: 200});
    expect(result.outcome).toBe('deadline');
    expect(result.replyEnvelope).toBeNull();
    expect(session.calls).toHaveLength(1);
    const replay = await session.run('slow-long-reply', {deadlineMs: 200});
    expect(replay.outcome).toBe('deadline');
    expect(session.calls).toHaveLength(1);
  } finally { session.close(); }
});

it('rejects an unbound member without calling Frontagent', async () => {
  const session = openOfflineSimSession();
  try {
    const result = await session.run('unknown-unauthorized-user');
    expect(result.outcome).toBe('unauthorized');
    expect(result.employee).toBeNull();
    expect(session.calls).toHaveLength(0);
    const opened = replyBody(session, result.replyEnvelope!);
    expect(opened.stream.content).toContain(denialMark);
    expect(opened.stream.content.includes('王伊君')).toBe(false);
    expect(opened.stream.content.includes(session.fixture.samples[0].mockReply ?? '')).toBe(false);
    expect(opened.stream.content.includes(session.fixture.samples[1].mockReply ?? '')).toBe(false);
    expect(opened.errcode).toBeUndefined();
  } finally { session.close(); }
});

it('stops before identity when the signature or ciphertext is wrong', async () => {
  const session = openOfflineSimSession();
  try {
    const envelope = session.seal(session.buildFrame('normal-text-qa'));
    const badSignature = {...envelope, msg_signature: envelope.msg_signature.slice(0, 39) + (envelope.msg_signature.endsWith('0') ? '1' : '0')};
    const rejected = await session.receive(badSignature);
    expect(rejected.outcome).toBe('bad_signature');
    expect(rejected.verifiedSignature).toBe(false);
    expect(session.calls).toHaveLength(0);
    const tampered = {...envelope, encrypt: envelope.encrypt.slice(0, -4) + 'AAAA'};
    tampered.msg_signature = signCallback(session.keys, tampered);
    const broken = await session.receive(tampered);
    expect(broken.outcome).toBe('decrypt_failed');
    expect(session.calls).toHaveLength(0);
  } finally { session.close(); }
});

it('keeps the offline harness free of live endpoints and pilot switches', () => {
  const files = [
    new URL('../scripts/offline-wecom-callback-crypt.mjs', import.meta.url),
    new URL('../scripts/offline-wecom-sim.mjs', import.meta.url),
    new URL('./offline-wecom-sim/harness.ts', import.meta.url),
    new URL('../fixtures/offline-wecom-sim/samples.json', import.meta.url)
  ];
  const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  for (const marker of ['api.deepseek.com', 'work.weixin.qq.com', 'controlled-real-pilot', 'run-live-preflight', 'WECOM_BOT_SECRET']) {
    expect(source.includes(marker)).toBe(false);
  }
});
