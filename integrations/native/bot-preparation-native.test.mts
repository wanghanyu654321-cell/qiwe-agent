import {expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAppointmentBootGate} from '../src/appointment-boot-gate.js';
import {createWecomBotPreparation} from '../test-support/wecom-bot-preparation.mjs';
import {createWecomBotAssembly} from '../test-support/wecom-bot-assembly.mjs';
import {createBotSdkAdapter} from '../test-support/wecom-bot-sdk.mjs';
import {WorkbenchAccessStore} from '../test-support/workbench-access.mjs';
import {ManagerStore} from '../test-support/manager-store.mjs';
import {offlineBotSdk} from '../test-support/offline-bot-sdk.mjs';

function frame(id: string, text = '本月销售100元') {
  return {cmd: 'aibot_msg_callback', headers: {req_id: 'req-' + id}, body: {
    msgid: id, aibotid: 'bot', msgtype: 'text', chattype: 'single',
    from: {userid: 'member', corpid: 'corp'}, text: {content: text},
  }};
}
function fixture(mode: 'original' | 'appointment', authError = 0) {
  const gate = createAppointmentBootGate(mode), offline = offlineBotSdk();
  const calls = {writes: vi.spyOn(gate, 'beginWrite'), finished: vi.spyOn(gate, 'finishWrite'), arrivals: vi.spyOn(gate, 'noteArrival')};
  offline.lifecycle('disconnected');
  const manager = Reflect.get(offline.client, 'wsManager') as {handleFrame(frame: unknown): void; disconnect(): void};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qiwe-preparation-native-'));
  const grants = new WorkbenchAccessStore(path.join(root, 'grants.sqlite'));
  const ledger = new ManagerStore(path.join(root, 'ledger.sqlite'));
  grants.change('admin', {accountId: 'account', storeId: 'store', roles: ['manager'],
    active: true, expectedVersion: 0, requestKey: 'synthetic-grant'});
  const fingerprint = {botId: 'bot', corpId: 'corp', ownerId: 'account', configVersion: '1',
    credentialFingerprint: 'synthetic-credential-hash', workspaceFingerprint: 'synthetic-workspace-hash'};
  const outcomes: any[] = [];
  let app: any, adapter: any, waitRead: (() => Promise<void>) | undefined;
  const readNative = vi.fn(async () => {
    if (waitRead) await waitRead();
    return {user: {id: 'account', role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-account'};
  });
  const preparation = createWecomBotPreparation({
    mode: 'isolated-synthetic', gate, createClient: () => offline.client,
    connect: () => {offline.lifecycle('connected'); manager.handleFrame({headers: {req_id: 'aibot_subscribe_synthetic'}, errcode: authError});},
    disconnect: () => {offline.lifecycle('disconnected'); manager.disconnect();},
    assemble: (client: any, executionBoundary: any) => {
      adapter = createBotSdkAdapter({mode: 'isolated-synthetic', client});
      app = createWecomBotAssembly({mode: 'isolated-synthetic', client, botId: 'bot', corpId: 'corp', executionBoundary,
        identity: {tenantId: 'tenant', stores: [{id: 'store'}], roles: ['manager'], store: grants,
          readBinding: async () => ({botId: 'bot', corpId: 'corp', memberId: 'member', accountId: 'account', active: true, version: 1}), readNative},
        businesses: [{scope: {tenant: 'tenant', store: 'store', workspace: 'web:original'},
          employees: [{accountId: 'account', employeeId: 'employee', employeeName: '合成员工'}], ledger}],
        sender: {sdk: adapter}, onOutcome: (outcome: any) => outcomes.push(outcome),
      });
      return {close: () => {app.close(); adapter.close();}, idle: () => app.idle()};
    },
    readFingerprint: () => fingerprint, timeoutMs: 1000,
  });
  return {gate, offline, fingerprint, outcomes, preparation, calls, app: () => app,
    counts: () => {
      const db = new DatabaseSync(path.join(root, 'ledger.sqlite'), {readOnly: true});
      try {return {reports: db.prepare('SELECT COUNT(*) AS n FROM employee_reports').get()!.n,
        replies: db.prepare('SELECT COUNT(*) AS n FROM bot_reply_intents').get()!.n};}
      finally {db.close();}
    },
    pauseReader: (read: () => Promise<void>) => {waitRead = read;},
    async close() {
      await preparation.close(); await app.idle(); grants.close(); ledger.close();
      const resolved = fs.realpathSync(root);
      expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));
      expect(path.basename(resolved)).toMatch(/^qiwe-preparation-native-/);
      fs.rmSync(resolved, {recursive: true, force: true});
    }};
}

it('installed SDK through owned preparation and actual appointment gate never accepts business during maintenance', async () => {
  const s = fixture('appointment'), {arrivals, writes} = s.calls;
  try {
    await expect(s.preparation.prepare()).resolves.toBe('prepared');
    expect(s.preparation.activate()).toBe(false);
    s.offline.frame(frame('paused'));
    await s.app().idle();
    expect(arrivals).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(s.offline.sent).toEqual([]); expect(s.outcomes).toEqual([]);
    expect(s.counts()).toEqual({reports: 0, replies: 0});
    expect(s.gate.phase()).toBe('paused');
    expect(s.offline.connect).not.toHaveBeenCalled();
  } finally {await s.close(); vi.restoreAllMocks();}
});

it('the installed SDK rejects a nonzero subscription ACK before controller preparation', async () => {
  const s = fixture('appointment', 40001);
  try {
    await expect(s.preparation.prepare()).rejects.toThrow('connection_error');
    expect(s.preparation.activate()).toBe(false);
    expect(s.counts()).toEqual({reports: 0, replies: 0}); expect(s.offline.sent).toEqual([]);
    expect(s.gate.phase()).toBe('paused');
  } finally {await s.close(); vi.restoreAllMocks();}
});

it('installed SDK, owned prepare, actual original gate and existing assembly share real write tickets and ledger', async () => {
  const s = fixture('original'), {writes, finished} = s.calls;
  try {
    await s.preparation.prepare();
    expect(s.offline.sent).toEqual([]); expect(s.outcomes).toEqual([]);
    expect(s.preparation.activate()).toBe(true);
    s.offline.frame(frame('original-report')); await s.app().idle();
    expect(s.outcomes.at(-1)?.result?.result?.status).toBe('pending');
    expect(s.counts()).toEqual({reports: 1, replies: 1});
    expect(s.offline.sent).toHaveLength(1); expect(writes).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledExactlyOnceWith(writes.mock.results[0]!.value);
    s.offline.lifecycle('disconnected');
    s.offline.frame(frame('after-disconnect')); await s.app().idle();
    expect(s.offline.sent).toHaveLength(1); expect(writes).toHaveBeenCalledTimes(1);
    expect(s.preparation.activate()).toBe(false);
    expect(s.gate.phase()).toBe('ready'); // Original mode was already ready; no appointment restore occurred.
  } finally {await s.close(); vi.restoreAllMocks();}
});

it('fingerprint changes during actual authority read prevent the first ledger mutation in the same request', async () => {
  const s = fixture('original'), {writes, finished} = s.calls;
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>(resolve => {entered = resolve;});
  const blocked = new Promise<void>(resolve => {release = resolve;});
  try {
    await s.preparation.prepare(); expect(s.preparation.activate()).toBe(true);
    s.pauseReader(async () => {entered(); await blocked;});
    s.offline.frame(frame('changed-during-read')); await reading;
    s.fingerprint.configVersion = '2'; release(); await s.app().idle();
    expect(s.outcomes.at(-1)?.state).toBe('rejected'); expect(s.offline.sent).toEqual([]);
    expect(s.counts()).toEqual({reports: 0, replies: 0});
    expect(writes).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledExactlyOnceWith(writes.mock.results[0]!.value);
  } finally {release?.(); await s.close(); vi.restoreAllMocks();}
});
