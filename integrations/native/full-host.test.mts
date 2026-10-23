import {expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
// No main, queue, database, Web server, route, gate or scanner is mocked.
it('boots the actual original main and real loopback Web stack while preserving paused durable work',async()=>{
 const events:string[]=[],intervals:any[]=[],timeouts:any[]=[],blocked:string[]=[];
 const intervalCallbacks:Function[]=[];
 const originalInterval=globalThis.setInterval,originalTimeout=globalThis.setTimeout;
 vi.spyOn(globalThis,'setInterval').mockImplementation(((...args:any[])=>{const timer=(originalInterval as any)(...args);intervals.push(timer);intervalCallbacks.push(args[0]);return timer;}) as any);
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((...args:any[])=>{const timer=(originalTimeout as any)(...args);timeouts.push(timer);return timer;}) as any);
 const servers:net.Server[]=[];
 const originalConnect=net.Socket.prototype.connect,originalListen=net.Server.prototype.listen;
 vi.spyOn(net.Socket.prototype,'connect').mockImplementation(function(this:net.Socket,...args:any[]){
  const raw=Array.isArray(args[0])?args[0]:args,first=raw[0];
  const host=typeof first==='object'?first.host:typeof raw[1]==='string'?raw[1]:'localhost';
  const port=Number(typeof first==='object'?first.port:first);
  const portBelongsToFixture=servers.some(server=>{const address=server.address();return address!==null&&typeof address==='object'&&address.address==='127.0.0.1'&&address.port===port;});
  if(typeof first==='object'&&first.path||typeof first==='string'||host!=='127.0.0.1'||!portBelongsToFixture){blocked.push('network');throw Error('FULL_HOST_EXTERNAL_NETWORK_FORBIDDEN');}
  return (originalConnect as any).apply(this,args);
 } as any);
 const originalLookup=dns.lookup;
 vi.spyOn(dns,'lookup').mockImplementation(((hostname:string,...args:any[])=>{
  if(!['127.0.0.1','::1'].includes(hostname)){blocked.push('dns');throw Error('FULL_HOST_DNS_FORBIDDEN');}
  return (originalLookup as any)(hostname,...args);
 }) as any);
 const originalPromiseLookup=dns.promises.lookup;
 vi.spyOn(dns.promises,'lookup').mockImplementation(((hostname:string,...args:any[])=>{
  if(!['127.0.0.1','::1'].includes(hostname)){blocked.push('dns');throw Error('FULL_HOST_DNS_FORBIDDEN');}
  return (originalPromiseLookup as any)(hostname,...args);
 }) as any);
 for(const name of Object.keys(dns).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'))vi.spyOn(dns,name as any).mockImplementation((()=>{blocked.push('dns:'+name);throw Error('FULL_HOST_DNS_FORBIDDEN');}) as any);
 for(const name of Object.keys(dns.promises).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'))vi.spyOn(dns.promises,name as any).mockImplementation((()=>{blocked.push('dns:'+name);throw Error('FULL_HOST_DNS_FORBIDDEN');}) as any);
 for(const name of ['send','connect','bind'] as const)vi.spyOn(dgram.Socket.prototype,name as any).mockImplementation((()=>{blocked.push('udp:'+name);throw Error('FULL_HOST_UDP_FORBIDDEN');}) as any);
 vi.spyOn(net.Server.prototype,'listen').mockImplementation(function(this:net.Server,...args:any[]){
  const first=args[0],port=typeof first==='number'?first:first?.port;
  if(!Number.isSafeInteger(port)||port<0||port>65535||first?.path||first?.fd!==undefined){blocked.push('listen');throw Error('FULL_HOST_LISTEN_FORBIDDEN');}
  if(typeof first==='number'){
   args[0]={port:first,host:'127.0.0.1'};
   if(typeof args[1]==='string')args.splice(1,1);
  }else args[0]={...first,host:'127.0.0.1'};
  servers.push(this);
  return (originalListen as any).apply(this,args);
 } as any);
 for(const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'] as const)vi.spyOn(childProcess,name as any).mockImplementation((()=>{blocked.push('child:'+name);throw Error('FULL_HOST_CHILD_PROCESS_FORBIDDEN');}) as any);
 syncBuiltinESMExports();
 const guardProbe=new net.Socket();
 for(const target of [{host:'127.0.0.1',port:65534},{host:'::1',port:65534},{host:'192.0.2.1',port:443},{path:'/synthetic-denied.sock'}])expect(()=>guardProbe.connect(target as any)).toThrow('FULL_HOST_EXTERNAL_NETWORK_FORBIDDEN');
 expect(()=>net.createServer().listen('/synthetic-denied.sock')).toThrow('FULL_HOST_LISTEN_FORBIDDEN');
 expect(()=>dns.resolve('synthetic.invalid',()=>{})).toThrow('FULL_HOST_DNS_FORBIDDEN');
 const udp=dgram.createSocket('udp4');expect(()=>udp.send('synthetic',1234,'192.0.2.1')).toThrow('FULL_HOST_UDP_FORBIDDEN');udp.close();
 expect(()=>childProcess.exec('synthetic forbidden')).toThrow('FULL_HOST_CHILD_PROCESS_FORBIDDEN');
 const listenProbe=net.createServer();listenProbe.listen(0,'0.0.0.0');
 if(!listenProbe.listening)await new Promise<void>(resolve=>listenProbe.once('listening',resolve));
 expect((listenProbe.address() as net.AddressInfo).address).toBe('127.0.0.1');
 await new Promise<void>(resolve=>listenProbe.close(()=>resolve()));servers.splice(servers.indexOf(listenProbe),1);
 blocked.length=0;events.push('boundary-guards-negative-controls-passed');
 const exits:number[]=[];vi.spyOn(process,'exit').mockImplementation(((code:number)=>{exits.push(code);}) as any);
 const db=await import('../src/db.js');
 const config=await import('../src/config.js');
 expect(config.DATA_DIR).toBe(path.join(process.cwd(),'data'));
 expect(fs.existsSync(path.join(config.DATA_DIR,'config/session-secret.key'))).toBe(false);
 const restarting=process.env.QIWE_FULL_HOST_PHASE==='restart';
 const now=new Date().toISOString(),adminId='synthetic-full-admin',sessionId='a'.repeat(64);
 const {default:Database}=await import('better-sqlite3');
 const conversationFixture=process.env.QIWE_FULL_HOST_CONVERSATIONS==='1'?await import('./full-host-conversation.fixture.mts'):undefined;
 const settlementFixture=conversationFixture?await import('./full-host-settlement.fixture.mts'):undefined;
 const resultEvidenceFixture=conversationFixture?await import('./full-host-result-evidence.fixture.mts'):undefined;
 if(!restarting){
 db.initDatabase();
 const seedSql=new Database(path.join(config.STORE_DIR,'messages.db'));
 const freshInventory=db.scanAppointmentBootInventory();
 console.log('FULL_HOST_FRESH_INVENTORY',JSON.stringify({blockers:freshInventory.blockers,kinds: freshInventory.records.reduce((out:any,record:any)=>{out[record.kind]=(out[record.kind]??0)+1;return out;},{})}));
 db.createUser({id:adminId,username:'synthetic-full-admin',password_hash:'synthetic-not-a-password',display_name:'Synthetic',role:'admin',status:'active',must_change_password:false,created_at:now,updated_at:now});
 db.createUserSession({id:sessionId,user_id:adminId,ip_address:null,user_agent:'synthetic',created_at:now,last_active_at:now,expires_at:new Date(Date.now()+3600000).toISOString()});
 for(const [id,expires]of [['b'.repeat(64),new Date(Date.now()+3600000).toISOString()],['c'.repeat(64),'2000-01-01T00:00:00.000Z']])db.createUserSession({id,user_id:adminId,ip_address:null,user_agent:'synthetic',created_at:now,last_active_at:now,expires_at:expires});
 db.setRegisteredGroup('web:full-role',{name:'Synthetic',folder:'full-role',added_at:now,created_by:adminId,executionMode:'container',is_home:false});
 db.ensureChatExists('web:full-role');
 db.storeMessageDirect('synthetic-promoting','web:full-role','synthetic','Synthetic','synthetic queued content',now,false);
 seedSql.prepare("UPDATE messages SET delivery_mode='queue',delivery_status='promoting' WHERE id='synthetic-promoting'").run();
 db.createTask({id:'full-unselected',group_folder:'full-role',chat_jid:'web:full-role',prompt:'synthetic task never execute',context_mode:'isolated',execution_type:'agent',execution_mode:'container',script_command:null,schedule_type:'cron',schedule_value:'0 * * * *',next_run:'2000-01-01T00:00:00.000Z',status:'active',created_at:now,created_by:adminId,notify_channels:null});
 const run=db.createTaskRun({task:db.getTaskById('full-unselected')!,triggerType:'manual',idempotencyKey:'synthetic-full-stale'}).run;
 seedSql.prepare("UPDATE task_runs SET status='success',notification_status='failed',notification_payload=?,notification_available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(JSON.stringify({kind:'send_message',chatJid:'web:full-role',text:'synthetic never deliver'}),run.id);
 if(conversationFixture)await conversationFixture.seed(db,seedSql,config);
 if(settlementFixture)await settlementFixture.seed();
 if(resultEvidenceFixture)resultEvidenceFixture.seed(db,seedSql);
 seedSql.close();
 }
 const sql=new Database(path.join(config.STORE_DIR,'messages.db'),{fileMustExist:true});
 const snapshot=()=>({messages:sql.prepare('SELECT * FROM messages ORDER BY id').all(),tasks:sql.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all(),runs:sql.prepare('SELECT * FROM task_runs ORDER BY id').all(),...(conversationFixture?{conversations:conversationFixture.snapshot(sql,config)}:{}),...(settlementFixture?{settlement:settlementFixture.snapshot(sql)}:{}),...(resultEvidenceFixture?{resultEvidence:resultEvidenceFixture.snapshot(sql)}:{})});
 let before=restarting?JSON.parse(fs.readFileSync(process.env.QIWE_FULL_HOST_SNAPSHOT!,'utf8')):snapshot();
 if(restarting)expect(snapshot()).toEqual(before);
 else{fs.writeFileSync(process.env.QIWE_FULL_HOST_SNAPSHOT!,JSON.stringify(before));db.closeDatabase();}
 const web=await import('../src/web.js');
 const context=await import('../src/web-context.js');
 const host=await import('../src/index.js') as any;
 try{
  for(let n=0;n<200&&(!context.getWebDeps()||!servers[0]?.listening);n++)await new Promise(resolve=>originalTimeout(resolve,25));
  expect(exits).toEqual([]);expect(servers[0]?.listening).toBe(true);
  const address=servers[0].address() as net.AddressInfo;
  expect(address.address).toBe('127.0.0.1');expect(address.port).toBeGreaterThan(0);
  const base='http://127.0.0.1:'+address.port;
  const {signSessionToken}=await import('../src/auth.js');
  const headers={cookie:'miniclaw_session='+signSessionToken(sessionId),Origin:'http://127.0.0.1:19777','content-type':'application/json'};
  const status=await fetch(base+'/api/appointment/maintenance',{headers});expect(status.status).toBe(200);expect(await status.json()).toMatchObject({maintenance:true,phase:'paused',executionStart:'not_started'});
  events.push('actual-main-loopback-http-paused');
  if(conversationFixture){
   const markers=['deleteExpiredSessions','checkAndExpireSubscriptions','reconcileMonthlyUsage','cleanupOldDailyUsage'];
   const beforeTimers=sql.prepare('SELECT * FROM user_sessions ORDER BY id').all();
   for(const marker of markers){
    const callbacks=intervalCallbacks.filter(fn=>fn.toString().includes(marker));
    expect(callbacks,marker+' actual main callback').toHaveLength(1);
    const writes=vi.spyOn(host.fullHostBootGate,'beginWrite');
    try{callbacks[0]();expect(writes,marker+' paused callback').not.toHaveBeenCalled();
     expect(sql.prepare('SELECT * FROM user_sessions ORDER BY id').all(),marker+' preserves expired session').toEqual(beforeTimers);
    }finally{writes.mockRestore();}
   }
   events.push('actual-paused-main-four-maintenance-timers-preserve-sqlite');
  }
  if(resultEvidenceFixture)resultEvidenceFixture.exercise({db,sql,restarting,events});
  if(conversationFixture)await conversationFixture.exercise({db,host,context,config,sql,snapshot,before,events});
  const unauth=await fetch(base+'/api/appointment/maintenance');expect(unauth.status).toBe(401);
  const inspectionGateCalls=['beginReview','publishReview','claimRestore','noteArrival','beginWrite','commitRestore'].map(name=>vi.spyOn(host.fullHostBootGate,name));
  const inspection=await fetch(base+'/api/appointment/maintenance/inspect',{method:'POST',headers,body:'{}'});
  expect(inspection.status).toBe(200);
  const inspectionBody=await inspection.json() as any;
  expect(inspectionBody.queueEvidence).toEqual({scope:'current_process_partial',status:'observed',
   counts:Object.fromEntries(Object.entries(host.fullHostQueue.getRecoveryObligations()).filter(([name])=>name!=='physicalCallbackWriteTickets')),
   physicalCallbackWriteTickets:'unknown',oldProcessOwnership:'unverified',writerCoverage:'unverified'});
  const inspectionInventory=db.scanAppointmentBootInventory();
  const expectedCounts={resource:0,input:0,execution:0,outbox:0,task:0,residue:0,observation:0,unknown:0};
  for(const item of inspectionInventory.records){
   const family=item.kind.split('/',1)[0];
   const kind=Object.hasOwn(expectedCounts,family)?family:'unknown';
   expectedCounts[kind as keyof typeof expectedCounts]++;
  }
  for(const family of ['resource','input','execution','task','observation'] as const)
   expect(expectedCounts[family],family).toBeGreaterThan(0);
  const fixedBlockers=new Set(['NON_DATABASE_RESIDUE_UNVERIFIED','EXTERNAL_WRITERS_UNVERIFIED','WRITER_COVERAGE_INCOMPLETE','OPAQUE_RUNTIME_METADATA_UNVERIFIED']);
  const otherBlockers=inspectionInventory.blockers.filter(blocker=>!fixedBlockers.has(blocker)).length;
  const expectedProofs=Object.fromEntries([
   ['nonDatabaseResidue','NON_DATABASE_RESIDUE_UNVERIFIED'],['externalWriters','EXTERNAL_WRITERS_UNVERIFIED'],
   ['writerCoverage','WRITER_COVERAGE_INCOMPLETE'],['opaqueRuntimeMetadata','OPAQUE_RUNTIME_METADATA_UNVERIFIED'],
  ].map(([name,code])=>[name,{status:'unverified',report:inspectionInventory.blockers.includes(code)?'reported':'not_reported'}]));
  expect(inspectionInventory.complete).toBe(false);expect(inspectionInventory.safe).toBe(false);
  expect(inspectionInventory.blockers.length).toBeGreaterThan(0);
  expect(inspectionInventory.blockers).toEqual(expect.arrayContaining([
   'EXTERNAL_WRITERS_UNVERIFIED','WRITER_COVERAGE_INCOMPLETE','OPAQUE_RUNTIME_METADATA_UNVERIFIED',
  ]));
  expect(inspectionBody).toMatchObject({maintenance:true,phase:'paused',restorePermission:'not_issued',
   proofs:expectedProofs,
   recordCounts:expectedCounts,blockerCount:inspectionInventory.blockers.length,otherBlockerCount:otherBlockers,
   observation:{scope:'current_process_partial',retry:'unknown',warm:'unknown',oldRunner:'unknown',externalWriter:'unknown'}});
  for(const name of ['activeCount','activeContainerCount','activeHostProcessCount','waitingCount','enabledAccounts','connectedAccounts'])
   expect(Number.isSafeInteger(inspectionBody.observation[name])&&inspectionBody.observation[name]>=0,name).toBe(true);
  const inspectionJson=JSON.stringify(inspectionBody);
  expect(inspectionJson).not.toContain('synthetic-promoting');
  expect(inspectionJson).not.toContain('synthetic-full-admin');
  expect(inspectionJson).not.toContain('synthetic queued content');
  expect(inspectionJson).not.toContain(inspectionInventory.records[0]?.key ?? 'never-an-inventory-key');
  expect(snapshot()).toEqual(before);
  expect(host.fullHostBootGate.phase()).toBe('paused');
  for(const operation of inspectionGateCalls)expect(operation).not.toHaveBeenCalled();
  events.push('actual-inspect-counts-only-preserves-paused-business');
  const review=await fetch(base+'/api/appointment/maintenance/review',{method:'POST',headers,body:'{}'});
  expect(review.status).toBe(409);expect(await review.json()).toMatchObject({error:'review_incomplete',recoverable:false});
  const inventory=db.scanAppointmentBootInventory();expect(inventory.complete).toBe(false);expect(inventory.safe).toBe(false);
  expect(inventory.records.length).toBeGreaterThan(0);events.push('actual-review-fail-closed');
  expect(host.fullHostBootGate.phase()).toBe('paused');
  const noOrigin={cookie:headers.cookie,'content-type':'application/json'};
  const refusals=[
   {name:'inspect-unauthenticated',operation:'inspect',headers:{Origin:headers.Origin,'content-type':'application/json'},body:'{}',status:401},
   {name:'inspect-wrong-origin',operation:'inspect',headers:{...headers,Origin:'https://synthetic.invalid'},body:'{}',status:403},
   {name:'inspect-missing-origin',operation:'inspect',headers:noOrigin,body:'{}',status:403},
   {name:'inspect-member',operation:'inspect',headers:{...headers,cookie:'miniclaw_session='+signSessionToken('b'.repeat(64))},body:'{}',status:403},
   {name:'inspect-other-owner',operation:'inspect',headers,body:'{}',status:conversationFixture?200:403},
   {name:'inspect-forced-password-change',operation:'inspect',headers,body:'{}',status:403},
   {name:'inspect-disabled-account',operation:'inspect',headers,body:'{}',status:403},
   {name:'inspect-expired',operation:'inspect',headers:{...headers,cookie:'miniclaw_session='+signSessionToken('c'.repeat(64))},body:'{}',status:401},
   {name:'inspect-missing-session',operation:'inspect',headers:{...headers,cookie:'miniclaw_session='+signSessionToken('d'.repeat(64))},body:'{}',status:401},
   {name:'inspect-unknown-field',operation:'inspect',headers,body:'{"syntheticUnknown":true}',status:400},
   {name:'inspect-oversized-body',operation:'inspect',headers,body:JSON.stringify({syntheticUnknown:'x'.repeat(4096)}),status:400},
   {name:'wrong-origin',operation:'review',headers:{...headers,Origin:'https://synthetic.invalid'},body:'{}',status:403},
   {name:'missing-origin',operation:'review',headers:noOrigin,body:'{}',status:403},
   {name:'member',operation:'review',headers:{...headers,cookie:'miniclaw_session='+signSessionToken('b'.repeat(64))},body:'{}',status:403},
   {name:'expired',operation:'review',headers:{...headers,cookie:'miniclaw_session='+signSessionToken('c'.repeat(64))},body:'{}',status:401},
   {name:'missing-session',operation:'review',headers:{...headers,cookie:'miniclaw_session='+signSessionToken('d'.repeat(64))},body:'{}',status:401},
   {name:'unissued-ticket',operation:'restore',headers,body:JSON.stringify({confirmed:true,bootId:'synthetic-unissued',reportId:'synthetic-unissued',revision:0}),status:409},
   {name:'not-confirmed',operation:'restore',headers,body:JSON.stringify({confirmed:false,bootId:'synthetic-unissued',reportId:'synthetic-unissued',revision:0}),status:400},
   {name:'unknown-field',operation:'review',headers,body:'{"syntheticUnknown":true}',status:400},
   {name:'oversized-body',operation:'review',headers,body:JSON.stringify({syntheticUnknown:'x'.repeat(4096)}),status:400},
  ];
  for(const refusal of refusals){
   // Exercise live member role revalidation using the same synthetic account;
   // The separate restoration scenario uses genuine admin/member accounts.
   if(refusal.name==='member'||refusal.name==='inspect-member')sql.prepare("UPDATE users SET role='member' WHERE id=?").run(adminId);
   if(refusal.name==='inspect-other-owner')sql.prepare("UPDATE registered_groups SET created_by='synthetic-foreign-owner' WHERE jid='web:full-role'").run();
   if(refusal.name==='inspect-forced-password-change')sql.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(adminId);
   if(refusal.name==='inspect-disabled-account')sql.prepare("UPDATE users SET status='disabled' WHERE id=?").run(adminId);
   let response:Response;
   try{response=await fetch(base+'/api/appointment/maintenance/'+refusal.operation,{method:'POST',headers:refusal.headers,body:refusal.body});}
   finally{
    if(refusal.name==='member'||refusal.name==='inspect-member')sql.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminId);
    if(refusal.name==='inspect-other-owner')sql.prepare("UPDATE registered_groups SET created_by=? WHERE jid='web:full-role'").run(adminId);
    if(refusal.name==='inspect-forced-password-change')sql.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(adminId);
    if(refusal.name==='inspect-disabled-account')sql.prepare("UPDATE users SET status='active' WHERE id=?").run(adminId);
   }
   expect(response.status,refusal.name).toBe(refusal.status);
   const refusalBody=await response.text();
   if(refusal.name==='inspect-other-owner'&&conversationFixture){
    expect(refusalBody).not.toContain('synthetic queued content');
    expect(refusalBody).not.toContain('synthetic-foreign-owner');
   }
   expect(host.fullHostBootGate.phase(),refusal.name).toBe('paused');expect(snapshot(),refusal.name).toEqual(before);
   expect(sql.prepare("SELECT COUNT(*) AS n FROM auth_audit_log WHERE event_type='appointment_restore_committed'").get()).toMatchObject({n:0});
  }
  events.push('original-http-origin-acl-ticket-body-refusals-preserve-state');
  const {createAppointmentBootRoutes}=await import('../src/appointment-boot-http.js');
  for(const scenario of [
   {name:'missing-port',port:undefined},
   {name:'nonfunction-port',port:42},
   {name:'throwing-port',port:()=>{throw Error('synthetic private observation error');}},
   {name:'thenable-port',port:()=>Promise.resolve({activeCount:0})},
   {name:'async-port',port:async()=>({activeCount:0})},
  ]){
   const local=createAppointmentBootRoutes({gate:host.fullHostBootGate,origin:headers.Origin,
    readInventory:()=>({inventory:db.scanAppointmentBootInventory(),resourceJids:Object.keys(db.getAllRegisteredGroups()).sort()}),
    prepare:async()=>{},drain:()=>{},readRecoveryObservation:scenario.port} as any);
   const inspect=await local.fetch(new Request(base+'/api/appointment/maintenance/inspect',{method:'POST',headers,body:'{}'}));
   expect(inspect.status,scenario.name).toBe(503);
   const oldReview=await local.fetch(new Request(base+'/api/appointment/maintenance/review',{method:'POST',headers,body:'{}'}));
   expect(oldReview.status,scenario.name+' original review compatibility').toBe(409);
   expect(host.fullHostBootGate.phase(),scenario.name).toBe('paused');
   expect(snapshot(),scenario.name).toEqual(before);
  }
  events.push('direct-real-routes-invalid-observation-port-does-not-break-review');
  for(const port of [42,()=>{throw Error('private queue error');},()=>Promise.resolve({}),async()=>({}),()=>({})]){
   const local=createAppointmentBootRoutes({gate:host.fullHostBootGate,origin:headers.Origin,
    readInventory:()=>({inventory:db.scanAppointmentBootInventory(),resourceJids:Object.keys(db.getAllRegisteredGroups()).sort()}),
    prepare:async()=>{},drain:()=>{},readRecoveryObservation:()=>({activeCount:0,activeContainerCount:0,activeHostProcessCount:0,waitingCount:0,enabledAccounts:0,connectedAccounts:0}),readRecoveryObligations:port} as any);
   const result=await local.fetch(new Request(base+'/api/appointment/maintenance/inspect',{method:'POST',headers,body:'{}'}));
   expect(result.status).toBe(503);expect(await result.text()).not.toContain('private queue');
   const oldReview=await local.fetch(new Request(base+'/api/appointment/maintenance/review',{method:'POST',headers,body:'{}'}));
   expect(oldReview.status).toBe(409);expect(snapshot()).toEqual(before);
  }
  const queue=context.getWebDeps()!.queue;expect(queue).toBe(host.fullHostQueue);
  const work=vi.fn(async()=>{});expect(queue.enqueueTask('web:full-role','synthetic-probe',work,{allowInactive:true})).toBe(true);
  await new Promise(resolve=>originalTimeout(resolve,100));expect(work).not.toHaveBeenCalled();expect(snapshot()).toEqual(before);
  const queuedEvidence=await fetch(base+'/api/appointment/maintenance/inspect',{method:'POST',headers,body:'{}'});
  expect(queuedEvidence.status).toBe(200);
  expect((await queuedEvidence.json() as any).queueEvidence.counts).toMatchObject({pendingTasks:1,retainedQueuedWork:1});
  expect(work).not.toHaveBeenCalled();expect(snapshot()).toEqual(before);expect(host.fullHostBootGate.phase()).toBe('paused');
  events.push('actual-inspect-original-queue-obligations-not-global-proof');
  events.push('actual-queue-db-promoting-notification-preserved');
  if(settlementFixture){
   await settlementFixture.exercise({db,host,context,sql,restarting,events});
   if(!restarting){before=snapshot();fs.writeFileSync(process.env.QIWE_FULL_HOST_SNAPSHOT!,JSON.stringify(before));}
   else expect(snapshot()).toEqual(before);
  }
  process.emit('SIGTERM');
  for(let n=0;n<200&&!exits.length;n++)await new Promise(resolve=>originalTimeout(resolve,25));
  expect(exits).toEqual([0]);expect(servers[0].listening).toBe(false);expect(queue.isShuttingDown()).toBe(true);expect(db.isDatabaseInitialized()).toBe(false);events.push('actual-main-signal-shutdown');
  db.initDatabase();expect(snapshot()).toEqual(before);db.closeDatabase();events.push('actual-db-reopen-preserved');
  expect(blocked).toEqual([]);
  fs.writeFileSync(process.env.QIWE_FULL_HOST_EVIDENCE!,JSON.stringify({events,phase:restarting?'restart':'boot',processId:process.pid,loopback:address,source:'actual original main and complete O stack',limitations:['this paused regression supplies no supervisor boundary; successful restoration is exercised separately','Static frontend assets are absent; HTTP API and WebSocket server startup are exercised'],guards:['TCP only to actual fixture IPv4 loopback HTTP ports; Unix sockets and named pipes refused','DNS only numeric loopback lookup; resolve/reverse and all UDP bind/connect/send refused','child_process exec/execFile/spawn/fork families refused','pure allowlisted environment, synthetic HOME/cwd/data and fixed session secret','process.exit is observed and original shutdown body runs; native worker/addon filesystem calls are not a general filesystem sandbox'],observedNoBlockedAttempts:blocked.length===0},null,2));
 }finally{
  await web.shutdownWebServer();if(db.isDatabaseInitialized())db.closeDatabase();sql.close();
  for(const timer of intervals)clearInterval(timer);for(const timer of timeouts)clearTimeout(timer);
  process.removeAllListeners('SIGTERM');process.removeAllListeners('SIGINT');vi.restoreAllMocks();syncBuiltinESMExports();
 }
});
