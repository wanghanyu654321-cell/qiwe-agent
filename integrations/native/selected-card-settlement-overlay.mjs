// Applied only after the hash-verified original selected-card transform.
// Repairs its interrupted second local write; it grants no external settlement.
function once(source,before,after){
 if(typeof source!=='string'||source.split(before).length!==2)throw Error('SELECTED_CARD_SETTLEMENT_ANCHOR_CHANGED');
 return source.replace(before,after);
}
export function applySelectedCardSettlement(files){
 const result=new Map(files);
 result.set('channel-reliability-store.ts',files.get('channel-reliability-store.ts')+`
/** Complete only the local turn interruption left behind by the original
 * missing-identity card failure. The same SQLite transaction rechecks both
 * exact identities and the live lease before the original interrupt writes.
 * A concurrent writer causes the normal SQLite transaction conflict/rollback;
 * this is not proof of any old process or Provider having lost its authority. */
export function resumeMissingIdentityCardInterruption(
 selection: Readonly<Pick<StreamingCardRecord,'id'|'revision'|'provider'|'accountId'|'sourceJid'|'turnRunId'>>,
 expectedError: string,
): 'not_applicable'|'selection_changed'|'active_lease'|'interrupted'|'identity_fence_failed' {
 return requireDatabase().transaction(() => {
  const card=getStreamingCardRecord(selection.id);
  if(!card||card.revision!==selection.revision||card.provider!==selection.provider||
   card.accountId!==selection.accountId||card.sourceJid!==selection.sourceJid||card.turnRunId!==selection.turnRunId)return 'selection_changed' as const;
  const snapshot=card.snapshot as {recovery?:{reason?:unknown;method?:unknown}}|null;
  if(card.provider!=='feishu'||card.status!=='failed'||card.messageId||card.cardId||card.error!==expectedError||
   snapshot?.recovery?.reason!=='missing_provider_identity'||snapshot.recovery.method!=='manual_reconciliation')return 'not_applicable' as const;
  const turn=getChannelTurnRun(card.turnRunId);
  if(!turn||turn.provider!==card.provider||turn.accountId!==card.accountId||turn.sourceJid!==card.sourceJid||
   turn.chatId!==card.chatId||turn.rootId!==card.rootId||turn.threadId!==card.threadId)return 'identity_fence_failed' as const;
  const now=new Date().toISOString();
  if(['running','finalizing'].includes(turn.status)&&turn.leaseOwner!==null&&turn.leaseExpiresAt!==null&&turn.leaseExpiresAt>now)return 'active_lease' as const;
  if(!['queued','running','finalizing','waiting_user','retry_wait'].includes(turn.status))return 'not_applicable' as const;
  return interruptChannelTurnRunById(turn.id,expectedError,now)?'interrupted' as const:'identity_fence_failed' as const;
 })();
}
`);
 let recovery=files.get('channel-reliability-recovery.ts');
 recovery=once(recovery,'  claimStreamingCardRecovery,','  resumeMissingIdentityCardInterruption,\n  claimStreamingCardRecovery,');
 recovery=once(recovery,"  const prepared = prepareStreamingCardRecovery(\n    card, { mode: 'startup' }, new Date().toISOString(),\n  );",`  const resumed=resumeMissingIdentityCardInterruption(selection,MISSING_PROVIDER_IDENTITY_ERROR);
  if(resumed==='interrupted')return {kind:'reconciled',basis:'manual_reconciliation',interruptedTurnId:card.turnRunId};
  if(resumed!=='not_applicable')return {kind:'deferred',reason:resumed};
  const prepared = prepareStreamingCardRecovery(
    card, { mode: 'startup' }, new Date().toISOString(),
  );`);
 result.set('channel-reliability-recovery.ts',recovery);
 return result;
}
