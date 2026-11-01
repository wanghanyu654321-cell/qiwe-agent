import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export const anchors={'db.ts':'961b1eb108c7b5433f4c00fc68d2b2522823742399a26c913eb814230e755884','task-scheduler.ts':'7ac6c9475ad236eb87eba442d393a680cb1e68bbb8189232cbc7f590a5c038f8'};
function once(source,from,to){if(source.split(from).length!==2)throw Error('Native patch anchor no longer unique: '+from.slice(0,80));return source.replace(from,to);}
const targeted=`
/** Explicit request admission supplied by the trusted original server. */
export interface TargetedTaskRunAdmission {
  readonly signal: AbortSignal;
  readonly deadline: number;
  withCurrent(work: () => void): Promise<void>;
  revalidate(): void;
}

function targetedTaskWrite(
  deps: SchedulerDependencies,
  admission: TargetedTaskRunAdmission,
  work: () => void,
): void {
  if (admission.signal.aborted || !Number.isFinite(admission.deadline) ||
      performance.now() >= admission.deadline || deps.queue.isShuttingDown?.())
    throw new Error('TARGETED_TASK_REQUEST_CLOSED');
  // Use the existing process gate. This entry never creates or restores one.
  const gate = (deps as SchedulerDependencies & { appointmentBootGate?: {
    isPaused(): boolean;
    beginWrite(): unknown;
    finishWrite(ticket: unknown): void;
  }}).appointmentBootGate;
  if (!gate || gate.isPaused()) throw new Error('APPOINTMENT_MAINTENANCE');
  const ticket = gate.beginWrite();
  if (!ticket) throw new Error('APPOINTMENT_MAINTENANCE');
  try { admission.revalidate(); work(); } finally { gate.finishWrite(ticket); }
}

function targetedTaskDefinition(taskId: string, deps: SchedulerDependencies): ScheduledTask {
  const task = getTaskById(taskId);
  const group = task && deps.registeredGroups()[task.chat_jid];
  if (!task || task.deleted_at || task.status !== 'active' ||
      task.context_mode !== 'isolated' || task.execution_type !== 'agent' ||
      task.execution_mode !== 'container' || !group || group.is_home ||
      group.executionMode !== 'container' || !group.created_by ||
      group.folder !== task.group_folder || deps.queue.isGroupMutationPaused?.(task.chat_jid))
    throw new Error('TARGETED_TASK_DEFINITION_UNAVAILABLE');
  return task;
}

/** Opt-in single manual run; never materializes definitions or pumps outbox. */
export async function triggerTaskRunTargeted(
  taskId: string, deps: SchedulerDependencies, key: string,
  admission: TargetedTaskRunAdmission,
): Promise<{ success: boolean; error?: string; runId?: string }> {
  if (!key || key.trim() !== key || key.length > 200)
    return { success: false, error: 'TARGETED_TASK_KEY_REQUIRED' };
  let result: { success: boolean; error?: string; runId?: string } =
    { success: false, error: 'TARGETED_TASK_NOT_ADMITTED' };
  await admission.withCurrent(() => targetedTaskWrite(deps, admission, () => {
    const task = targetedTaskDefinition(taskId, deps);
    const created = createTaskRun({ task, triggerType: 'manual', idempotencyKey: key });
    if (created.reason === 'active_conflict') {
      result = { success: false, error: 'Task is already running' };
      return;
    }
    if (created.run.task_id !== taskId || created.run.idempotency_key !== key ||
        created.run.trigger_type !== 'manual' ||
        created.run.definition_snapshot.chat_jid !== task.chat_jid ||
        created.run.definition_snapshot.group_folder !== task.group_folder ||
        created.run.definition_snapshot.context_mode !== 'isolated' ||
        created.run.definition_snapshot.execution_type !== 'agent' ||
        created.run.definition_snapshot.execution_mode !== 'container')
      throw new Error('TARGETED_TASK_RUN_MISMATCH');
    result = { success: true, runId: created.run.id };
    const claim = claimTaskRunById(created.run.id, SCHEDULER_RUNNER_ID, TASK_RUN_LEASE_MS);
    if (claim) {
      try { executeClaimedTaskRun(claim, deps, admission); }
      catch (error) { cancelTaskRunNow(claim.id, false); throw error; }
    }
  }));
  return result;
}

/** Exact cancellation keeps the original durable fence and precise stopper. */
export async function cancelTaskRunTargeted(
  runId: string, deps: SchedulerDependencies, admission: TargetedTaskRunAdmission,
): Promise<{ success: boolean; error?: string }> {
  let result: { success: boolean; error?: string } =
    { success: false, error: 'TARGETED_TASK_NOT_ADMITTED' };
  await admission.withCurrent(() => targetedTaskWrite(deps, admission, () => {
    const run = getTaskRunById(runId);
    if (!run || run.trigger_type !== 'manual' ||
        run.definition_snapshot.context_mode !== 'isolated' ||
        run.definition_snapshot.execution_type !== 'agent' ||
        run.definition_snapshot.execution_mode !== 'container')
      throw new Error('TARGETED_TASK_RUN_MISMATCH');
    result = cancelTaskRunNow(runId, false);
  }));
  return result;
}
`;
export function transformNative(name,bytes){
 if(createHash('sha256').update(bytes).digest('hex')!==anchors[name])throw Error('Native source hash mismatch: '+name);
 let s=bytes.toString('utf8').replaceAll('\r\n','\n');
 if(name==='db.ts'){
  s=once(s,`export function claimNextTaskRun(
  owner: string,
  leaseMs: number,
): ClaimedTaskRun | undefined {
  const now`, `export function claimNextTaskRun(owner: string, leaseMs: number): ClaimedTaskRun | undefined {
  return claimTaskRun(owner, leaseMs);
}

export function claimTaskRunById(runId: string, owner: string, leaseMs: number): ClaimedTaskRun | undefined {
  return claimTaskRun(owner, leaseMs, runId);
}

function claimTaskRun(owner: string, leaseMs: number, runId?: string): ClaimedTaskRun | undefined {
  const now`);
  s=once(s,`         WHERE (
           status IN ('queued','retry_wait') AND available_at <= ?
         ) OR (
           status = 'running' AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ? AND started_at IS NULL
         )
         ORDER BY available_at, scheduled_for, created_at LIMIT 1`, `         WHERE (? IS NULL OR id = ?) AND ((
           status IN ('queued','retry_wait') AND available_at <= ?
         ) OR (
           status = 'running' AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ? AND started_at IS NULL
         ))
         ORDER BY available_at, scheduled_for, created_at LIMIT 1`);
  s=once(s,'.get(nowIso, nowIso) as TaskRunRow | undefined;','.get(runId ?? null, runId ?? null, nowIso, nowIso) as TaskRunRow | undefined;');
 }else if(name==='task-scheduler.ts'){
  s=once(s,'  claimNextTaskRun,','  claimNextTaskRun,\n  claimTaskRunById,');
  s=once(s,`function executeClaimedTaskRun(
  claim: ClaimedTaskRun,
  deps: SchedulerDependencies,
): void {`,`function executeClaimedTaskRun(
  claim: ClaimedTaskRun,
  deps: SchedulerDependencies,
  targeted?: TargetedTaskRunAdmission,
): void {`);
  s=once(s,`    armScheduler(0);
  };

  if (task.execution_type`, `    if (!targeted) armScheduler(0);
  };

  if (task.execution_type`);
  s=once(s,`  let isolatedTerminalHandoff: (() => boolean) | null = null;`, `  let isolatedTerminalHandoff: (() => boolean) | null = null;
  let releaseTargetedRequest = () => {};`);
  s=once(s,`    clearInterval(heartbeat);
    activeDurableTaskIds.delete(task.id);`, `    clearInterval(heartbeat);
    releaseTargetedRequest();
    activeDurableTaskIds.delete(task.id);`);
  s=once(s,"      if (claim.trigger_type === 'manual' && !shuttingDown) {","      if (targeted || (claim.trigger_type === 'manual' && !shuttingDown)) {");
  s=once(s,`  if (deps.queue.isGroupMutationPaused?.(targetGroupJid)) {
    scheduleSafePrestartRetry`, `  if (deps.queue.isGroupMutationPaused?.(targetGroupJid)) {
    if (targeted) {
      completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'cancelled', error: 'Workspace mutation blocked targeted request', notificationStatus: 'skipped',
      });
      return;
    }
    scheduleSafePrestartRetry`);
  s=once(s,`    armScheduler(0);
  };
  try {
    const accepted`, `    if (!targeted) armScheduler(0);
  };
  try {
    const accepted`);
  s=once(s,`  const onDropped = () => {
    if (settled) return;
    settled = true;
    clearInterval(heartbeat);`, `  const onDropped = () => {
    if (settled) return;
    settled = true;
    releaseTargetedRequest();
    clearInterval(heartbeat);`);
  s=once(s,`  try {
    const accepted = deps.queue.enqueueTask(
      prepared.queueJid,
      task.id,
      async () => {
        if (settled) return;
        started = markTaskRunExecutionStarted(`, `  if (targeted) {
    const expire = () => {
      if (started || settled) return;
      cancelTaskRunNow(claim.id, false);
      onDropped();
    };
    const timer = setTimeout(expire, Math.max(0, Math.min(2_147_483_647, targeted.deadline - performance.now())));
    timer.unref?.();
    targeted.signal.addEventListener('abort', expire, { once: true });
    releaseTargetedRequest = () => { clearTimeout(timer); targeted.signal.removeEventListener('abort', expire); };
    if (targeted.signal.aborted || performance.now() >= targeted.deadline) { expire(); return; }
  }
  try {
    const accepted = deps.queue.enqueueTask(
      prepared.queueJid,
      task.id,
      async () => {
        if (settled) return;
        started = markTaskRunExecutionStarted(`);
  const begin=s.indexOf('        started = markTaskRunExecutionStarted(',s.indexOf('const executionNamespace ='));
  const end=s.indexOf('\n      },\n      { allowInactive: true, onDropped },',begin);
  if(begin<0||end<begin)throw Error('Native queue callback changed');
  s=s.slice(0,begin)+`        let execution: Promise<void> | undefined;
        const start = () => {
          if (targeted) targetedTaskDefinition(task.id, deps);
          started = markTaskRunExecutionStarted(claim.id, claim.lease_owner, claim.lease_token);
          if (!started) {
            settled = true;
            clearInterval(heartbeat);
            clearActiveDurableExecution(claim.id, claim.attempt);
            return;
          }
          executionStartedAtMs = Date.now();
          activeDurableTaskIds.add(task.id);
          releaseTargetedRequest();
          execution = runTask(task, executionDeps, {
            ...prepared.options, durableRun: claim,
            onDurableTerminalHandoffPrepared: (commit) => { isolatedTerminalHandoff = commit; },
          });
        };
        try {
          if (targeted) await targeted.withCurrent(() => targetedTaskWrite(deps, targeted, start));
          else start();
          await execution;
        } catch (err) {
          if (!targeted || started) throw err;
          completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
            status: 'cancelled', error: 'Targeted request no longer authorized before execution',
            notificationStatus: 'skipped',
          });
          settled = true;
          releaseTargetedRequest();
          clearInterval(heartbeat);
          clearActiveDurableExecution(claim.id, claim.attempt);
        } finally {
          if (!settled) { settled = true; finish(heartbeat, 'isolated'); }
        }`+s.slice(end);
  s=once(s,'export function cancelTaskRunNow(runId: string): {','export function cancelTaskRunNow(runId: string, wakeScheduler = true): {');
  s=once(s,`  notifyTaskSchedulerChanged();
  return { success: true };
}`,`  if (wakeScheduler) notifyTaskSchedulerChanged();
  return { success: true };
}`);
  s+='\n'+targeted;
 }
 return s;
}
/** Caller must supply a disposable source COPY; this does not choose paths. */
export function patchNative(copyRoot){
 for(const name of Object.keys(anchors)){
  const file=path.join(copyRoot,name),bytes=fs.readFileSync(file);
  fs.writeFileSync(file,transformNative(name,bytes));
 }
}
