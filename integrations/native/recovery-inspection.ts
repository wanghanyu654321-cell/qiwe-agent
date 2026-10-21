/** A current-process projection. None of these counts proves historical work is settled. */
export type RecoveryObservation = Readonly<{
  activeCount: number;
  activeContainerCount: number;
  activeHostProcessCount: number;
  /** Number of queued groups, not queued messages or tasks. */
  waitingCount: number;
  enabledAccounts: number;
  connectedAccounts: number;
}>;

type RecoveryPhase = 'paused' | 'restoring' | 'ready';
type CountKind = 'resource' | 'input' | 'execution' | 'outbox' | 'task' | 'residue' | 'observation' | 'unknown';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('invalid_recovery_inspection');
  return value as number;
}

/** Copies only fixed category counts. Original keys, paths, IDs, versions and errors stay private. */
export function buildRecoveryInspection(
  snapshot: unknown,
  observation: unknown,
  phase: RecoveryPhase,
) {
  if (!object(snapshot) || !object(snapshot.inventory) ||
      !Array.isArray(snapshot.inventory.records) ||
      !Array.isArray(snapshot.inventory.blockers) ||
      !object(observation) || 'then' in observation ||
      !['paused', 'restoring', 'ready'].includes(phase))
    throw new Error('invalid_recovery_inspection');

  const recordCounts: Record<CountKind, number> = {
    resource: 0, input: 0, execution: 0, outbox: 0,
    task: 0, residue: 0, observation: 0, unknown: 0,
  };
  for (const entry of snapshot.inventory.records) {
    if (!object(entry)) throw new Error('invalid_recovery_inspection');
    const kind = entry.kind;
    const family = typeof kind === 'string' ? kind.split('/', 1)[0] : undefined;
    const bucket: CountKind = family === 'resource' || family === 'input' ||
      family === 'execution' || family === 'outbox' || family === 'task' ||
      family === 'residue' || family === 'observation' ? family : 'unknown';
    recordCounts[bucket] = safeCount(recordCounts[bucket] + 1);
  }
  const reportedCodes = new Set([
    'NON_DATABASE_RESIDUE_UNVERIFIED',
    'EXTERNAL_WRITERS_UNVERIFIED',
    'WRITER_COVERAGE_INCOMPLETE',
    'OPAQUE_RUNTIME_METADATA_UNVERIFIED',
  ]);
  let otherBlockerCount = 0;
  for (const blocker of snapshot.inventory.blockers) {
    if (typeof blocker !== 'string') throw new Error('invalid_recovery_inspection');
    if (!reportedCodes.has(blocker)) otherBlockerCount = safeCount(otherBlockerCount + 1);
  }
  const source = observation as Record<keyof RecoveryObservation, unknown>;
  const counts: RecoveryObservation = {
    activeCount: safeCount(source.activeCount),
    activeContainerCount: safeCount(source.activeContainerCount),
    activeHostProcessCount: safeCount(source.activeHostProcessCount),
    waitingCount: safeCount(source.waitingCount),
    enabledAccounts: safeCount(source.enabledAccounts),
    connectedAccounts: safeCount(source.connectedAccounts),
  };
  return {
    maintenance: phase !== 'ready',
    phase,
    restorePermission: 'not_issued' as const,
    proofs: {
      nonDatabaseResidue: { status: 'unverified' as const, report: snapshot.inventory.blockers.includes('NON_DATABASE_RESIDUE_UNVERIFIED') ? 'reported' as const : 'not_reported' as const },
      externalWriters: { status: 'unverified' as const, report: snapshot.inventory.blockers.includes('EXTERNAL_WRITERS_UNVERIFIED') ? 'reported' as const : 'not_reported' as const },
      writerCoverage: { status: 'unverified' as const, report: snapshot.inventory.blockers.includes('WRITER_COVERAGE_INCOMPLETE') ? 'reported' as const : 'not_reported' as const },
      opaqueRuntimeMetadata: { status: 'unverified' as const, report: snapshot.inventory.blockers.includes('OPAQUE_RUNTIME_METADATA_UNVERIFIED') ? 'reported' as const : 'not_reported' as const },
    },
    recordCounts,
    blockerCount: safeCount(snapshot.inventory.blockers.length),
    otherBlockerCount,
    observation: {
      scope: 'current_process_partial' as const,
      ...counts,
      retry: 'unknown' as const,
      warm: 'unknown' as const,
      oldRunner: 'unknown' as const,
      externalWriter: 'unknown' as const,
    },
  };
}
