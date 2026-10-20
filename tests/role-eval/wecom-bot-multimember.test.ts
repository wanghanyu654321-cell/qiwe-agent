import {afterEach, expect, it} from 'vitest';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import AdmZip from 'adm-zip';
import {ManagerStore, type StaffContext} from '../../src/role-eval/manager-store.js';
import {ManagerArtifactStore} from '../../src/role-eval/manager-artifacts.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotDelivery} from '../../src/role-eval/wecom-bot-delivery.js';
import {createBotSender} from '../../src/role-eval/wecom-bot-sender.js';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
import {createBotTasks} from '../../src/role-eval/wecom-bot-tasks.js';
import {createNativeBotTasks} from '../../src/role-eval/native-bot-tasks.js';
import {createTrainingGenerationService} from '../../src/role-eval/training-generation.js';
import {createTrainingSummaryService} from '../../src/role-eval/training-knowledge.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const people = [
  {accountId: 'a', memberId: 'member-a', store: 'store-b', employeeId: 'employee-a', employeeName: '合成甲'},
  {accountId: 'b', memberId: 'member-b', store: 'store-b', employeeId: 'employee-b', employeeName: '合成乙'},
  {accountId: 'c', memberId: 'member-c', store: 'store-c', employeeId: 'employee-c', employeeName: '合成丙'},
] as const;

/** One durable fact file and artifact root; every member owns independent readers and event state. */
function setup() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'bot-multimember-'));
  cleanup.push(() => fs.rmSync(directory, {recursive: true, force: true}));
  const factFile = path.join(directory, 'existing-facts.sqlite');
  const grants = new WorkbenchAccessStore(path.join(directory, 'grants.sqlite'));
  cleanup.push(() => grants.close());
  for (const person of people) grants.change('admin', {
    accountId: person.accountId, storeId: person.store, roles: ['manager', 'marketing', 'training'],
    active: true, expectedVersion: 0, requestKey: 'open-' + person.accountId,
  });
  const artifactRoot = path.join(directory, 'original-artifacts');
  const replies: {member: string; reqId: string; content: string}[] = [];
  const uploads: {member: string; bytes: Buffer}[] = [];
  const sends: {member: string; body: unknown}[] = [];
  const triggers: {accountId: string; taskId: string; key: string}[] = [];
  const cancelled: string[] = [];
  const generated: string[] = [];
  const inspections: string[] = [];
  const members = people.map(person => {
    // Only explicit invalidation tests change this member's binding version. Identity never switches members.
    let bindingVersion = 1, sequence = 0, frame: unknown;
    const authority = createWecomBotContext({
      mode: 'isolated-synthetic', botId: 'bot', corpId: 'corp', tenantId: 'tenant',
      stores: [{id: 'store-b'}, {id: 'store-c'}], roles: ['manager', 'marketing', 'training'], store: grants,
      readSubject: async () => ({botId: 'bot', memberId: person.memberId}),
      readBinding: async subject => {
        if (subject.memberId !== person.memberId) throw Error('unexpected_member_reader');
        return {corpId: 'corp', botId: 'bot', memberId: person.memberId, accountId: person.accountId, active: true, version: bindingVersion};
      },
      readNative: async accountId => {
        if (accountId !== person.accountId) throw Error('unexpected_native_reader');
        return {user: {id: person.accountId, role: 'member', status: 'active', must_change_password: false}, workspaceJid: 'web:home-' + person.accountId};
      },
    });
    const ledger = new ManagerStore(factFile), taskStore = new BotTaskStore(factFile);
    cleanup.push(() => authority.close(), () => ledger.close(), () => taskStore.close());
    const actor: StaffContext = {tenant: 'tenant', store: person.store, workspace: 'web:original-ledger', employeeId: person.employeeId, employeeName: person.employeeName};
    const backend = {taskId: 'existing-task-' + person.accountId, workspaceJid: 'web:role-' + person.accountId, profileId: 'profile-' + person.accountId};
    const runs = new Map<string, {key: string; status: string}>();
    const native = createNativeBotTasks({port: {
      mode: 'isolated-synthetic', enabled: true,
      inspect: async (owner, target) => {
        expect(owner.accountId).toBe(person.accountId);
        expect(target.taskId).toBe(backend.taskId);
        inspections.push(person.accountId);
        return {
          task: {id: backend.taskId, chat_jid: backend.workspaceJid, group_folder: 'role-' + person.accountId, context_mode: 'isolated', execution_type: 'agent', execution_mode: 'container', status: 'active', deleted_at: null},
          group: {jid: backend.workspaceJid, folder: 'role-' + person.accountId, created_by: person.accountId, execution_mode: 'container', is_home: 0},
          profile: {id: backend.profileId, owner_user_id: person.accountId, status: 'active'}, bindingProfileId: backend.profileId,
        };
      },
      trigger: async (taskId, key) => {
        expect(taskId).toBe(backend.taskId);
        triggers.push({accountId: person.accountId, taskId, key});
        const runId = 'run-' + person.accountId + '-' + digest(key);
        runs.set(runId, {key, status: 'running'});
        return {success: true, runId};
      },
      getRun: async runId => {
        const run = runs.get(runId);
        if (!run) throw Error('foreign_run');
        return {id: runId, task_id: backend.taskId, idempotency_key: run.key, trigger_type: 'manual', status: run.status, result: run.status === 'success' ? '本人岗位结果-' + person.accountId : null,
          definition_snapshot: {chat_jid: backend.workspaceJid, group_folder: 'role-' + person.accountId, context_mode: 'isolated', execution_type: 'agent', execution_mode: 'container'}};
      },
      cancelRun: async runId => {
        const run = runs.get(runId);
        if (!run) throw Error('foreign_cancel');
        cancelled.push(runId); run.status = 'cancelled'; return {success: true};
      },
    }});
    cleanup.push(() => native.close());
    const trainingScope = {accountId: person.accountId, workspaceJid: 'web:local-training'};
    const trainingDir = path.join(directory, 'training', 'tenant', person.store, 'home-' + person.accountId);
    fs.mkdirSync(trainingDir, {recursive: true});
    const source = '# 合成练习资料\n\n## 家访练习\n先访谈，再演练，最后复盘。', sha256 = digest(source);
    fs.writeFileSync(path.join(trainingDir, 'approval.json'), JSON.stringify({kind: 'user_provided_summary', scope: trainingScope, sha256, fileName: 'synthetic.md'}));
    fs.writeFileSync(path.join(trainingDir, 'summary-' + sha256 + '.json'), JSON.stringify({scope: trainingScope, sha256, sourceText: source}));
    const knowledge = createTrainingSummaryService(trainingDir, trainingScope);
    const training = createTrainingGenerationService({dir: path.join(trainingDir, 'runs'), scope: trainingScope, knowledge, generate: async context => {
      generated.push(person.accountId);
      return {answer: '本人培训建议-' + person.accountId, lesson: null, citations: [context.sources[0]!.id], limitations: ['合成练习，人工审核。']};
    }});
    cleanup.push(() => training.close());
    const tasks = createBotTasks({mode: 'isolated-synthetic', authority, store: taskStore, native,
      catalog: [{tenantId: 'tenant', storeId: person.store, accountId: person.accountId, homeJid: 'web:home-' + person.accountId, role: 'marketing', alias: 'weekly', ...backend}],
      training: {enabled: true, resolve: owner => {
        if (owner.accountId !== person.accountId || owner.storeId !== person.store || owner.workspaceJid !== 'web:home-' + person.accountId) throw Error('foreign_training');
        return training;
      }},
    });
    cleanup.push(() => tasks.close());
    const artifacts = new ManagerArtifactStore({mode: 'isolated-synthetic', directory: artifactRoot});
    const makeApp = (store: string = person.store) => {
      const sender = createBotSender({sdk: {mode: 'isolated-synthetic', ready: () => true,
        reply: async (replyFrame, body) => {replies.push({member: person.memberId, reqId: replyFrame.headers.req_id, content: body.stream.content}); return {headers: {req_id: replyFrame.headers.req_id}, errcode: 0};},
        updateTemplateCard: async (replyFrame, update) => {replies.push({member: update.memberId, reqId: replyFrame.headers.req_id, content: update.card.main_title.desc!}); return {headers: {req_id: replyFrame.headers.req_id}, errcode: 0};},
        sendMessage: async () => {throw Error('unexpected_proactive_text');},
      }, fileSdk: {mode: 'isolated-synthetic',
        uploadMedia: async bytes => {uploads.push({member: person.memberId, bytes: Buffer.from(bytes)}); return {type: 'file', media_id: 'media-' + person.accountId};},
        sendMessage: async (member, body) => {sends.push({member, body}); return {headers: {req_id: 'file-' + person.accountId}, errcode: 0};},
      }});
      const app = createBotDelivery({mode: 'isolated-synthetic', authority, ledger, tasks, artifacts,
        scope: {tenant: 'tenant', store, workspace: 'web:original-ledger'},
        employees: people.filter(p => p.store === store || p.accountId === person.accountId).map(p => ({accountId: p.accountId, employeeId: p.employeeId, employeeName: p.employeeName})),
        readEvent: () => frame, now: () => new Date('2026-10-20T01:00:00Z'), sender,
      });
      cleanup.push(() => app.close()); return app;
    };
    const app = makeApp();
    const request = () => ({correlationId: 'multi-' + person.accountId, signal: new AbortController().signal, deadline: performance.now() + 5000});
    const textFrame = (content: string, id = 'event-' + ++sequence, chattype = 'single', from = person.memberId as string) => ({
      cmd: 'aibot_msg_callback', headers: {req_id: 'req-' + person.accountId + '-' + id},
      body: {aibotid: 'bot', msgid: id, chattype, from: {userid: from}, msgtype: 'text', text: {content}},
    });
    const cardFrame = (reportId: string, reportHash: string, id = 'card-' + ++sequence, chattype = 'single', from = person.memberId as string) => ({
      cmd: 'aibot_event_callback', headers: {req_id: 'req-' + person.accountId + '-' + id},
      body: {aibotid: 'bot', msgid: id, chattype, from: {userid: from}, msgtype: 'event', event: {eventtype: 'template_card_event', task_id: 'report-' + reportId + '-' + 'c'.repeat(32), event_key: 'confirm:' + reportHash}},
    });
    const runFrame = (value: unknown, target = app) => {frame = structuredClone(value); return target.handle(request());};
    const text = (content: string, id?: string) => runFrame(textFrame(content, id));
    const confirm = (id: string, hash: string, eventId?: string) => runFrame(cardFrame(id, hash, eventId));
    const report = (id: string) => ledger.getReport(actor, id)!;
    const owner = {accountId: person.accountId, actor};
    return {person, actor, owner, app, makeApp, request, textFrame, cardFrame, runFrame, text, confirm, report, ledger, artifacts, taskStore, training, trainingScope,
      changeBinding: () => {bindingVersion++;}, completeNative: () => {for (const run of runs.values()) run.status = 'success';}};
  });
  const db = new DatabaseSync(factFile);
  cleanup.push(() => db.close());
  const counts = () => Object.fromEntries(['employee_reports', 'bot_task_refs', 'bot_reply_intents'].map(table => [table, (db.prepare('SELECT count(*) AS n FROM ' + table).get() as {n: number}).n]));
  return {directory, artifactRoot, factFile, grants, members, db, counts, replies, uploads, sends, triggers, cancelled, generated, inspections};
}

it('concurrently records, confirms and corrects each member while managers share only their own store aggregate', async () => {
  const s = setup(), [a, b, c] = s.members as [typeof s.members[number], typeof s.members[number], typeof s.members[number]];
  const pending = await Promise.all(s.members.map((m, i) => m.text('今天销售成交' + (i + 1) * 100 + '元', 'same-member-local-id')));
  expect(new Set(pending.map(r => r.result.reportId)).size).toBe(3);
  expect(s.counts().employee_reports).toBe(3);
  expect(s.members.map((m, i) => m.report(pending[i]!.result.reportId!).state)).toEqual(['pending', 'pending', 'pending']);
  expect(s.members.map(m => m.ledger.summary(m.actor, '2026-10-20', 'month').salesCents)).toEqual([null, null, null]);
  const confirmed = await Promise.all(s.members.map((m, i) => {const r = m.report(pending[i]!.result.reportId!); return m.confirm(r.id, r.hash);}));
  expect(confirmed.map(r => r.result.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
  expect(s.members.map((m, i) => m.report(pending[i]!.result.reportId!).entries[0]!.employeeId)).toEqual(people.map(p => p.employeeId));
  const correctedAmounts = [110, 220, 390];
  const corrections = await Promise.all(s.members.map((m, i) => m.text(`更正 ${pending[i]!.result.reportId} 1 ${correctedAmounts[i]}元`)));
  expect(s.members.map(m => m.ledger.summary(m.actor, '2026-10-20', 'month').salesCents)).toEqual([30000, 30000, 30000]);
  await Promise.all(s.members.map((m, i) => {const r = m.report(corrections[i]!.result.reportId!); return m.confirm(r.id, r.hash);}));
  const summaries = await Promise.all(s.members.map(m => m.text('经营汇总 2026-10-20 本月')));
  expect(summaries.map(r => r.result.status)).toEqual(['summary', 'summary', 'summary']);
  expect(summaries[0]!.result.snapshotId).toBe(summaries[1]!.result.snapshotId);
  expect(summaries[2]!.result.snapshotId).not.toBe(summaries[0]!.result.snapshotId);
  const ownStore = a.artifacts.read(a.owner, summaries[0]!.result.snapshotId!)!;
  expect(ownStore.salesCents).toBe(33000);
  expect(ownStore.rows.map(row => row.employeeId).sort()).toEqual(['employee-a', 'employee-b']);
  const otherStore = c.artifacts.read(c.owner, summaries[2]!.result.snapshotId!)!;
  expect(otherStore.rows.map(row => row.employeeId)).toEqual(['employee-c']); expect(otherStore.salesCents).toBe(39000);
  for (const m of [b, c]) {
    expect((await m.text('查询 ' + pending[0]!.result.reportId)).result.status).toBe('not-found');
    expect((await m.text('更正 ' + pending[0]!.result.reportId + ' 1 999元')).result.status).toBe('conflict');
  }
  expect(s.members.map(m => m.ledger.summary(m.actor, '2026-10-20', 'month').salesCents)).toEqual([33000, 33000, 39000]);
  expect(s.counts().employee_reports).toBe(6);
});

it('exports identical store snapshot hashes into separate owner directories and sends each file to that owner only', async () => {
  const s = setup(), [a, b, c] = s.members as [typeof s.members[number], typeof s.members[number], typeof s.members[number]];
  for (const m of s.members) {const p = await m.text('今天销售成交100元'); const r = m.report(p.result.reportId!); await m.confirm(r.id, r.hash);}
  const [sa, sb] = await Promise.all([a.text('经营汇总 2026-10-20 本月'), b.text('经营汇总 2026-10-20 本月')]);
  const id = sa.result.snapshotId!;
  expect(sb.result.snapshotId).toBe(id);
  expect(a.artifacts.artifact(a.owner, id)).toBeUndefined();
  expect((await c.text('查询汇总 ' + id)).result.status).toBe('not-found');
  expect((await c.text('导出Excel ' + id)).result.status).toBe('not-found');
  const files = await Promise.all([a.text('导出Excel ' + id), b.text('导出Excel ' + id)]);
  expect(files.map(r => r.delivery?.state)).toEqual(['accepted', 'accepted']);
  expect(s.sends).toEqual(expect.arrayContaining([
    {member: 'member-a', body: {msgtype: 'file', chat_type: 1, file: {media_id: 'media-a'}}},
    {member: 'member-b', body: {msgtype: 'file', chat_type: 1, file: {media_id: 'media-b'}}},
  ]));
  expect(s.sends).toHaveLength(2); expect(s.uploads).toHaveLength(2);
  expect(a.artifacts.artifact(a.owner, id)!.bytes).toEqual(b.artifacts.artifact(b.owner, id)!.bytes);
  expect(c.artifacts.artifact(c.owner, id)).toBeUndefined();
  const dirs = fs.readdirSync(s.artifactRoot).filter(key => fs.existsSync(path.join(s.artifactRoot, key, id, 'sales.xlsx')));
  expect(dirs).toHaveLength(2);
  for (const upload of s.uploads) {
    const zip = new AdmZip(upload.bytes), rows = zip.readAsText('xl/worksheets/sheet2.xml');
    expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain(id);
    expect(rows).toContain('合成甲'); expect(rows).toContain('合成乙'); expect(rows).not.toContain('合成丙');
  }
  const before = s.sends.length;
  expect((await c.text('查询文件 ' + id)).result.status).toBe('not-found');
  expect(s.sends).toHaveLength(before);
});

it('runs the real task adapters concurrently, isolates task lookup/cancel and uses original persisted training results', async () => {
  const s = setup();
  const starts = await Promise.all(s.members.map(m => m.text('执行任务 内容营销 weekly', 'same-task-event')));
  expect(starts.map(r => r.result.taskStatus)).toEqual(['running', 'running', 'running']);
  expect(new Set(starts.map(r => r.result.taskId)).size).toBe(3);
  expect(s.triggers.map(t => t.accountId).sort()).toEqual(['a', 'b', 'c']);
  expect(s.counts().bot_task_refs).toBe(3);
  const beforeInspect = s.inspections.length;
  for (const m of s.members.slice(1)) {
    expect((await m.text('查询任务 内容营销 ' + starts[0]!.result.taskId)).result.taskStatus).toBe('not-found');
    expect((await m.text('取消任务 内容营销 ' + starts[0]!.result.taskId)).result.taskStatus).toBe('not-found');
  }
  expect(s.inspections).toHaveLength(beforeInspect); expect(s.cancelled).toEqual([]);
  for (const m of s.members) m.completeNative();
  const results = await Promise.all(s.members.map((m, i) => m.text('查询任务 内容营销 ' + starts[i]!.result.taskId)));
  for (const [index, result] of results.entries()) {
    expect(result.result.taskStatus).toBe('success');
    expect(result.result.reply.body.stream.content).toContain('本人岗位结果-' + people[index]!.accountId);
  }
  const training = await Promise.all(s.members.map(m => m.text('培训问答 指导员 家访练习', 'same-training-event')));
  expect(s.generated.sort()).toEqual(['a', 'b', 'c']);
  for (const [i, m] of s.members.entries()) {
    const taskId = training[i]!.result.taskId!, key = 'bot-' + taskId;
    await m.training.settled(key);
    const run = m.training.get(m.trainingScope, key);
    expect(run.status).toBe('ready'); expect(run.actor.accountId).toBe(m.person.accountId);
    expect(run.output?.citations).toHaveLength(1);
    const result = await m.text('查询任务 培训 ' + taskId);
    expect(result.result.reply.body.stream.content).toContain('本人培训建议-' + m.person.accountId);
    const other = s.members[(i + 1) % s.members.length]!;
    expect((await other.text('查询任务 培训 ' + taskId)).result.taskStatus).toBe('not-found');
  }
  expect(s.counts().employee_reports).toBe(0); expect(s.counts().bot_task_refs).toBe(6);
  expect(s.triggers).toHaveLength(3); expect(s.cancelled).toEqual([]);
});

it('rejects group text, task commands and genuine-member cards before any ledger, task or SDK side effect', async () => {
  const s = setup(), before = s.counts();
  for (const m of s.members) {
    for (const content of ['今天销售成交999元', '执行任务 内容营销 weekly', '培训问答 指导员 家访练习']) {
      await expect(m.runFrame(m.textFrame(content, 'group-' + digest(content), 'group'))).rejects.toThrow('unsupported_event');
    }
    await expect(m.runFrame(m.cardFrame('a'.repeat(64), 'b'.repeat(64), 'group-card', 'group'))).rejects.toThrow('unsupported_event');
  }
  expect(s.counts()).toEqual(before);
  expect(s.replies).toEqual([]); expect(s.uploads).toEqual([]); expect(s.sends).toEqual([]);
  expect(s.triggers).toEqual([]); expect(s.inspections).toEqual([]); expect(s.generated).toEqual([]); expect(s.cancelled).toEqual([]);
  expect(fs.readdirSync(s.artifactRoot)).toEqual([]);
});

it('cancels only the owning member run and keeps other members active when one authorization is revoked', async () => {
  const s = setup(), a = s.members[0]!, b = s.members[1]!, c = s.members[2]!;
  const starts = await Promise.all(s.members.map(m => m.text('执行任务 内容营销 weekly', 'cancel-isolation')));
  const cancel = await a.text('取消任务 内容营销 ' + starts[0]!.result.taskId);
  expect(cancel.result.taskStatus).toBe('cancelled');
  expect(s.cancelled).toEqual(['run-a-' + digest(s.triggers.find(t => t.accountId === 'a')!.key)]);
  const others = await Promise.all([b.text('查询任务 内容营销 ' + starts[1]!.result.taskId), c.text('查询任务 内容营销 ' + starts[2]!.result.taskId)]);
  expect(others.map(r => r.result.taskStatus)).toEqual(['running', 'running']);
  s.grants.change('admin', {accountId: 'a', storeId: 'store-b', roles: [], active: false, expectedVersion: 1, requestKey: 'revoke-a'});
  const before = s.counts(), repliesBefore = s.replies.length;
  await expect(a.text('今天销售成交999元')).rejects.toThrow('access_denied');
  await expect(a.text('查询任务 内容营销 ' + starts[0]!.result.taskId)).rejects.toThrow('access_denied');
  expect(s.counts()).toEqual(before); expect(s.replies).toHaveLength(repliesBefore);
  const live = await Promise.all([b.text('今天销售成交200元'), c.text('今天销售成交300元')]);
  expect(live.map(r => r.result.status)).toEqual(['pending', 'pending']);
  expect(s.triggers).toHaveLength(3); expect(s.cancelled).toHaveLength(1);
  expect(s.counts().employee_reports).toBe(2); expect(s.counts().bot_task_refs).toBe(3);
});

it('blocks cross-member identity spoofing and card ownership forgery without confirming another member report', async () => {
  const s = setup(), a = s.members[0]!, b = s.members[1]!;
  const pending = await a.text('今天销售成交100元'), r = a.report(pending.result.reportId!);
  const before = s.counts(), repliesBefore = s.replies.length;
  await expect(b.runFrame(b.textFrame('今天销售成交999元', 'spoof-text', 'single', 'member-a'))).rejects.toThrow('access_denied');
  await expect(b.runFrame(b.cardFrame(r.id, r.hash, 'spoof-card', 'single', 'member-a'))).rejects.toThrow('access_denied');
  expect(s.counts()).toEqual(before); expect(s.replies).toHaveLength(repliesBefore);
  const forged = await b.confirm(r.id, r.hash);
  expect(forged.result.status).toBe('not-found'); expect(a.report(r.id).state).toBe('pending');
  expect(a.ledger.summary(a.actor, '2026-10-20', 'month').salesCents).toBeNull();
  expect(s.counts().employee_reports).toBe(1); expect(s.counts().bot_task_refs).toBe(0);
  expect(s.triggers).toEqual([]); expect(s.sends).toEqual([]);
});

it('preserves one ledger entry and task execution when the same member event races independent consumers', async () => {
  const s = setup(), a = s.members[0]!;
  const frame = a.textFrame('今天销售成交100元', 'report-race');
  const pending = await Promise.all([a.runFrame(frame), a.runFrame(frame, a.makeApp())]);
  expect(pending[0]!.result.reportId).toBe(pending[1]!.result.reportId);
  expect(pending.filter(r => r.suppressed)).toHaveLength(1);
  const report = a.report(pending[0]!.result.reportId!), card = a.cardFrame(report.id, report.hash, 'confirm-race');
  const confirmations = await Promise.all([a.runFrame(card), a.runFrame(card, a.makeApp())]);
  expect(confirmations.filter(r => r.suppressed)).toHaveLength(1);
  expect(a.report(report.id).entries).toHaveLength(1);
  expect(a.ledger.summary(a.actor, '2026-10-20', 'month').salesCents).toBe(10000);
  const taskFrame = a.textFrame('执行任务 内容营销 weekly', 'task-race');
  const tasks = await Promise.all([a.runFrame(taskFrame), a.runFrame(taskFrame, a.makeApp())]);
  expect(tasks[0]!.result.taskId).toBe(tasks[1]!.result.taskId);
  expect(tasks.filter(r => r.suppressed)).toHaveLength(1);
  expect(s.triggers).toHaveLength(1); expect(s.replies).toHaveLength(3);
  expect(s.counts()).toEqual({employee_reports: 1, bot_task_refs: 1, bot_reply_intents: 3});
});

it('does not replay an old event after binding replacement or store transfer into a second ledger or execution', async () => {
  const s = setup(), a = s.members[0]!;
  const text = a.textFrame('今天销售成交100元', 'old-report');
  const pending = await a.runFrame(text), r = a.report(pending.result.reportId!);
  const card = a.cardFrame(r.id, r.hash, 'old-confirm'); await a.runFrame(card);
  const taskFrame = a.textFrame('执行任务 内容营销 weekly', 'old-task'); await a.runFrame(taskFrame);
  const before = s.counts(), repliesBefore = s.replies.length;
  a.changeBinding();
  for (const event of [text, card, taskFrame]) await expect(a.runFrame(event)).rejects.toThrow('bot_reply_conflict');
  s.grants.change('admin', {accountId: 'a', storeId: 'store-c', roles: ['manager', 'marketing', 'training'], active: true, expectedVersion: 1, requestKey: 'move-a'});
  const moved = a.makeApp('store-c');
  for (const event of [text, card, taskFrame]) await expect(a.runFrame(event, moved)).rejects.toThrow('bot_reply_conflict');
  expect(s.counts()).toEqual(before); expect(s.replies).toHaveLength(repliesBefore);
  expect(s.triggers).toHaveLength(1); expect(s.sends).toEqual([]);
  expect(a.ledger.summary({...a.actor, store: 'store-c'}, '2026-10-20', 'month').salesCents).toBeNull();
  expect(a.report(r.id).entries).toHaveLength(1);
});
