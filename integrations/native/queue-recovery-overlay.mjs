function requireOnce(source, anchor) {
  if (source.split(anchor).length !== 2)
    throw new Error('QUEUE_RECOVERY_COMPOSED_ANCHOR_CHANGED');
}

/** Add a synchronous, count-only observation to the verified N+O GroupQueue. */
export function applyQueueRecoveryOverlay(source) {
  if (typeof source !== 'string') throw new TypeError('QUEUE_RECOVERY_SOURCE_REQUIRED');
  const result = source.replaceAll('\r\n', '\n');
  // The full-host builder verifies the entire N and O trees before this call.
  // These anchors additionally reject the uncomposed Native class or a
  // changed O retention contract; observing only Native groups would miss it.
  for (const anchor of [
    'export class GroupQueue {',
    '  private groups = new Map<string, GroupState>();',
    '  private appointmentQueuedWork = new Map<string, { ticket: WriteTicket; state: GroupState }>();',
    '  private appointmentUnsettledSafetyKeys = new Set<string>();',
    '  private settleAppointmentQueuedWork(): void {',
    '  getStatus(): {',
  ]) requireOnce(result, anchor);
  if (result.includes('getRecoveryObligations('))
    throw new Error('QUEUE_RECOVERY_METHOD_ALREADY_PRESENT');

  const method = `  /** Current-process negative observation only: no historical owner fence. */
  getRecoveryObligations() {
    // A queued-work ticket may retain a state after virtual group collection.
    // Count each concrete state once even while both maps reference it.
    const states = new Set<GroupState>(this.groups.values());
    for (const { state } of this.appointmentQueuedWork.values()) states.add(state);
    const count = (predicate: (state: GroupState) => boolean): number => {
      let total = 0;
      for (const state of states) if (predicate(state)) total++;
      return total;
    };
    const total = (read: (state: GroupState) => number): number => {
      let value = 0;
      for (const state of states) value += read(state);
      return value;
    };
    let detachedRetainedQueuedWork = 0;
    for (const [jid, { state }] of this.appointmentQueuedWork)
      if (this.groups.get(jid) !== state) detachedRetainedQueuedWork++;
    return {
      groupCount: this.groups.size,
      activeCount: count(state => state.active),
      activeContainerCount: count(state => state.active && state.runnerRuntime === 'container'),
      activeHostProcessCount: count(state => state.active && state.runnerRuntime === 'host'),
      waitingGroupCount: this.waitingGroups.size,
      pendingMessageGroups: count(state => state.pendingMessages),
      pendingTasks: total(state => state.pendingTasks.length),
      activeTasks: count(state => state.activeTask !== null),
      retryTimers: count(state => state.retryTimer !== null),
      retryTasks: count(state => state.retryTask !== null),
      messageRetrySnapshots: count(state => state.messageRetrySnapshot !== null),
      processHandles: count(state => state.process !== null),
      containerHandles: count(state => state.containerName !== null),
      queryInFlight: count(state => state.queryInFlight),
      pendingIpcDeliveries: total(state => state.pendingIpcDeliveries.size),
      acknowledgedIpcDeliveries: total(state => state.acknowledgedIpcDeliveryIds.size),
      teardownWaiters: total(state => state.teardownWaiters.size),
      restartingGroups: count(state => state.restarting),
      stopRequestedGroups: count(state => state.stopRequested),
      runtimeSafetyBlocks: this.runtimeSafetyBlocks.size,
      mutationPauseTokens: this.mutationPauseTokens.size,
      retainedSafetyKeys: this.appointmentUnsettledSafetyKeys.size,
      retainedQueuedWork: this.appointmentQueuedWork.size,
      detachedRetainedQueuedWork,
      // O's physical callback WriteTicket is a local variable and has no
      // enumerable owner registry. An active runner count cannot prove it zero.
      physicalCallbackWriteTickets: 'unknown' as const,
    };
  }

`;
  return result.replace('  getStatus(): {', method + '  getStatus(): {');
}
