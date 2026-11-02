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

/** Per-conversation input queue for the Pi wrapper (fix for "Pi session ended
 * with uncompleted input turns"). Pi's followUp() only queues inside a live
 * agent loop: input accepted after agent_end is never run, and input consumed
 * by the same loop shares one agent_end/result with the turn before it. Here
 * each accepted IPC input gets its own session.prompt() on the same session,
 * strictly one at a time, so one turn = one prompt = one result. Inputs whose
 * receipt was already answered in this runner process are skipped on
 * redelivery/recovery so nothing is answered or pushed twice. */
export function applyFullHostPiInputQueue(source){
 source=source.replaceAll('\r\n','\n');
 const edits=[
  ['export async function runPiQueryAttempt(',
`// Receipts of input turns already answered by this runner process.
const piAnsweredInputKeys = new Set<string>();
const piInputKey = (message: IpcInputMessage): string | undefined =>
  message.receipt ? JSON.stringify(message.receipt) : undefined;

export async function runPiQueryAttempt(`],
  ['    const inputTurnCompleted = result.finalizationReason === \'completed\';\n',
`    const inputTurnCompleted = result.finalizationReason === 'completed';
    if (inputTurnCompleted) {
      for (const receipt of receipts) piAnsweredInputKeys.add(JSON.stringify(receipt));
      if (piAnsweredInputKeys.size > 2000) piAnsweredInputKeys.delete(piAnsweredInputKeys.values().next().value as string);
    }
`],
  [`    const promptPromise = session.prompt(
      toRuntimeInput(options.prompt, options.images),
    );
    let promptDone = false;
    promptPromise.then(
      () => {
        promptDone = true;
      },
      (error) => {
        promptDone = true;
        promptError = error;
      },
    );
`,
`    const queuedInputs: IpcInputMessage[] = [];
    const queuedKeys = new Set<string>();
    let promptDone = false;
    let promptPromise: Promise<unknown> = Promise.resolve();
    const startPrompt = (text: string, images?: Parameters<typeof toRuntimeInput>[1]): void => {
      promptDone = false;
      const current: Promise<unknown> = session.prompt(toRuntimeInput(text, images));
      promptPromise = current;
      current.then(
        () => {
          if (promptPromise === current) promptDone = true;
        },
        (error) => {
          if (promptPromise !== current) return;
          promptDone = true;
          promptError = error;
        },
      );
    };
    startPrompt(options.prompt, options.images);
`],
  [`        for (const message of messages) {
          options.tracker.acceptTurn([message]);
          await session.followUp(toRuntimeInput(message.text, message.images));
        }`,
`        for (const message of messages) {
          const key = piInputKey(message);
          if (key && (piAnsweredInputKeys.has(key) || queuedKeys.has(key))) continue;
          if (key) queuedKeys.add(key);
          options.tracker.acceptTurn([message]);
          queuedInputs.push(message);
        }`],
  [`      if (promptDone && !options.tracker.hasPendingTurns) break;
      if (promptDone && !session.isStreaming && !resultState.result) {
        if (!options.tracker.hasPendingTurns) break;`,
`      if (promptDone && !options.tracker.hasPendingTurns) break;
      if (promptDone && !session.isStreaming && !resultState.result) {
        if (!options.tracker.hasPendingTurns) break;
        // The previous turn is settled (its result was published), so the
        // next queued input starts its own turn on the same session.
        if (
          queuedInputs.length > 0 &&
          options.tracker.pendingTurnCount === queuedInputs.length
        ) {
          const next = queuedInputs.shift()!;
          startPrompt(next.text, next.images);
          continue;
        }`],
 ];
 for(const [before,after] of edits){if(source.split(before).length!==2)throw Error('FULL_HOST_PI_INPUT_QUEUE_ANCHOR_CHANGED');source=source.replace(before,()=>after);}
 return source;
}
