import { expect, it, vi } from 'vitest';
import { GroupQueue } from '../src/group-queue.js';
import { createAppointmentBootGate } from '../src/appointment-boot-gate.js';

const fixedCounts = [
  'groupCount', 'activeCount', 'activeContainerCount', 'activeHostProcessCount',
  'waitingGroupCount', 'pendingMessageGroups', 'pendingTasks', 'activeTasks',
  'retryTimers', 'retryTasks', 'messageRetrySnapshots', 'processHandles',
  'containerHandles', 'queryInFlight', 'pendingIpcDeliveries',
  'acknowledgedIpcDeliveries', 'teardownWaiters', 'restartingGroups',
  'stopRequestedGroups', 'runtimeSafetyBlocks', 'mutationPauseTokens',
  'retainedSafetyKeys', 'retainedQueuedWork', 'detachedRetainedQueuedWork',
] as const;

function obligations(queue: GroupQueue): Record<string, number | 'unknown'> {
  return (queue as any).getRecoveryObligations();
}

it('observes original paused enqueue without running its task or changing gate and queue state', () => {
  const gate = createAppointmentBootGate('appointment');
  const queue = new GroupQueue(gate);
  let executions = 0;
  expect(queue.enqueueTask('web:private-group', 'private-task-id', async () => { executions++; })).toBe(true);
  expect(gate.phase()).toBe('paused');
  expect(executions).toBe(0);
  const before = queue.getStatus();
  const gateCalls = [
    vi.spyOn(gate, 'noteArrival'), vi.spyOn(gate, 'beginWrite'),
    vi.spyOn(gate, 'finishWrite'), vi.spyOn(gate, 'beginReview'),
    vi.spyOn(gate, 'publishReview'), vi.spyOn(gate, 'claimRestore'),
  ];
  try {
    const first = obligations(queue);
    const second = obligations(queue);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      groupCount: 1, waitingGroupCount: 1, pendingTasks: 1,
      retainedQueuedWork: 1, detachedRetainedQueuedWork: 0,
      physicalCallbackWriteTickets: 'unknown',
    });
    expect(queue.getStatus()).toEqual(before);
    expect(gate.phase()).toBe('paused');
    expect(executions).toBe(0);
    for (const call of gateCalls) expect(call).not.toHaveBeenCalled();
    expect(Object.keys(first).sort()).toEqual([...fixedCounts, 'physicalCallbackWriteTickets'].sort());
    for (const name of fixedCounts) expect(Number.isSafeInteger(first[name]) && (first[name] as number) >= 0, name).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/web:private-group|private-task-id|12345|folder-secret|credential-secret/i);
  } finally {
    vi.restoreAllMocks();
  }
});

it('counts retained detached state, retry and IPC obligations once by state identity', () => {
  const gate = createAppointmentBootGate('appointment');
  const queue = new GroupQueue(gate);
  expect(queue.enqueueTask('web:detached-secret', 'secret-task', async () => {})).toBe(true);
  const internal = queue as any;
  const state = internal.groups.get('web:detached-secret');
  expect(internal.appointmentQueuedWork.get('web:detached-secret').state).toBe(state);

  // Synthetic private state exercises risks whose real runner/receipt path
  // cannot safely execute in this paused candidate. It is no settlement proof.
  state.active = true;
  state.runnerRuntime = 'container';
  state.activeTask = { id: 'active-secret' };
  state.pendingMessages = true;
  state.retryTimer = { synthetic: 'timer' };
  state.retryTask = { id: 'retry-secret' };
  state.messageRetrySnapshot = { cursor: { timestamp: 'synthetic', id: 'cursor-secret' } };
  state.process = { pid: 12345 };
  state.containerName = 'container-secret';
  state.queryInFlight = true;
  state.pendingIpcDeliveries.set('delivery-secret', { deliveryId: 'delivery-secret' });
  state.acknowledgedIpcDeliveryIds.add('ack-secret');
  state.teardownWaiters.add(() => {});
  state.restarting = true;
  state.stopRequested = true;
  internal.runtimeSafetyBlocks.set('safety-secret', new Map([['owner-secret', 'reason']]));
  internal.mutationPauseTokens.set(19, ['token-secret']);
  internal.appointmentUnsettledSafetyKeys.add('retained-secret');

  const attached = obligations(queue);
  expect(attached).toMatchObject({
    groupCount: 1, activeCount: 1, activeContainerCount: 1,
    pendingMessageGroups: 1, pendingTasks: 1, activeTasks: 1,
    retryTimers: 1, retryTasks: 1, messageRetrySnapshots: 1,
    processHandles: 1, containerHandles: 1, queryInFlight: 1,
    pendingIpcDeliveries: 1, acknowledgedIpcDeliveries: 1,
    teardownWaiters: 1, restartingGroups: 1, stopRequestedGroups: 1,
    runtimeSafetyBlocks: 1, mutationPauseTokens: 1, retainedSafetyKeys: 1,
    retainedQueuedWork: 1, detachedRetainedQueuedWork: 0,
  });
  // The original virtual-state collection can remove a group while O keeps
  // its write ticket and state. Its obligations must remain observable.
  internal.groups.delete('web:detached-secret');
  const detached = obligations(queue);
  expect(detached).toMatchObject({ ...attached, groupCount: 0, detachedRetainedQueuedWork: 1 });
  state.pendingIpcDeliveries.clear();
  state.pendingTasks.length = 0;
  expect(detached.pendingIpcDeliveries).toBe(1);
  expect(detached.pendingTasks).toBe(1);
  expect(obligations(queue).pendingIpcDeliveries).toBe(0);
  expect(JSON.stringify(detached)).not.toMatch(/detached-secret|secret-task|cursor-secret|delivery-secret|ack-secret|safety-secret|token-secret|retained-secret|12345|container-secret/);
});
