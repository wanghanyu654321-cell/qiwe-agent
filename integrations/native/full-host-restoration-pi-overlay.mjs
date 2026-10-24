/** Complete-host Pi opt-in only. The original queue defines _drain as finish
 * the active query, then exit. waitForNextInput remains its original consumer. */
export function applyFullHostPiDrain(source){
 const before='    shouldClose: () =>\n      consumeSentinel(CLOSE_SENTINEL) || consumeSentinel(DRAIN_SENTINEL),';
 source=source.replaceAll('\r\n','\n');
 if(source.split(before).length!==2)throw Error('FULL_HOST_PI_DRAIN_ANCHOR_CHANGED');
 return source.replace(before,'    shouldClose: () => consumeSentinel(CLOSE_SENTINEL),');
}

/** A cancellation receipt is evidence that abort settled successfully, not
 * merely that the host requested it. Original writeOutput binds the active
 * input, including warm IPC turns whose delivery ID differs from input.turnId. */
export function applyFullHostPiAbort(source){
 const before=`        await session.abort().catch(() => undefined);
        break;
      }

      if (options.acceptIpcMessagesDuringQuery)`;
 source=source.replaceAll('\r\n','\n');
 if(source.split(before).length!==2)throw Error('FULL_HOST_PI_ABORT_ANCHOR_CHANGED');
 return source.replace(before,`        await session.abort();
        options.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'status',
            statusText: 'interrupted',
            agentScope: 'main',
            displayLevel: 'primary',
            sessionId: session.sessionId,
          },
        });
        break;
      }

      if (options.acceptIpcMessagesDuringQuery)`);
}
