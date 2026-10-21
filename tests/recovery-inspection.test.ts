import { expect, it } from 'vitest';
import { buildRecoveryInspection } from '../integrations/native/recovery-inspection.js';

const observation = {
  activeCount: 2,
  activeContainerCount: 1,
  activeHostProcessCount: 1,
  waitingCount: 3,
  enabledAccounts: 4,
  connectedAccounts: 2,
};

it('counts every inventory record in fixed buckets without exposing collector values or aliases', () => {
  const secret = 'key-/private/config/.env-secret_ref-123';
  const snapshot = {
    resourceJids: [secret],
    inventory: {
      complete: true,
      safe: true,
      proofs: { externalWriters: { status: 'verified', report: secret } },
      records: [
        { kind: 'resource/users', key: secret, version: secret, evidence: [secret] },
        { kind: 'input/messages', key: secret },
        { kind: 'execution/router_state', key: secret },
        { kind: 'outbox/channel_outbox', key: secret },
        { kind: 'task/task_runs', key: secret },
        { kind: 'residue/project/config/opaque', key: secret },
        { kind: 'observation/sqlite_snapshot', key: secret },
        { kind: `unknown-${secret}`, key: secret },
      ],
      blockers: [
        'NON_DATABASE_RESIDUE_UNVERIFIED', 'EXTERNAL_WRITERS_UNVERIFIED',
        'WRITER_COVERAGE_INCOMPLETE', 'OPAQUE_RUNTIME_METADATA_UNVERIFIED',
        `unknown-${secret}`,
      ],
    },
  };
  const sourceBefore = JSON.stringify(snapshot);
  const actual = buildRecoveryInspection(snapshot, observation, 'paused');
  expect(actual).toEqual({
    maintenance: true,
    phase: 'paused',
    restorePermission: 'not_issued',
    proofs: {
      nonDatabaseResidue: { status: 'unverified', report: 'reported' },
      externalWriters: { status: 'unverified', report: 'reported' },
      writerCoverage: { status: 'unverified', report: 'reported' },
      opaqueRuntimeMetadata: { status: 'unverified', report: 'reported' },
    },
    recordCounts: { resource: 1, input: 1, execution: 1, outbox: 1, task: 1, residue: 1, observation: 1, unknown: 1 },
    blockerCount: 5,
    otherBlockerCount: 1,
    queueEvidence: { scope: 'current_process_partial', status: 'unavailable' },
    observation: {
      scope: 'current_process_partial',
      ...observation,
      retry: 'unknown',
      warm: 'unknown',
      oldRunner: 'unknown',
      externalWriter: 'unknown',
    },
  });
  expect(JSON.stringify(actual)).not.toContain(secret);
  expect(JSON.stringify(snapshot)).toBe(sourceBefore);
  snapshot.inventory.records[0]!.key = 'changed-after-call';
  observation.activeCount = 99;
  expect(actual.recordCounts.resource).toBe(1);
  expect(actual.observation.activeCount).toBe(2);
});

const queueCountNames = [
  'groupCount', 'activeCount', 'activeContainerCount', 'activeHostProcessCount',
  'waitingGroupCount', 'pendingMessageGroups', 'pendingTasks', 'activeTasks',
  'retryTimers', 'retryTasks', 'messageRetrySnapshots', 'processHandles',
  'containerHandles', 'queryInFlight', 'pendingIpcDeliveries',
  'acknowledgedIpcDeliveries', 'teardownWaiters', 'restartingGroups',
  'stopRequestedGroups', 'runtimeSafetyBlocks', 'mutationPauseTokens',
  'retainedSafetyKeys', 'retainedQueuedWork', 'detachedRetainedQueuedWork',
];
const queueCounts = Object.fromEntries(queueCountNames.map(name => [name, 0]));
it('copies original queue obligation counts without upgrading any global proof', () => {
  const raw = { ...queueCounts, retryTimers: 2, physicalCallbackWriteTickets: 'unknown', secret: '/private/old-runner' };
  const actual = buildRecoveryInspection({ inventory: { records: [], blockers: [] } }, observation, 'paused', raw);
  expect(actual.queueEvidence).toEqual({
    scope: 'current_process_partial', status: 'observed',
    counts: { ...queueCounts, retryTimers: 2 }, physicalCallbackWriteTickets: 'unknown',
    oldProcessOwnership: 'unverified', writerCoverage: 'unverified',
  });
  expect(actual.restorePermission).toBe('not_issued');
  expect(Object.values(actual.proofs).every(proof => proof.status === 'unverified')).toBe(true);
  raw.retryTimers = 99;
  expect(JSON.stringify(actual.queueEvidence)).not.toContain('/private');
  expect((actual.queueEvidence as { counts: Record<string, number> }).counts.retryTimers).toBe(2);
});

it('refuses malformed queue evidence and forged callback settlement', () => {
  const source = { inventory: { records: [], blockers: [] } };
  for (const invalid of [null, {}, Promise.resolve({}), { ...queueCounts, physicalCallbackWriteTickets: 'settled' },
    { ...queueCounts, physicalCallbackWriteTickets: 'unknown', retryTimers: -1 },
    { ...queueCounts, physicalCallbackWriteTickets: 'unknown', then() {} }])
    expect(() => buildRecoveryInspection(source, observation, 'paused', invalid)).toThrow();
});

it('does not infer recovery permission from an original ready phase', () => {
  const result = buildRecoveryInspection({ inventory: { records: [], blockers: [] } }, observation, 'ready');
  expect(result).toMatchObject({ maintenance: false, phase: 'ready', restorePermission: 'not_issued' });
  expect(Object.values(result.proofs).every(proof => proof.status === 'unverified' && proof.report === 'not_reported')).toBe(true);
});

it('fails closed for missing inventory and unsafe runtime counts', () => {
  const valid = { inventory: { records: [], blockers: [] } };
  for (const source of [null, {}, { inventory: { records: {}, blockers: [] } }, { inventory: { records: [], blockers: {} } }])
    expect(() => buildRecoveryInspection(source, observation, 'paused')).toThrow();
  expect(() => buildRecoveryInspection({ inventory: { records: [], blockers: [42] } }, observation, 'paused')).toThrow();
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '0', null])
    expect(() => buildRecoveryInspection(valid, { ...observation, waitingCount: bad }, 'paused')).toThrow();
  expect(() => buildRecoveryInspection(valid, observation, 'unknown' as never)).toThrow();
  expect(() => buildRecoveryInspection(valid, { ...observation, then: () => undefined }, 'paused')).toThrow();
});
