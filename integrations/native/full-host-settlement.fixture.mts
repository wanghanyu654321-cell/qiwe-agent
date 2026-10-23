import {expect,vi} from 'vitest';

// Exercises an existing internal original API. This fixture grants no HTTP
// capability, recovery permission, Provider settlement or old-writer proof.
const route={provider:'feishu',accountId:'synthetic-settlement-account',sourceJid:'web:full-role'};
const ids=['local','fault','active'];
export async function seed(){
 const store=await import('../src/channel-reliability-store.js');
 for(const id of ids){
  const turn=store.createChannelTurnRun({...route,id:'settlement-turn-'+id,idempotencyKey:'settlement-'+id,now:'2000-01-01T00:00:00.000Z'}).run;
  store.claimChannelTurnRunById(turn.id,'synthetic-old-owner',id==='active'?86400000:60000,id==='active'?new Date():'2000-01-01T00:00:00.000Z');
  store.createStreamingCardRecord({...route,id:'settlement-card-'+id,turnRunId:turn.id,status:'streaming'});
 }
}
export function snapshot(sql:any){return {
 cards:sql.prepare("SELECT * FROM streaming_cards WHERE id LIKE 'settlement-card-%' ORDER BY id").all(),
 turns:sql.prepare("SELECT * FROM turn_runs WHERE id LIKE 'settlement-turn-%' ORDER BY id").all(),
};}
export async function exercise({db,host,context,sql,restarting,events}:any){
 const store=await import('../src/channel-reliability-store.js');
 const {reconcileSelectedStreamingCard}=await import('../src/channel-reliability-recovery.js');
 const provider=vi.fn(async()=>{throw Error('SETTLEMENT_PROVIDER_CALL_FORBIDDEN');});
 const selection=(id:string)=>{const c=store.getStreamingCardRecord('settlement-card-'+id)!;return {id:c.id,revision:c.revision,provider:c.provider,accountId:c.accountId,sourceJid:c.sourceJid,turnRunId:c.turnRunId};};
 expect(context.getWebDeps()!.appointmentBootGate).toBe(host.fullHostBootGate);
 expect(db.getAppointmentRestorePrincipal({userId:'synthetic-full-admin',sessionId:'a'.repeat(64)}).role).toBe('admin');
 if(!restarting){
  const before=snapshot(sql),selected=selection('local');
  for(const change of [{revision:selected.revision+1},{accountId:'foreign'},{sourceJid:'web:foreign'},{turnRunId:'foreign'},{provider:'foreign'}]){
   expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},{...selected,...change})).toEqual({kind:'deferred',reason:'selection_changed'});
   expect(snapshot(sql)).toEqual(before);
  }
  expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selection('active'))).toEqual({kind:'deferred',reason:'active_lease'});
  expect(snapshot(sql)).toEqual(before);
  const oldTurn=store.getChannelTurnRun(selected.turnRunId)!;
  expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selected)).toEqual({kind:'reconciled',basis:'manual_reconciliation',interruptedTurnId:selected.turnRunId});
  expect(store.getStreamingCardRecord(selected.id)).toMatchObject({status:'failed',snapshot:{recovery:{reason:'missing_provider_identity',method:'manual_reconciliation'}}});
  expect(store.getChannelTurnRun(selected.turnRunId)).toMatchObject({status:'interrupted',leaseOwner:null,leaseExpiresAt:null,leaseToken:oldTurn.leaseToken+1});
  expect(store.updateStreamingCardRecord(selected.id,selected.revision,{status:'streaming'})).toBeUndefined();
  expect(store.completeChannelTurnRun({id:oldTurn.id,leaseOwner:oldTurn.leaseOwner!,leaseToken:oldTurn.leaseToken},{now:'2000-01-01T00:00:01.000Z'})).toBe(false);
  expect(store.claimChannelTurnRunById(oldTurn.id,'new-owner',60000)).toBeUndefined();
  const faultSelection=selection('fault');
  // Failure is scoped to this exact second write, not the shared DB directory.
  sql.exec("CREATE TRIGGER synthetic_settlement_interrupt_failure BEFORE UPDATE OF status ON turn_runs WHEN OLD.id='settlement-turn-fault' AND NEW.status='interrupted' BEGIN SELECT RAISE(ABORT,'synthetic_turn_interrupt_failure'); END");
  try{
   await expect(reconcileSelectedStreamingCard({reconcileStreamingCard:provider},faultSelection)).rejects.toThrow('synthetic_turn_interrupt_failure');
   expect(store.getStreamingCardRecord(faultSelection.id)?.status).toBe('failed');
   expect(store.getChannelTurnRun(faultSelection.turnRunId)?.status).toBe('running');
   const partial=snapshot(sql);
   await expect(reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selection('fault'))).rejects.toThrow('synthetic_turn_interrupt_failure');
   expect(snapshot(sql)).toEqual(partial);
   for(const change of [{revision:selection('fault').revision+1},{accountId:'foreign'},{sourceJid:'web:foreign'},{turnRunId:'foreign'}]){
    expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},{...selection('fault'),...change})).toEqual({kind:'deferred',reason:'selection_changed'});
    expect(snapshot(sql)).toEqual(partial);
   }
   const card=store.getStreamingCardRecord(faultSelection.id)!;
   for(const [column,value] of [['snapshot',JSON.stringify({recovery:{reason:'unrelated',method:'manual_reconciliation'}})],['error','unrelated']]){
    sql.prepare('UPDATE streaming_cards SET '+column+'=? WHERE id=?').run(value,card.id);
    expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selection('fault'))).toEqual({kind:'skipped'});
    sql.prepare('UPDATE streaming_cards SET '+column+'=? WHERE id=?').run(column==='snapshot'?JSON.stringify(card.snapshot):card.error,card.id);
   }
   for(const [column,original] of [['account_id',route.accountId],['chat_id',null],['root_id',null],['thread_id',null]]){
    sql.prepare('UPDATE turn_runs SET '+column+"='foreign' WHERE id=?").run(faultSelection.turnRunId);
    expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selection('fault'))).toEqual({kind:'deferred',reason:'identity_fence_failed'});
    sql.prepare('UPDATE turn_runs SET '+column+'=? WHERE id=?').run(original,faultSelection.turnRunId);
   }
   const turn=store.getChannelTurnRun(faultSelection.turnRunId)!;
   sql.prepare('UPDATE turn_runs SET lease_expires_at=? WHERE id=?').run('2999-01-01T00:00:00.000Z',turn.id);
   expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selection('fault'))).toEqual({kind:'deferred',reason:'active_lease'});
   sql.prepare('UPDATE turn_runs SET lease_expires_at=? WHERE id=?').run(turn.leaseExpiresAt,turn.id);
   expect(snapshot(sql)).toEqual(partial);
  }
  finally{sql.exec('DROP TRIGGER synthetic_settlement_interrupt_failure');}
  console.log('SETTLEMENT_AFTER_SECOND_WRITE_FAILURE',JSON.stringify({card:store.getStreamingCardRecord(faultSelection.id)?.status,turn:store.getChannelTurnRun(faultSelection.turnRunId)?.status}));
  // Re-select the actual durable revision, as a caller must after any failure.
  const retried=await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selection('fault'));
  console.log('SETTLEMENT_RETRY_RESULT',JSON.stringify(retried));
  expect(store.getChannelTurnRun(faultSelection.turnRunId)?.status,'selected local disposition must remain recoverable after the second write fails').toBe('interrupted');
  expect(retried).toEqual({kind:'reconciled',basis:'manual_reconciliation',interruptedTurnId:faultSelection.turnRunId});
  const settled=snapshot(sql);
  expect(await reconcileSelectedStreamingCard({reconcileStreamingCard:provider},selection('fault'))).toEqual({kind:'skipped'});
  expect(snapshot(sql)).toEqual(settled);
  events.push('original-selected-card-local-disposition-real-sqlite');
 }else{
  for(const id of ['local','fault']){
   expect(store.getStreamingCardRecord('settlement-card-'+id)?.status).toBe('failed');
   expect(store.getChannelTurnRun('settlement-turn-'+id)?.status).toBe('interrupted');
  }
  events.push('original-selected-card-disposition-second-process-read-only');
 }
 expect(provider).not.toHaveBeenCalled();
 const inventory=db.scanAppointmentBootInventory();
 expect(inventory).toMatchObject({complete:false,safe:false});
 for(const blocker of ['NON_DATABASE_RESIDUE_UNVERIFIED','EXTERNAL_WRITERS_UNVERIFIED','WRITER_COVERAGE_INCOMPLETE','OPAQUE_RUNTIME_METADATA_UNVERIFIED'])expect(inventory.blockers).toContain(blocker);
 const selectedRecords=inventory.records.filter((r:any)=>r.kind.endsWith('/streaming_cards')||r.kind.endsWith('/turn_runs'));
 expect(selectedRecords).toHaveLength(6);
 expect(selectedRecords.every((r:any)=>r.disposition==='blocked')).toBe(true);
 expect(host.fullHostBootGate.phase()).toBe('paused');
 expect(context.getWebDeps()!.appointmentBootRecovery.verifyInputUnexecuted).toBeUndefined();
}
