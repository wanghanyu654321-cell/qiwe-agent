import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import crypto from 'node:crypto';
import ts from 'typescript';
import * as overlay from './role-workspace-overlay.mjs';

const actor={tenantId:'synthetic-tenant',accountId:'original-member',storeId:'store-b',role:'marketing',grantVersion:2,corpId:'synthetic-corp',botId:'synthetic-bot',memberId:'synthetic-member',bindingVersion:3};
const approved={...actor,profileId:'original-profile-1',workspaceJid:'web:original-role-1'};
const key=(who=actor)=>crypto.createHash('sha256').update(JSON.stringify([who.tenantId,who.accountId,who.storeId,who.role])).digest('hex');
const databases:DatabaseSync[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});

// Execute the generated Native claim functions against real SQLite, including
// nested savepoints matching the Native driver's synchronous transaction API.
function fixture(){
 const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
 sqlite.exec(`CREATE TABLE router_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE users (id TEXT PRIMARY KEY,username TEXT,role TEXT,status TEXT,must_change_password INTEGER);
 CREATE TABLE agent_profiles (id TEXT PRIMARY KEY,owner_user_id TEXT,status TEXT,is_default INTEGER);
 CREATE TABLE registered_groups (jid TEXT PRIMARY KEY,folder TEXT UNIQUE,created_by TEXT,is_home INTEGER,execution_mode TEXT);
 CREATE TABLE workspace_agent_profiles (group_folder TEXT PRIMARY KEY,agent_profile_id TEXT);`);
 sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(actor.accountId,'original-member','member','active',0);
 for(let i=0;i<8;i++){
  sqlite.prepare('INSERT INTO agent_profiles VALUES (?,?,?,?)').run(`original-profile-${i}`,actor.accountId,'active',i===0?1:0);
  sqlite.prepare('INSERT INTO registered_groups VALUES (?,?,?,?,?)').run(i===0?'web:original-home':`web:original-role-${i}`,`original-folder-${i}`,actor.accountId,i===0?1:0,'container');
  sqlite.prepare('INSERT INTO workspace_agent_profiles VALUES (?,?)').run(`original-folder-${i}`,`original-profile-${i}`);
 }
 let depth=0;
 const db={prepare:(sql:string)=>sqlite.prepare(sql),transaction:(work:()=>unknown)=>()=>{
  const savepoint=`test_transaction_${depth++}`;
  sqlite.exec(`SAVEPOINT ${savepoint}`);
  try{const result=work();sqlite.exec(`RELEASE ${savepoint}`);return result;}
  catch(error){sqlite.exec(`ROLLBACK TO ${savepoint}`);sqlite.exec(`RELEASE ${savepoint}`);throw error;}
  finally{depth--;}
 }};
 const generated=overlay.addOwnedWorkspaceClaims('export function getRouterState(key: string) {}');
 const suffix=generated.slice(generated.indexOf('export interface OwnedRoleWorkspaceClaim'));
 const compiled=ts.transpileModule(suffix.replace(/\bexport\s+/g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const claims=new Function('db','crypto','getRouterState',compiled+';return {claimOwnedRoleWorkspace,resolveOwnedRoleWorkspace,getOwnedRoleWorkspaceClaim,getOwnedRoleWorkspaceClaimsForOwner,withOwnedRoleWorkspaceTransaction};')(db,crypto,(name:string)=>sqlite.prepare('SELECT value FROM router_state WHERE key=?').get(name)?.value);
 const group=(row:any)=>row?{...row,is_home:row.is_home===1,executionMode:row.execution_mode}:undefined;
 const forbidden=()=>{throw Error('RESOURCE_CREATION_FORBIDDEN');};
 const native={...claims,
  getUserById:(id:string)=>{const row=sqlite.prepare('SELECT * FROM users WHERE id=?').get(id);return row?{...row,must_change_password:row.must_change_password===1}:undefined;},
  getGroupsByOwner:(id:string)=>sqlite.prepare('SELECT * FROM registered_groups WHERE created_by=?').all(id).map(group),
  getRegisteredGroup:(jid:string)=>group(sqlite.prepare('SELECT * FROM registered_groups WHERE jid=?').get(jid)),
  getAgentProfileForUser:(id:string,owner:string)=>sqlite.prepare("SELECT * FROM agent_profiles WHERE id=? AND owner_user_id=? AND status='active'").get(id,owner),
  getWorkspaceAgentProfileId:(folder:string)=>sqlite.prepare('SELECT agent_profile_id FROM workspace_agent_profiles WHERE group_folder=?').get(folder)?.agent_profile_id,
  createUser:forbidden,createOwnedRoleProfile:forbidden,createOwnedRoleWorkspace:forbidden,prepareOwnProfiles:forbidden,
 };
 const snapshot=()=>['users','agent_profiles','registered_groups','workspace_agent_profiles'].map(table=>sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
 const state=()=>sqlite.prepare('SELECT * FROM router_state ORDER BY key').all();
 let current:any={...actor},paused=false,ticket=true,finished=0;
 const gate={isPaused:()=>paused,beginWrite:()=>ticket?Symbol('synthetic-write'):null,finishWrite:()=>{finished++;}};
 const request=(who=actor)=>({actor:{...who},scope:{signal:new AbortController().signal,deadline:performance.now()+10000},idempotencyKey:key(who),assertCurrent:async()=>{if(!current)throw Error('revoked');},withCurrent:async<T,>(work:()=>T)=>{if(!current)throw Error('revoked');return work();}});
 const make=(options:any={})=>{
  expect(typeof (overlay as any).createExistingRoleWorkspaceAdopter).toBe('function');
  return (overlay as any).createExistingRoleWorkspaceAdopter({gate,native,readActor:async()=>current,approvedResources:[approved],...options});
 };
 const seed=(changes:any={})=>native.claimOwnedRoleWorkspace({tenantId:actor.tenantId,ownerId:actor.accountId,storeId:actor.storeId,role:actor.role,resourceKey:key(),corpId:actor.corpId,botId:actor.botId,memberId:actor.memberId,bindingVersion:actor.bindingVersion,grantVersion:actor.grantVersion,...changes});
 return {sqlite,native,request,make,snapshot,state,seed,gate,setCurrent:(value:any)=>{current=value;},pause:()=>{paused=true;},denyTicket:()=>{ticket=false;},finished:()=>finished};
}

describe('operator adoption of approved existing Native role resources',()=>{
 it('preserves the original employee, eight Profiles, eight groups and links; repeat and lost-response lookup use the same claim',async()=>{
  const f=fixture(),before=f.snapshot(),port=f.make();
  const reader=overlay.createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate:f.gate,native:f.native,templates:[{key:'marketing',skills:[]}],prepareOwnProfiles:async()=>{throw Error('INSTALL_FORBIDDEN');},journalDirectory:'synthetic',readActor:async()=>({...actor})});
  expect(await reader.readRoleWorkspace(f.request())).toMatchObject({state:'missing'});
  expect(await reader.prepareRoleWorkspace(f.request())).toMatchObject({state:'unknown'});
  expect(f.state()).toEqual([]);
  const result=await port.adopt(f.request());
  expect(result).toEqual({state:'ready',workspaceJid:'web:original-role-1',profileId:'original-profile-1',ownerAccountId:'original-member',storeId:'store-b',role:'marketing'});
  const committed=f.state();expect(committed).toHaveLength(1);
  expect(f.native.getOwnedRoleWorkspaceClaim(key())).toMatchObject({state:'ready',profileId:'original-profile-1',workspaceJid:'web:original-role-1',bindingVersion:3,grantVersion:2});
  // A new adopter represents the caller having lost the committed response.
  expect(await f.make().adopt(f.request())).toEqual(result);
  expect(f.state()).toEqual(committed);expect(f.snapshot()).toEqual(before);expect(f.finished()).toBe(3);
  expect(await reader.readRoleWorkspace(f.request())).toEqual(result);
 });

 it.each(['tenantId','accountId','storeId','role','corpId','botId','memberId'] as const)('refuses an unapproved %s without writing claims',async field=>{
  const f=fixture(),who={...actor,[field]:'unapproved'};f.setCurrent(who);
  expect(await f.make().adopt(f.request(who))).toMatchObject({state:'unknown'});expect(f.state()).toEqual([]);
 });

 it('snapshots approved mappings and callbacks so caller mutation cannot add authority',async()=>{
  const f=fixture(),resources=[{...approved}],options:any={approvedResources:resources};
  const port=f.make(options);resources[0]!.storeId='other-store';resources.push({...approved,storeId:'other-store'});options.readActor=async()=>({...actor,storeId:'other-store'});
  expect(await port.adopt(f.request())).toMatchObject({state:'ready',workspaceJid:'web:original-role-1'});
  const before=f.state(),other={...actor,storeId:'other-store'};f.setCurrent(other);
  expect(await port.adopt(f.request(other))).toMatchObject({state:'unknown'});expect(f.state()).toEqual(before);
 });

 it('retains the validated resource key when the caller mutates its request during an authority read',async()=>{
  const f=fixture(),input=f.request();let reads=0;
  const port=f.make({readActor:async()=>{if(++reads===1)input.idempotencyKey='b'.repeat(64);return {...actor};}});
  expect(await port.adopt(input)).toMatchObject({state:'ready'});
  expect(f.native.getOwnedRoleWorkspaceClaim(key())).toMatchObject({state:'ready',resourceKey:key()});
  expect(f.native.getOwnedRoleWorkspaceClaim('b'.repeat(64))).toBeUndefined();
 });

 it('refuses to republish the same original Profile or workspace under another store claim',async()=>{
  const f=fixture();expect(await f.make().adopt(f.request())).toMatchObject({state:'ready'});
  const before=f.state(),other={...actor,storeId:'other-store'};f.setCurrent(other);
  const otherAdopter=f.make({approvedResources:[{...approved,storeId:'other-store'}]});
  expect(await otherAdopter.adopt(f.request(other))).toMatchObject({state:'unknown'});expect(f.state()).toEqual(before);
 });

 it.each([
  ["DELETE FROM registered_groups WHERE is_home=1"],
  ["INSERT INTO registered_groups VALUES ('web:second-home','second-home','original-member',1,'container')"],
  ["UPDATE registered_groups SET execution_mode='host' WHERE is_home=1"],
  ["UPDATE users SET status='disabled'"],
  ["UPDATE users SET must_change_password=1"],
  ["UPDATE users SET role='admin'"],
  ["UPDATE registered_groups SET created_by='other-owner' WHERE jid='web:original-role-1'"],
  ["UPDATE registered_groups SET is_home=1 WHERE jid='web:original-role-1'"],
  ["UPDATE registered_groups SET execution_mode='host' WHERE jid='web:original-role-1'"],
  ["UPDATE agent_profiles SET owner_user_id='other-owner' WHERE id='original-profile-1'"],
  ["UPDATE agent_profiles SET status='archived' WHERE id='original-profile-1'"],
  ["UPDATE workspace_agent_profiles SET agent_profile_id='original-profile-2' WHERE group_folder='original-folder-1'"],
 ])('rejects invalid current original resource state: %s',async sql=>{
  const f=fixture();f.sqlite.exec(sql);const before=f.snapshot();
  expect(await f.make().adopt(f.request())).toMatchObject({state:'unknown'});expect(f.state()).toEqual([]);expect(f.snapshot()).toEqual(before);
 });

 it.each(['pending','owner_busy','different-profile','different-store','different-corp','different-bot','different-member'])('preserves %s conflicts without recycling or overwrite',async kind=>{
  const f=fixture();
  const input=kind==='owner_busy'?{resourceKey:'a'.repeat(64),role:'other-role'}:kind==='different-store'?{storeId:'other-store'}:kind==='different-corp'?{corpId:'other-corp'}:kind==='different-bot'?{botId:'other-bot'}:kind==='different-member'?{memberId:'other-member'}:{};
  const pending=f.seed(input).claim;
  if(!['pending','owner_busy'].includes(kind))expect(f.native.resolveOwnedRoleWorkspace(pending,kind==='different-profile'?'original-profile-2':'original-profile-1','web:original-role-1')).toBe(true);
  const before=f.state();expect(await f.make().adopt(f.request())).toMatchObject({state:'unknown'});expect(f.state()).toEqual(before);
 });

 it.each(['paused','no-ticket','cancelled','expired','revoked','grant-changed','binding-changed'])('keeps the current gate and authority boundary: %s',async kind=>{
  const f=fixture(),port=f.make(),input=f.request();
  if(kind==='paused')f.pause();if(kind==='no-ticket')f.denyTicket();
  if(kind==='cancelled'){const abort=new AbortController();abort.abort();input.scope.signal=abort.signal;}
  if(kind==='expired')input.scope.deadline=performance.now()-1;
  if(kind==='revoked')f.setCurrent(undefined);
  if(kind==='grant-changed')f.setCurrent({...actor,grantVersion:3});
  if(kind==='binding-changed')f.setCurrent({...actor,bindingVersion:4});
  expect(await port.adopt(input)).toMatchObject({state:'unknown'});expect(f.state()).toEqual([]);
 });

 it('rechecks after asynchronous authority reads and inside the synchronous commit boundary',async()=>{
  const f=fixture();let reads=0;
  const port=f.make({readActor:async()=>{reads++;if(reads===2)f.setCurrent(undefined);return reads===2?undefined:{...actor};}});
  expect(await port.adopt(f.request())).toMatchObject({state:'unknown'});expect(f.state()).toEqual([]);
  const g=fixture(),input=g.request();input.withCurrent=async<T,>(work:()=>T)=>{g.sqlite.exec("UPDATE agent_profiles SET status='archived' WHERE id='original-profile-1'");return work();};
  expect(await g.make().adopt(input)).toMatchObject({state:'unknown'});expect(g.state()).toEqual([]);
 });

 it('rolls back both pending claim and owner guard if ready publication fails',async()=>{
  const f=fixture(),before=f.snapshot();
  const port=f.make({native:{...f.native,resolveOwnedRoleWorkspace:()=>false}});
  expect(await port.adopt(f.request())).toMatchObject({state:'unknown'});expect(f.state()).toEqual([]);expect(f.snapshot()).toEqual(before);
 });

 it('recovers the committed original claim after the commit response is lost',async()=>{
  const f=fixture(),input=f.request(),before=f.snapshot();
  input.withCurrent=async<T,>(work:()=>T)=>{work();throw Error('SYNTHETIC_RESPONSE_LOST');};
  expect(await f.make().adopt(input)).toMatchObject({state:'unknown'});
  const committed=f.state();expect(committed).toHaveLength(1);
  expect(await f.make().adopt(f.request())).toMatchObject({state:'ready',workspaceJid:'web:original-role-1',profileId:'original-profile-1'});
  expect(f.state()).toEqual(committed);expect(f.snapshot()).toEqual(before);
 });
});
