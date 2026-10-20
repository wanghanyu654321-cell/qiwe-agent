import {afterEach, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ManagerArtifactStore} from '../../src/role-eval/manager-artifacts.js';
import {createWecomBotAssembly, type WecomBotAssemblyOutcome} from '../../src/role-eval/wecom-bot-assembly.js';
import {ManagerStore, type StaffContext} from '../../src/role-eval/manager-store.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
import {createNativeBotTasks} from '../../src/role-eval/native-bot-tasks.js';
import {offlineBotSdk} from '../fixtures/offline-bot-sdk.js';
import {createBotSdkAdapter} from '../../src/role-eval/wecom-bot-sdk.js';

const cleanup: (() => void)[] = [];
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close();});
const people = ['a', 'b', 'c'].map(id => ({accountId: id, memberId: 'member-' + id, employeeId: 'employee-' + id, employeeName: '合成' + id, store: id === 'c' ? 'store-c' : 'store-b'}));
function text(member: string, id: string, content = '本月销售100元') {
  return {cmd: 'aibot_msg_callback', headers: {req_id: 'req-' + id}, body: {msgid: id, aibotid: 'bot', msgtype: 'text', chattype: 'single', create_time: 1792458000, from: {userid: member, corpid: 'corp'}, text: {content}}};
}
function setup(extra: {maxInFlight?: number; requestTimeoutMs?: number} = {},controlled=false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-'));
  cleanup.push(() => fs.rmSync(dir, {recursive: true, force: true}));
  const grants = new WorkbenchAccessStore(path.join(dir, 'grants.sqlite'));
  const factFile = path.join(dir, 'existing.sqlite');
  const ledger = new ManagerStore(factFile);
  const tasks = new BotTaskStore(factFile);
  const artifacts = new ManagerArtifactStore({mode: 'isolated-synthetic', directory: path.join(dir, 'original-artifacts')});
  cleanup.push(() => grants.close(), () => ledger.close(), () => tasks.close());
  for (const p of people) grants.change('admin', {accountId: p.accountId, storeId: p.store, roles: ['manager', 'marketing'], active: true, expectedVersion: 0, requestKey: 'grant-' + p.accountId});
  const offline = offlineBotSdk(), outcomes: WecomBotAssemblyOutcome[] = [];
  const outgoing=controlled?createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client}):undefined;
  if(outgoing)cleanup.push(()=>outgoing.close());
  const readBinding = vi.fn(async (subject: {memberId: string}) => {
    const p = people.find(p => p.memberId === subject.memberId);
    if (!p) throw Error('secret_binding_error');
    return {botId: 'bot', corpId: 'corp', memberId: p.memberId, accountId: p.accountId, active: true, version: 1};
  });
  const readNative = vi.fn(async (accountId: string) => ({user: {id: accountId, role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-' + accountId}));
  const businesses = ['store-b', 'store-c'].map(store => ({scope: {tenant: 'tenant', store, workspace: 'web:original'}, employees: people.filter(p => p.store === store), ledger, artifacts, tasks: {store: tasks, catalog: []}}));
  const options = {mode: 'isolated-synthetic' as const, botId: 'bot', corpId: 'corp', client: offline.client,
    identity: {tenantId: 'tenant', stores: [{id: 'store-b'}, {id: 'store-c'}], roles: ['manager', 'marketing'] as const, store: grants, readBinding, readNative},
    businesses, sender: {sdk: outgoing??offline.sdk, fileSdk: outgoing??offline.fileSdk}, onOutcome: (outcome: WecomBotAssemblyOutcome) => {outcomes.push(outcome);}, ...extra};
  const app = createWecomBotAssembly(options); cleanup.push(() => app.close());
  const actor = (id: string): StaffContext => {const p = people.find(p => p.accountId === id)!; return {tenant: 'tenant', store: p.store, workspace: 'web:original', employeeId: p.employeeId, employeeName: p.employeeName};};
  const dispatch = async (frame: unknown) => {offline.frame(frame); await app.idle(); return outcomes.at(-1)!;};
  const counts = () => {const db = new DatabaseSync(factFile, {readOnly: true}); try {return {reports: db.prepare('SELECT COUNT(*) AS n FROM employee_reports').get()!.n, replies: db.prepare('SELECT COUNT(*) AS n FROM bot_reply_intents').get()!.n};} finally {db.close();}};
  return {app, offline, options, outcomes, dispatch, ledger, grants, tasks, actor, readBinding, readNative, counts, artifacts};
}
it('assembles the controlled SDK adapter with original ledger, nested card update, export and live revocation',async()=>{
 const s=setup({},true);s.offline.authenticate();
 const pending=(await s.dispatch(text('member-a','controlled-report'))).result!.result,card=pending.reply.body.template_card!;
 const event={cmd:'aibot_event_callback',headers:{req_id:'controlled-confirm'},body:{msgid:'controlled-confirm',aibotid:'bot',msgtype:'event',chattype:'single',from:{userid:'member-a',corpid:'corp'},event:{eventtype:'template_card_event',template_card_event:{card_type:'button_interaction',task_id:card.task_id,event_key:card.button_list[0]!.key}}}};
 expect((await s.dispatch(event)).result?.reportDelivery?.state).toBe('accepted');
 expect(s.offline.sent.at(-1)).toMatchObject({cmd:'aibot_respond_update_msg',headers:{req_id:'controlled-confirm'},body:{userids:['member-a'],template_card:{task_id:card.task_id}}});
 const before=s.offline.sent.length;expect((await s.dispatch(event)).result?.suppressed).toBe(true);expect(s.offline.sent).toHaveLength(before);
 const summary=(await s.dispatch(text('member-a','controlled-summary','经营汇总 2026-10-20 本月'))).result!.result;
 expect((await s.dispatch(text('member-a','controlled-file','导出Excel '+summary.snapshotId))).result?.delivery?.state).toBe('accepted');
 expect(s.offline.sent.at(-1)).toMatchObject({cmd:'aibot_send_msg',body:{chatid:'member-a',chat_type:1,msgtype:'file'}});
 expect(new Set(s.offline.sent.map(f=>f.headers.req_id)).size).toBe(s.offline.sent.length);
 const sent=s.offline.sent.length;s.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['manager','marketing'],active:false,expectedVersion:1,requestKey:'controlled-revoke'});
 expect((await s.dispatch(text('member-a','controlled-denied','查询 '+pending.reportId))).state).toBe('rejected');
 expect(s.offline.sent).toHaveLength(sent);expect(s.ledger.getReport(s.actor('a'),pending.reportId!)?.entries[0]?.amountCents).toBe(10000);
});

it('runs installed SDK events with separate A/B/C authority on one ledger, card confirmation, query and replay', async () => {
  const s = setup(); s.offline.authenticate();
  for (const p of people) s.offline.frame(text(p.memberId, 'report-' + p.accountId));
  await s.app.idle();
  expect(s.outcomes.map(o => o.result?.result.status)).toEqual(['pending', 'pending', 'pending']);
  const ids = s.outcomes.map(o => o.result!.result.reportId!);
  expect(new Set(ids).size).toBe(3);
  for (let i = 0; i < people.length; i++) {
    const p = people[i]!, card = s.outcomes[i]!.result!.result.reply.body.template_card!;
    const frame = {cmd: 'aibot_event_callback', headers: {req_id: 'confirm-' + p.accountId}, body: {msgid: 'confirm-' + p.accountId, aibotid: 'bot', msgtype: 'event', chattype: 'single', from: {userid: p.memberId, corpid: 'corp'}, event: {eventtype: 'template_card_event', task_id: card.task_id, event_key: card.button_list[0]!.key}}};
    expect((await s.dispatch(frame)).result?.result.status).toBe('confirmed');
    expect(s.offline.sent.at(-1)).toMatchObject({cmd:'aibot_respond_update_msg',headers:{req_id:'confirm-'+p.accountId},body:{response_type:'update_template_card',userids:[p.memberId],template_card:{task_id:card.task_id,main_title:{title:'已入账，可查回'}}}});
    const count = s.offline.sent.length;
    expect((await s.dispatch(frame)).result?.suppressed).toBe(true);
    expect(s.offline.sent.length).toBe(count);
    expect(s.ledger.getReport(s.actor(p.accountId), ids[i]!)?.entries[0]?.amountCents).toBe(10000);
    expect((await s.dispatch(text(p.memberId, 'query-' + p.accountId, '查询 ' + ids[i]))).result?.result.status).toBe('confirmed');
  }
  expect((await s.dispatch(text('member-b', 'foreign', '查询 ' + ids[0]))).result?.result.status).toBe('not-found');
  expect((await s.dispatch(text('member-c', 'task', '查询任务 marketing ' + 'a'.repeat(64)))).result?.result.taskStatus).toBe('not-found');
  for (const p of people) {
    const summary = await s.dispatch(text(p.memberId, 'summary-' + p.accountId, '经营汇总 2026-10-20 本月'));
    expect(summary.result?.result.status).toBe('summary');
    const id = summary.result!.result.snapshotId!;
    const owner = {accountId: p.accountId, actor: s.actor(p.accountId)};
    expect(s.artifacts.read(owner, id)?.salesCents).toBe(p.accountId === 'c' ? 10000 : 20000);
    const file = await s.dispatch(text(p.memberId, 'export-' + p.accountId, '导出Excel ' + id));
    expect(file.result?.delivery?.state).toBe('accepted');
    expect(Buffer.from(s.artifacts.artifact(owner, id)!.bytes.subarray(0, 2)).toString()).toBe('PK');
    expect(s.offline.sent.at(-1)?.body).toMatchObject({chatid: p.memberId, msgtype: 'file', chat_type: 1, file: {media_id: 'synthetic-media'}});
    const count = s.offline.sent.length;
    expect((await s.dispatch(text(p.memberId, 'summary-query-' + p.accountId, '查询汇总 ' + id))).result?.result.status).toBe('summary');
    expect(s.offline.sent.length).toBe(count + 1);
    expect(s.offline.sent.at(-1)?.body.msgtype).toBe('stream');
  }
  expect(s.offline.sent[0]).toMatchObject({cmd: 'aibot_respond_msg', headers: {req_id: 'req-report-a'}, body: {msgtype: 'stream_with_template_card'}});
  expect(s.offline.connect).not.toHaveBeenCalled();
});

it('requires a fresh authentication and rejects malformed, mismatched and unmapped events without business writes', async () => {
  const s = setup();
  expect((await s.dispatch(text('member-a', 'initial'))).detail).toBe('not_authenticated');
  s.offline.authenticate();
  const invalid = [text('unknown', 'unknown'), text('member-a', 'wrong-bot'), text('member-a', 'wrong-corp'), text('member-a', 'group'), text('member-a', 'missing-single')];
  invalid[1]!.body.aibotid = 'foreign'; invalid[2]!.body.from.corpid = 'foreign'; invalid[3]!.body.chattype = 'group'; Reflect.deleteProperty(invalid[4]!.body, 'chattype');
  for (const frame of invalid) expect((await s.dispatch(frame)).state).toBe('rejected');
  expect(s.offline.sent).toEqual([]);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(s.ledger.summary(s.actor('a'), '2026-10-20', 'month').salesCents).toBeNull();
  s.grants.change('admin', {accountId: 'a', storeId: 'store-c', roles: ['manager'], active: true, expectedVersion: 1, requestKey: 'move'});
  expect((await s.dispatch(text('member-a', 'cross-store'))).state).toBe('rejected');
  expect(s.offline.sent).toEqual([]);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(JSON.stringify(s.outcomes)).not.toContain('secret_binding_error');
});

it.each(['connected', 'disconnected', 'reconnecting', 'error', 'kicked'] as const)('invalidates an in-flight reader on %s; old epoch cannot send or write after reauthentication', async kind => {
  const s = setup(); s.offline.authenticate();
  let release!: () => void;
  const wait = new Promise<void>(resolve => {release = resolve;});
  s.readNative.mockImplementationOnce(async accountId => {await wait; return {user: {id: accountId, role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-' + accountId};});
  s.offline.frame(text('member-a', 'late')); await vi.waitFor(() => expect(s.readNative).toHaveBeenCalled());
  if (kind === 'kicked') s.offline.frame({cmd: 'aibot_event_callback', headers: {req_id: 'kick'}, body: {msgtype: 'event', event: {eventtype: 'disconnected_event'}}});
  else s.offline.lifecycle(kind);
  s.offline.authenticate(); release(); await s.app.idle();
  expect(s.offline.sent).toEqual([]);
  expect(s.counts()).toEqual({reports: 0, replies: 0});
  expect(s.outcomes.at(-1)?.state).toBe('rejected');
  expect((await s.dispatch(text('member-b', 'new-session'))).result?.result.status).toBe('pending');
});

it('bounds concurrency, snapshots frames, contains observer errors and only closes owned resources', async () => {
  const s = setup({maxInFlight: 1}); s.offline.authenticate();
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  s.readBinding.mockImplementationOnce(async subject => {await wait; return {botId: 'bot', corpId: 'corp', memberId: subject.memberId, accountId: 'a', active: true, version: 1};});
  const frame = text('member-a', 'snap'); s.offline.frame(frame); frame.body.from.userid = 'member-b'; frame.body.text.content = '本月销售999元';
  s.offline.frame(text('member-c', 'over-capacity'));
  expect(s.outcomes.at(-1)?.detail).toBe('capacity_exceeded');
  release(); await s.app.idle();
  expect(s.outcomes.at(-1)?.result?.result.status).toBe('pending');
  const id = s.outcomes.at(-1)!.result!.result.reportId!;
  expect(s.ledger.getReport(s.actor('a'), id)?.proposed.items[0]?.amountCents).toBe(10000);
  expect(s.ledger.getReport(s.actor('b'), id)).toBeUndefined();
  expect(() => createWecomBotAssembly(s.options)).toThrow('assembly_already_attached');
  const external = vi.fn(); s.offline.client.on('message.text', external);
  s.app.close(); s.app.close();
  s.offline.frame(text('member-a', 'closed')); await s.app.idle();
  expect(external).toHaveBeenCalledTimes(1);
  expect(s.offline.disconnect).not.toHaveBeenCalled();
  expect(s.grants.get('a')?.active).toBe(true);
  expect(s.tasks.get({tenantId: 'tenant', storeId: 'store-b', accountId: 'a', workspaceJid: 'web:home-a', corpId: 'corp', botId: 'bot', memberId: 'member-a', bindingVersion: 1, role: 'marketing'}, 'f'.repeat(64))).toBeUndefined();
  const other = createWecomBotAssembly({...s.options, onOutcome: () => {throw Error('observer_failure');}}); cleanup.push(() => other.close());
  s.offline.authenticate(); s.offline.frame(text('member-b', 'observer')); await other.idle();
  expect(s.offline.sent.at(-1)?.headers.req_id).toBe('req-observer');
});

it('aborts private work at close and request timeout and ignores late reader results', async () => {
  for (const close of [true, false]) {
    const s = setup({requestTimeoutMs: 20}); s.offline.authenticate();
    let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
    s.readBinding.mockImplementationOnce(async subject => {await wait; return {botId: 'bot', corpId: 'corp', memberId: subject.memberId, accountId: 'a', active: true, version: 1};});
    s.offline.frame(text('member-a', 'aborted')); if (close) s.app.close();
    await s.app.idle(); release(); await Promise.resolve();
    expect(s.offline.sent).toEqual([]);
    expect(s.outcomes.at(-1)?.state).toBe('rejected');
  }
});

it('runs actual SDK proactive serialization and media fragmentation only over replaced transport', async () => {
  const s = offlineBotSdk();
  await s.sdk.sendMessage('synthetic-member', {msgtype: 'markdown', markdown: {content: '合成通知'}});
  const media = await s.fileSdk.uploadMedia(Buffer.alloc(512 * 1024 + 1, 7), {type: 'file', filename: 'synthetic.xlsx'});
  expect(media).toMatchObject({type: 'file', media_id: 'synthetic-media'});
  await s.fileSdk.sendMessage('synthetic-member', {msgtype: 'file', chat_type: 1, file: {media_id: 'synthetic-media'}});
  expect(s.sent.map(f => f.cmd)).toEqual(['aibot_send_msg', 'aibot_upload_media_init', 'aibot_upload_media_chunk', 'aibot_upload_media_chunk', 'aibot_upload_media_finish', 'aibot_send_msg']);
  expect(s.sent[0]!.body).toMatchObject({chatid: 'synthetic-member', msgtype: 'markdown'});
  expect(s.sent.at(-1)!.body).toMatchObject({chatid: 'synthetic-member', msgtype: 'file', chat_type: 1});
  expect(s.connect).not.toHaveBeenCalled();
});

it('retains committed business and records an interrupted attempted send as unknown without replaying or accepting its late ACK', async () => {
  const s = setup(); s.offline.authenticate();
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  s.offline.setAcknowledge(async frame => {await wait; return {headers: frame.headers, errcode: 0};});
  const frame = text('member-a', 'send-started'); s.offline.frame(frame);
  await vi.waitFor(() => expect(s.offline.sent).toHaveLength(1));
  const replyId = createHash('sha256').update(JSON.stringify(['corp', 'bot', 'member-a', 'send-started'])).digest('hex');
  const before = s.ledger.getBotReply(s.actor('a'), replyId)!;
  expect(before.delivery.state).toBe('attempting');
  expect(s.ledger.getReport(s.actor('a'), before.reportId!)?.state).toBe('pending');
  s.offline.lifecycle('disconnected'); await s.app.idle();
  expect(s.ledger.getBotReply(s.actor('a'), replyId)?.delivery.state).toBe('unknown');
  release(); await Promise.resolve(); s.offline.authenticate();
  expect((await s.dispatch(frame)).result?.suppressed).toBe(true);
  expect(s.offline.sent).toHaveLength(1);
  expect(s.ledger.getBotReply(s.actor('a'), replyId)?.delivery.state).toBe('unknown');
});

it('uses the task command role while preserving manager-role denial and rejects revocation before reserving business', async () => {
  const s = setup(); s.offline.authenticate();
  s.grants.change('admin', {accountId: 'a', storeId: 'store-b', roles: ['marketing'], active: true, expectedVersion: 1, requestKey: 'marketing-only'});
  expect((await s.dispatch(text('member-a', 'role-query', '查询任务 marketing ' + 'c'.repeat(64)))).result?.result.taskStatus).toBe('not-found');
  const before = s.counts();
  expect((await s.dispatch(text('member-a', 'role-denied'))).state).toBe('rejected');
  expect(s.counts()).toEqual(before);
  let reads = 0;
  s.readNative.mockImplementation(async accountId => {
    if (++reads === 3) s.grants.change('admin', {accountId: 'b', storeId: 'store-b', roles: ['manager'], active: false, expectedVersion: 1, requestKey: 'revoke-b'});
    return {user: {id: accountId, role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-' + accountId};
  });
  expect((await s.dispatch(text('member-b', 'revoked'))).state).toBe('rejected');
  expect(s.counts()).toEqual(before);
});

it.each([
  {requestTimeoutMs: 0}, {requestTimeoutMs: 4001}, {requestTimeoutMs: 1.5},
  {maxInFlight: 0}, {maxInFlight: 1.5}, {maxInFlight: 1025},
])('rejects invalid bounded configuration %j without taking over the SDK', config => {
  const s = setup(); s.app.close();
  expect(() => createWecomBotAssembly({...s.options, ...config})).toThrow('invalid_bot_assembly');
  expect(s.offline.client.listenerCount('message.text')).toBe(0);
  expect(s.offline.connect).not.toHaveBeenCalled();
});

it('does not route unsupported SDK message types and refuses missing single attribution on card events', async () => {
  const s = setup(); s.offline.authenticate();
  s.offline.frame({cmd: 'aibot_msg_callback', headers: {req_id: 'image'}, body: {msgtype: 'image', aibotid: 'bot', msgid: 'image', chattype: 'single', from: {userid: 'member-a'}, image: {url: 'https://example.invalid/synthetic'}}});
  await s.app.idle();
  expect(s.outcomes).toEqual([]);
  const result = (await s.dispatch(text('member-a', 'card-source'))).result!.result;
  const card = result.reply.body.template_card!;
  const count = s.counts(), sends = s.offline.sent.length;
  expect((await s.dispatch({cmd: 'aibot_event_callback', headers: {req_id: 'missing-chat'}, body: {aibotid: 'bot', msgid: 'missing-chat', msgtype: 'event', from: {userid: 'member-a'}, event: {eventtype: 'template_card_event', task_id: card.task_id, event_key: card.button_list[0]!.key}}})).detail).toBe('unsupported_event');
  expect(s.counts()).toEqual(count);
  expect(s.offline.sent.length).toBe(sends);
  expect(s.ledger.getReport(s.actor('a'), result.reportId!)?.state).toBe('pending');
});

it.each([false, true])('captures training enablement (%s) and resolver at assembly creation despite later options mutation', async initiallyEnabled => {
  const s = setup(); s.app.close();
  // Explicit training permission makes this a capability configuration test, not a grant denial.
  s.grants.change('admin', {accountId: 'a', storeId: 'store-b', roles: ['manager', 'marketing', 'training'], active: true, expectedVersion: 1, requestKey: 'training-grant'});
  const originalResolve = vi.fn(() => {throw Error('synthetic_original_service_unavailable');});
  const substitutedResolve = vi.fn(() => {throw Error('late_unapproved_service');});
  const training = {enabled: initiallyEnabled, resolve: originalResolve};
  const app = createWecomBotAssembly({...s.options,
    identity: {...s.options.identity, roles: ['manager', 'marketing', 'training']},
    businesses: s.options.businesses.map(b => ({...b, tasks: {...b.tasks, training}})),
  });
  cleanup.push(() => app.close());
  training.enabled = true; training.resolve = substitutedResolve;
  s.offline.authenticate(); s.offline.frame(text('member-a', 'training-config', '培训问答 指导员 合成问题')); await app.idle();
  expect(s.outcomes.at(-1)?.result?.result.taskStatus).toBe('blocked');
  expect(substitutedResolve).not.toHaveBeenCalled();
  expect(originalResolve).toHaveBeenCalledTimes(initiallyEnabled ? 1 : 0);
});

it('captures Native methods at assembly creation while keeping the shared service lifecycle with its caller', async () => {
  const s = setup(); s.app.close();
  const native = createNativeBotTasks(); cleanup.push(() => native.close());
  const originalStart = vi.fn(async () => ({state: 'linked' as const, referenceId: 'existing-run', detail: 'synthetic_occurrence'}));
  const originalQuery = vi.fn(async () => ({status: 'running', output: null, detail: 'synthetic_query'}));
  const originalCancel = vi.fn(async () => ({state: 'requested' as const, detail: 'synthetic_cancel'}));
  native.start = originalStart; native.query = originalQuery; native.cancel = originalCancel;
  const sharedClose = vi.spyOn(native, 'close');
  const catalog = [{tenantId: 'tenant', storeId: 'store-b', accountId: 'a', homeJid: 'web:home-a', role: 'marketing' as const, alias: 'weekly', taskId: 'existing-task', profileId: 'existing-profile', workspaceJid: 'web:existing-role'}];
  const app = createWecomBotAssembly({...s.options, businesses: s.options.businesses.map(b => ({...b, tasks: {...b.tasks, catalog, native}}))});
  cleanup.push(() => app.close());
  const substitutedStart = vi.fn(async () => ({state: 'blocked' as const, detail: 'late_unapproved_start'}));
  const substitutedQuery = vi.fn(async () => ({status: 'unknown', output: null, detail: 'late_unapproved_query'}));
  const substitutedCancel = vi.fn(async () => ({state: 'blocked' as const, detail: 'late_unapproved_cancel'}));
  native.start = substitutedStart; native.query = substitutedQuery; native.cancel = substitutedCancel;
  s.offline.authenticate();
  s.offline.frame(text('member-a', 'native-start', '执行任务 marketing weekly')); await app.idle();
  const result = s.outcomes.at(-1)!.result!.result;
  expect(result.taskStatus).toBe('running');
  s.offline.frame(text('member-a', 'native-query', '查询任务 marketing ' + result.taskId)); await app.idle();
  s.offline.frame(text('member-a', 'native-cancel', '取消任务 marketing ' + result.taskId)); await app.idle();
  expect(s.outcomes.at(-1)?.result?.result.reply.body.stream.content).toContain('取消请求：已受理');
  expect(originalStart).toHaveBeenCalledTimes(1); expect(originalQuery).toHaveBeenCalledTimes(3); expect(originalCancel).toHaveBeenCalledTimes(1);
  expect(substitutedStart).not.toHaveBeenCalled(); expect(substitutedQuery).not.toHaveBeenCalled(); expect(substitutedCancel).not.toHaveBeenCalled();
  app.close(); expect(sharedClose).not.toHaveBeenCalled();
});
