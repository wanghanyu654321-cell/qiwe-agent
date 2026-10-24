import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {installRestorationIsolation} from './full-host-restoration-isolation.fixture.mts';
import {adminId,sessionId,memberSessionId,actor,workspaceJid,oldTaskId,readSeed,retainedSnapshot} from './full-host-restoration.fixture.mts';
import {exerciseEmployeeRestoration} from './full-host-restoration-employee.fixture.mts';
import {prepareLocalContainerTransport,localContainerAnswer,localContainerRequest} from './full-host-local-container.fixture.mts';

// The only runtime replacement is the external runner/model transport. The
// original main/queue/DB/scanner/gate/HTTP restore transaction remain real.
const transport=vi.hoisted(()=>({calls:[] as any[],pi:undefined as any}));
vi.mock('../src/container-runner.js',async importOriginal=>{
 const actual:any=await importOriginal();if(process.env.QIWE_RESTORATION_REAL_CONTAINER==='1')return actual;return {...actual,runContainerAgent:async(_group:any,input:any,_onProcess:any,onOutput:any)=>{
  if(transport.pi)return transport.pi.run(_group,input,_onProcess,onOutput);
  transport.calls.push(structuredClone(input));
  const output={status:'success',result:'合成恢复后答案',sourceKind:'sdk_final',finalizationReason:'completed',turnId:input.turnId,inputTurnId:input.turnId,inputTurnCompleted:true,newSessionId:'restoration-new-session'};
  await onOutput?.(output);return output;
 }};
});

it('restores the actual nonempty host through original HTTP before accepting any employee work',async()=>{
 const local=process.env.QIWE_RESTORATION_REAL_CONTAINER==='1'?prepareLocalContainerTransport(transport.calls):undefined;
 const boundary=installRestorationIsolation(local?.ports),seed=readSeed(),events:string[]=[];
 expect(seed.processId).not.toBe(process.pid);
 const db=await import('../src/db.js'),config=await import('../src/config.js');
 local?.prepare(config);
 const sql=new Database(path.join(config.STORE_DIR,'messages.db'),{fileMustExist:true});
 const web=await import('../src/web.js'),context=await import('../src/web-context.js');
 const host=await import('../src/index.js') as any;
 let shutdown=false,failure:unknown;
 try{
  await boundary.wait(()=>!!context.getWebDeps()&&boundary.servers.some(server=>server.listening),'actual main reaches loopback HTTP');
  expect(boundary.exits).toEqual([]);expect(host.fullHostBootGate.phase()).toBe('paused');
  expect(db.getUserById(adminId)?.role).toBe('admin');expect(db.getUserById(actor.accountId)?.role).toBe('member');
  expect(context.getWebDeps()!.queue).toBe(host.fullHostQueue);
  expect(retainedSnapshot(sql)).toEqual(seed.retained);expect(transport.calls).toEqual([]);
  const address=boundary.servers.find(server=>server.listening)!.address() as any,base='http://127.0.0.1:'+address.port;
  const {signSessionToken}=await import('../src/auth.js');
  const headers={cookie:'miniclaw_session='+signSessionToken(sessionId),Origin:'http://127.0.0.1:19777','content-type':'application/json',...(local?{Connection:'close'}:{})};
  const memberHeaders={...headers,cookie:'miniclaw_session='+signSessionToken(memberSessionId)};
  const status=await fetch(base+'/api/appointment/maintenance',{headers});expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({maintenance:true,phase:'paused'});
  // Exposes the real admin/member resource ACL conflict; no test changes owner,
  // role, ACL, scanner, gate or inventory to manufacture restoration permission.
  const initial=await fetch(base+'/api/appointment/maintenance/review',{method:'POST',headers,body:'{}'});
  const initialBody=await initial.json();
  console.log('RESTORATION_INITIAL_REVIEW',JSON.stringify({status:initial.status,body:initialBody,roles:{admin:db.getUserById(adminId)?.role,member:db.getUserById(actor.accountId)?.role},groups:Object.entries(db.getAllRegisteredGroups()).map(([jid,group]:any)=>({jid,owner:group.created_by,isHome:group.is_home,executionMode:group.executionMode}))}));
  expect(initial.status,'genuine admin must be authorized to manage whole-host restoration before fixture can proceed').not.toBe(403);
  const memberReview=await fetch(base+'/api/appointment/maintenance/review',{method:'POST',headers:memberHeaders,body:'{}'});
  expect(memberReview.status).toBe(403);
  const privateInput=seed.legacyReceipts.find((item:any)=>item.origin==='restoration-old-running');
  const selectedReview=await fetch(base+'/api/appointment/maintenance/groups/'+encodeURIComponent(workspaceJid)+'/inputs/'+encodeURIComponent(privateInput.messageId)+'/review',{method:'POST',headers,body:'{}'});
  expect(selectedReview.status,'host management authority does not grant selected employee input contents').toBe(403);
  const who={sessionId,userId:adminId},selections=[{kind:'task',taskId:oldTaskId},...seed.legacyReceipts.map((record:any)=>({kind:'message',chatJid:workspaceJid,messageId:record.messageId}))];
  for(const selection of selections){
   expect(()=>host.inspectFullHostLegacyWork({sessionId:memberSessionId,userId:actor.accountId},selection)).toThrow();
   const selected=host.inspectFullHostLegacyWork(who,selection);
   expect(()=>host.preserveFullHostLegacyWork(who,selection,'0'.repeat(64))).toThrow('STALE_SELECTION');
   expect(retainedSnapshot(sql)).toEqual(seed.retained);
   expect(host.preserveFullHostLegacyWork(who,selection,selected.version)).toMatchObject({state:'manual_review_required'});
  }
  expect(retainedSnapshot(sql)).toEqual(seed.retained);
  const inventory=db.scanAppointmentBootInventory();
  if(inventory.blockers.length)console.log('RESTORATION_SYNTHETIC_CONFIG_FILES',JSON.stringify(fs.existsSync(path.join(config.DATA_DIR,'config'))?fs.readdirSync(path.join(config.DATA_DIR,'config')):[]));
  console.log('RESTORATION_INVENTORY',JSON.stringify({blockers:inventory.blockers,blocked:inventory.records.filter((record:any)=>record.disposition==='blocked').map((record:any)=>({kind:record.kind,evidence:record.evidence}))}));
  const reviewed=await fetch(base+'/api/appointment/maintenance/review',{method:'POST',headers,body:'{}'}),review=await reviewed.json() as any;
  expect(reviewed.status,JSON.stringify(review)).toBe(200);expect(review).toMatchObject({recoverable:true});
  const restored=await fetch(base+'/api/appointment/maintenance/restore',{method:'POST',headers,body:JSON.stringify({confirmed:true,...review.ticket})});
  const restoredBody=await restored.json();expect(restored.status,JSON.stringify(restoredBody)).toBe(200);expect(restoredBody).toMatchObject({restored:true,maintenance:false});
  expect(host.fullHostBootGate.phase()).toBe('ready');expect(retainedSnapshot(sql)).toEqual(seed.retained);expect(transport.calls).toEqual([]);
  const privatePath='/api/groups/'+encodeURIComponent(workspaceJid)+'/messages';
  const privateRead=await fetch(base+privatePath,{headers});expect(privateRead.status,'original privacy contract hides another owner resource').toBe(404);
  expect(await privateRead.json()).toEqual({error:'Group not found'});
  const memberRead=await fetch(base+privatePath,{headers:memberHeaders});expect(memberRead.status,'real owning member can read own messages').toBe(200);
  events.push('original-main-admin-review-preserve-restore-commit-and-drain');
  if(process.env.QIWE_RESTORATION_PI==='1'){
   const {installRestorationPi}=await import('./full-host-restoration-pi.fixture.mts');
   transport.pi=await installRestorationPi({config,transportCalls:transport.calls});
  }
  local?.activate();
  const employee=await exerciseEmployeeRestoration({host,db,config,sql,boundary,seed,transportCalls:transport.calls,pi:transport.pi,events,...(local?{expectedAnswer:localContainerAnswer,request:localContainerRequest,c4Case:local.c4Case}:{})});
  const localContainer=await local?.verify(boundary);
  process.emit('SIGTERM');shutdown=true;await boundary.wait(()=>boundary.exits.length>0,'original main shutdown');expect(boundary.exits).toEqual([0]);
  fs.writeFileSync(process.env.QIWE_RESTORATION_FLOW_EVIDENCE??path.join(process.cwd(),'restoration-flow.json'),JSON.stringify({phase:process.env.QIWE_FULL_HOST_PHASE??'boot',processId:process.pid,events,transportCalls:transport.calls.length,employee,localContainer},null,2));
 }catch(error){
  failure=error;
  console.error('RESTORATION_PRIMARY_FAILURE',JSON.stringify({error:String(error),executions:sql.prepare('SELECT receipt_id,state,query_id,turn_id FROM wecom_conversation_execution').all(),piRuns:transport.pi?.runs.map(({kind,interrupted,closed,providerAborted}:any)=>({kind,interrupted,closed,providerAborted}))}));
  throw error;
 }finally{
  transport.pi?.releaseAll();
  if(!shutdown&&db.isDatabaseInitialized()){
   process.emit('SIGTERM');
   try{await boundary.wait(()=>boundary.exits.length>0,'failure cleanup original shutdown');}catch(error){if(!failure)throw error;console.error('RESTORATION_CLEANUP_FAILURE',String(error));}
  }
  await web.shutdownWebServer();if(db.isDatabaseInitialized())db.closeDatabase();sql.close();transport.pi?.close();boundary.close();
 }
});
