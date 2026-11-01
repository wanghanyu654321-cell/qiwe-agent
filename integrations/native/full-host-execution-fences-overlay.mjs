import ts from 'typescript';

function once(source,before,after){
 if(source.split(before).length!==2)throw Error('FULL_HOST_EXECUTION_FENCE_ANCHOR_CHANGED: '+before.slice(0,90));
 return source.replace(before,after);
}

/** Patch only the complete-host candidate copy. N/O and older modes stay exact. */
export function applyFullHostExecutionFences(files){
 const result=new Map(files),index=result.get('index.ts');
 const parsed=ts.createSourceFile('index.ts',index,ts.ScriptTarget.Latest,true);
 const markers=['deleteExpiredSessions','checkAndExpireSubscriptions','reconcileMonthlyUsage','cleanupOldDailyUsage'];
 const patches=[];
 function walk(node){
  if(ts.isCallExpression(node)&&node.expression.getText(parsed)==='setInterval'){
   const callback=node.arguments[0];
   if(callback&&ts.isArrowFunction(callback)&&ts.isBlock(callback.body)){
    const body=callback.body.getText(parsed),matched=markers.filter(marker=>body.includes(marker));
    if(matched.length){
     if(matched.length!==1)throw Error('FULL_HOST_MAINTENANCE_CALLBACK_CHANGED');
     patches.push({marker:matched[0],start:callback.body.getStart(parsed),end:callback.body.end,body});
    }
   }
  }
  ts.forEachChild(node,walk);
 }
 walk(parsed);
 if(patches.length!==4||new Set(patches.map(patch=>patch.marker)).size!==4)throw Error('FULL_HOST_MAINTENANCE_CALLBACK_CHANGED');
 let guarded=index;
 for(const patch of patches.sort((a,b)=>b.start-a.start)){
  const body=`{
      if (appointmentBootGate.isPaused()) return;
      const appointmentMaintenanceTicket = appointmentBootGate.beginWrite();
      if (!appointmentMaintenanceTicket) return;
      try {${patch.body.slice(1,-1)}
      } finally { appointmentBootGate.finishWrite(appointmentMaintenanceTicket); }
    }`;
  guarded=guarded.slice(0,patch.start)+body+guarded.slice(patch.end);
 }
 result.set('index.ts',guarded);
 let scheduler=result.get('task-scheduler.ts');
 scheduler=once(scheduler,`export async function deliverPersistedNotificationPayload(
  payload: TaskRunNotificationPayload,
  deps: SchedulerDependencies,
`, `export async function deliverPersistedNotificationPayload(
  payload: TaskRunNotificationPayload,
  deps: SchedulerDependencies,
  assertClaimCurrent?: () => void,
`);
 scheduler=once(scheduler,`  for (const item of items) {
    let receipt: TaskRunNotificationReceipt;`, `  for (const item of items) {
    // Outside the transport catch: lost ownership must stop the batch, never
    // become a retry receipt that an obsolete worker could commit.
    assertClaimCurrent?.();
    let receipt: TaskRunNotificationReceipt;`);
 scheduler=once(scheduler,`  let leaseOwned = true;
  const heartbeat = setInterval(`, `  let leaseOwned = true;
  const claimLost = new Error('TASK_NOTIFICATION_CLAIM_LOST');
  const assertClaimCurrent = (): void => {
    if (!leaseOwned || appointmentTaskPaused(deps) ||
        !renewTaskRunNotificationLease(claim, leaseMs)) {
      leaseOwned = false;
      throw claimLost;
    }
  };
  const heartbeat = setInterval(`);
 scheduler=once(scheduler,`    const delivered = await deliverPersistedNotificationPayload(
      claim.payload,
      deps,
    );`, `    const delivered = await deliverPersistedNotificationPayload(
      claim.payload,
      deps,
      assertClaimCurrent,
    );`);
 scheduler=once(scheduler,`  } finally {
    clearInterval(heartbeat);
  }

  } finally {`, `  } catch (err) {
    if (err === claimLost) return false;
    throw err;
  } finally {
    clearInterval(heartbeat);
  }

  } finally {`);
 result.set('task-scheduler.ts',scheduler);return result;
}
