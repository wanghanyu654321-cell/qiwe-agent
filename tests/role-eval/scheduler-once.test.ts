import { expect, it } from 'vitest';
import { createNativeBotTasks, type NativeBotTaskPort } from '../../src/role-eval/native-bot-tasks.js';
import type { BotTaskBackend, BotTaskOwner } from '../../src/role-eval/wecom-bot-task-store.js';

const owner: BotTaskOwner = {
  tenantId: 'tenant', storeId: 'store', accountId: 'account', workspaceJid: 'web:home', role: 'training',
  corpId: 'corp', botId: 'bot', memberId: 'member', bindingVersion: 1,
};

function projection(taskId: string) {
  return {
    task: { id: taskId, chat_jid: 'web:scheduled', group_folder: 'scheduled-folder', context_mode: 'isolated', execution_type: 'agent', execution_mode: 'container', status: 'active', deleted_at: null },
    group: { jid: 'web:scheduled', folder: 'scheduled-folder', created_by: 'account', execution_mode: 'container', is_home: 0 },
    profile: { id: 'profile', owner_user_id: 'account', status: 'active' },
    bindingProfileId: 'profile',
  };
}

function runRow(taskId: string, key: string, runId: string) {
  return {
    id: runId, task_id: taskId, idempotency_key: key, trigger_type: 'manual', status: 'running', result: null,
    definition_snapshot: { chat_jid: 'web:scheduled', group_folder: 'scheduled-folder', context_mode: 'isolated', execution_type: 'agent', execution_mode: 'container' },
  };
}

it('two scheduler instances execute each stored task once', async () => {
  const executed: string[] = [];
  const runs = new Map<string, { taskId: string; runId: string }>();
  const port: NativeBotTaskPort = {
    mode: 'isolated-synthetic',
    enabled: true,
    async inspect(_owner, backend) { return projection(backend.taskId); },
    async trigger(taskId, key) {
      const existing = runs.get(key);
      if (existing) return { success: true, runId: existing.runId };
      const runId = `run-${key}`;
      runs.set(key, { taskId, runId });
      executed.push(key);
      return { success: true, runId };
    },
    async getRun(runId) {
      const found = [...runs.entries()].find(([, row]) => row.runId === runId);
      if (!found) return null;
      return runRow(found[1].taskId, found[0], runId);
    },
    async cancelRun() { return { success: true }; },
  };
  const left = createNativeBotTasks({ port });
  const right = createNativeBotTasks({ port });
  const specs = [
    { taskId: 'task-a', key: 'store-a' },
    { taskId: 'task-b', key: 'store-b' },
  ];
  const scope = () => ({ signal: new AbortController().signal, deadline: performance.now() + 2000 });
  const current = async () => {};
  const results = await Promise.all(specs.flatMap(spec => {
    const backend: Extract<BotTaskBackend, { kind: 'native' }> = { kind: 'native', taskId: spec.taskId, profileId: 'profile', workspaceJid: 'web:scheduled' };
    return [left.start(owner, backend, spec.key, scope(), current), right.start(owner, backend, spec.key, scope(), current)];
  }));
  expect(results.every(result => result.state === 'linked')).toBe(true);
  expect(executed.sort()).toEqual(['store-a', 'store-b']);
  const again = await left.start(owner, { kind: 'native', taskId: 'task-a', profileId: 'profile', workspaceJid: 'web:scheduled' }, 'store-a', scope(), current);
  expect(again).toMatchObject({ state: 'linked', referenceId: 'run-store-a' });
  expect(executed).toEqual(['store-a', 'store-b']);
  left.close();
  right.close();
});
