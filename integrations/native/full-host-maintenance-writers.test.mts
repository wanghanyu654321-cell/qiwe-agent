import {expect,it,vi} from 'vitest';
import {bindMaintenanceCallbacks} from '../test-support/full-host-maintenance-callbacks.mjs';
import {createAppointmentBootGate} from '../src/appointment-boot-gate.js';

// Callback extraction is from the composed main. Narrow original-mode checks
// prove ticket lifecycle, not full-host recovery or actual billing semantics.
it('keeps all four exact main callbacks paused and registers each original-mode write through exceptions',()=>{
 for(const mode of ['appointment','original'] as const){
  const gate=createAppointmentBootGate(mode),begin=vi.spyOn(gate,'beginWrite'),finish=vi.spyOn(gate,'finishWrite');
  let calls=0,fail=false;
  const observe=()=>{calls++;expect(begin).toHaveBeenCalledTimes(1);expect(finish).not.toHaveBeenCalled();if(fail)throw Error('synthetic maintenance failure');};
  const callbacks=bindMaintenanceCallbacks({appointmentBootGate:gate,logger:{info(){},warn(){},error(){}},
   getExpiredSessionIds:()=>{observe();return ['synthetic'];},invalidateSessionCache:()=>{},deleteExpiredSessions:()=>1,
   checkAndExpireSubscriptions:observe,isBillingEnabled:()=>true,listUsers:()=>({users:[{id:'synthetic',role:'member'}]}),reconcileMonthlyUsage:observe,
   cleanupOldDailyUsage:()=>{observe();return 1;},cleanupOldBillingAuditLog:()=>1});
  expect(callbacks).toHaveLength(4);
  for(const callback of callbacks)for(const throws of [false,true]){
   calls=0;fail=throws;begin.mockClear();finish.mockClear();
   try{callback();}catch(error){expect(mode).toBe('original');expect(throws).toBe(true);expect(String(error)).toContain('synthetic maintenance failure');}
   if(mode==='appointment'){expect(calls).toBe(0);expect(begin).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalled();}
   else{expect(calls).toBe(1);expect(finish).toHaveBeenCalledExactlyOnceWith(begin.mock.results[0].value);}
  }
 }
});
