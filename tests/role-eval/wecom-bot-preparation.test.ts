import {afterEach, expect, it, vi} from 'vitest';
import {offlineBotSdk} from '../fixtures/offline-bot-sdk.js';
import {createWecomBotPreparation} from '../../src/role-eval/wecom-bot-preparation.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});

function fixture(config: {connectAction?(offline: ReturnType<typeof offlineBotSdk>): void; disconnectAction?(offline: ReturnType<typeof offlineBotSdk>): void; signal?: AbortSignal} = {}) {
  const offline = offlineBotSdk();
  offline.lifecycle('disconnected');
  let phase: 'paused' | 'ready' = 'paused', arrivals = 0, writes = 0, assembled = 0, closed = 0;
  const gate = {phase: () => phase, noteArrival: () => {arrivals++;},
    beginWrite: () => phase === 'ready' ? {id: String(++writes)} : null,
    finishWrite: vi.fn((_ticket: {id: string}) => {})};
  const fingerprint = {botId: 'bot', corpId: 'corp', ownerId: 'owner', configVersion: '1', credentialFingerprint: 'synthetic-credential', workspaceFingerprint: 'synthetic-workspace'};
  let boundary: Parameters<Parameters<typeof createWecomBotPreparation>[0]['assemble']>[1] | undefined;
  const preparation = createWecomBotPreparation({mode: 'isolated-synthetic', createClient: () => offline.client,
    connect: client => {expect(client).toBe(offline.client); offline.connect.mockImplementation(() => offline.client); if (config.connectAction) config.connectAction(offline); else offline.client.connect();},
    disconnect: client => {expect(client).toBe(offline.client); offline.disconnect.mockImplementation(() => {offline.lifecycle('disconnected');}); if (config.disconnectAction) config.disconnectAction(offline); else offline.client.disconnect();},
    assemble: (_client, executionBoundary) => {assembled++; boundary = executionBoundary; return {close: () => {closed++;}, idle: async () => {}};},
    gate, readFingerprint: () => fingerprint, timeoutMs: 30, ...(config.signal ? {signal: config.signal} : {})});
  cleanup.push(() => preparation.close());
  return {offline, preparation, gate, fingerprint, boundary: () => boundary!, setPhase: (value: 'paused' | 'ready') => {phase = value;}, counts: () => ({arrivals, writes, assembled, closed})};
}

function textFrame(kind: 'text' | 'card' | 'image') {
  return kind === 'card'
    ? {cmd: 'aibot_event_callback', headers: {req_id: 'synthetic-card'}, body: {msgtype: 'event', event: {eventtype: 'template_card_event'}}}
    : {cmd: 'aibot_msg_callback', headers: {req_id: 'synthetic-message'}, body: {msgtype: kind}};
}

it('requires SDK authenticated and OPEN in one epoch, then a separate ready activation', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare();
  s.offline.lifecycle('connected');
  expect(s.preparation.status()).toBe('connecting');
  s.offline.authenticate();
  await expect(waiting).resolves.toBe('prepared');
  expect(s.preparation.status()).toBe('prepared');
  expect(s.boundary().admit()).toBe(false);
  expect(s.preparation.activate()).toBe(false);
  s.setPhase('ready');
  expect(s.preparation.activate()).toBe(true);
  expect(s.boundary().admit()).toBe(true);
});

it('rejects OPEN without authentication and cleans only the owned client on deadline', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare();
  s.offline.lifecycle('connected');
  await expect(waiting).rejects.toThrow('preparation_timeout');
  expect(s.preparation.status()).toBe('closed');
  expect(s.offline.disconnect).toHaveBeenCalledTimes(1);
  expect(s.counts().closed).toBe(1);
});

it.each(['text', 'card', 'image'] as const)('records %s as unaccepted before authentication using SDK MessageHandler', async kind => {
  const s = fixture();
  const waiting = s.preparation.prepare();
  s.offline.frame(textFrame(kind));
  await expect(waiting).rejects.toThrow('input_not_accepted');
  await s.preparation.close();
  expect(s.counts()).toMatchObject({arrivals: 1, writes: 0, closed: 1});
  expect(s.preparation.failure()).toBe('input_not_accepted');
  expect(s.boundary().admit()).toBe(false);
  s.offline.authenticate();
  expect(s.preparation.activate()).toBe(false);
});

it('rejects changed input aliases at activation and keeps late authentication closed', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare();
  s.offline.authenticate();
  await waiting;
  s.fingerprint.configVersion = '2';
  s.setPhase('ready');
  expect(s.preparation.activate()).toBe(false);
  await s.preparation.close();
  expect(s.preparation.status()).toBe('closed');
  s.offline.authenticate();
  expect(s.preparation.activate()).toBe(false);
});

it('aborts a preparation and refuses the same SDK instance a second owner', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare();
  await s.preparation.close();
  await expect(waiting).rejects.toThrow('preparation_aborted');
  expect(() => createWecomBotPreparation({mode: 'isolated-synthetic', createClient: () => s.offline.client,
    connect: () => {}, disconnect: () => {}, assemble: () => ({close() {}, async idle() {}}),
    gate: s.gate, readFingerprint: () => s.fingerprint})).toThrow('preparation_client_not_fresh');
});

it('does not resolve a synchronous authentication when the connect port then throws', async () => {
  const s = fixture({connectAction: offline => {offline.authenticate(); throw Error('synthetic_connect_failure');}});
  await expect(s.preparation.prepare()).rejects.toThrow('preparation_connect_failed');
  await s.preparation.close();
  expect(s.preparation.status()).toBe('closed');
  expect(s.preparation.activate()).toBe(false);
});

it('retains a safe owned error sink for a late SDK error after exact disconnect', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare();
  s.offline.authenticate(); await waiting;
  await s.preparation.close();
  expect(s.offline.client.listenerCount('message')).toBe(0);
  expect(s.offline.client.listenerCount('authenticated')).toBe(0);
  expect(s.offline.client.listenerCount('error')).toBe(1);
  expect(() => s.offline.lifecycle('error')).not.toThrow();
  expect(s.preparation.status()).toBe('closed');
});

it('reports cleanup uncertainty when exact owned disconnect fails', async () => {
  const s = fixture({disconnectAction: () => {throw Error('synthetic_disconnect_failure');}});
  const waiting = s.preparation.prepare();
  await expect(waiting).rejects.toThrow('preparation_timeout');
  await s.preparation.close();
  expect(s.preparation.status()).toBe('cleanup_unknown');
  expect(s.preparation.activate()).toBe(false);
});

it('cancels the bounded wait with AbortSignal and ignores late authentication', async () => {
  const controller = new AbortController(), s = fixture({signal: controller.signal});
  const waiting = s.preparation.prepare();
  controller.abort();
  await expect(waiting).rejects.toThrow('preparation_aborted');
  await s.preparation.close();
  s.offline.authenticate();
  expect(s.preparation.activate()).toBe(false);
  expect(s.counts().closed).toBe(1);
});

it('rejects a fingerprint changed during the connect wait', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare();
  s.fingerprint.credentialFingerprint = 'changed';
  s.offline.authenticate();
  await expect(waiting).rejects.toThrow('preparation_identity_changed');
  await s.preparation.close();
  expect(s.preparation.activate()).toBe(false);
});

it('revokes activation on reconnect and records later paused input as unaccepted', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare(); s.offline.authenticate(); await waiting;
  s.setPhase('ready'); expect(s.preparation.activate()).toBe(true);
  s.offline.lifecycle('reconnecting');
  await s.preparation.close();
  expect(s.boundary().admit()).toBe(false);
  s.offline.authenticate();
  expect(s.preparation.activate()).toBe(false);
});

it('records an arrival after the gate is paused again and closes the active lease', async () => {
  const s = fixture();
  const waiting = s.preparation.prepare(); s.offline.authenticate(); await waiting;
  s.setPhase('ready'); expect(s.preparation.activate()).toBe(true);
  s.setPhase('paused');
  s.offline.frame(textFrame('image'));
  await s.preparation.close();
  expect(s.counts().arrivals).toBe(1);
  expect(s.boundary().admit()).toBe(false);
});

it('rejects a factory client that already has SDK listeners without connecting or disconnecting it', () => {
  const offline = offlineBotSdk(); offline.lifecycle('disconnected');
  const external = vi.fn(); offline.client.on('message', external);
  const gate = {phase: () => 'paused' as const, noteArrival() {}, beginWrite: () => null, finishWrite() {}};
  expect(() => createWecomBotPreparation({mode: 'isolated-synthetic', createClient: () => offline.client,
    connect: () => {throw Error('must_not_connect');}, disconnect: () => {throw Error('must_not_disconnect');},
    assemble: () => ({close() {}, async idle() {}}), gate,
    readFingerprint: () => ({botId: 'bot', corpId: 'corp', ownerId: 'owner', configVersion: '1', credentialFingerprint: 'synthetic', workspaceFingerprint: 'synthetic'})})).toThrow('preparation_client_not_fresh');
  expect(offline.client.listenerCount('message')).toBe(1);
  expect(offline.connect).not.toHaveBeenCalled();
  expect(offline.disconnect).not.toHaveBeenCalled();
});
