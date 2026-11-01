import {describe,expect,it} from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {createFullHostCandidate} from './full-host-candidate.mjs';
import {createRoleWorkspaceNativePort} from './role-workspace-overlay.mjs';

const nativeRoot=process.env.QIWE_NATIVE_ROOT;
const overlayRoot=process.env.QIWE_OVERLAY_ROOT;
if(!nativeRoot||!overlayRoot||!path.isAbsolute(nativeRoot)||!path.isAbsolute(overlayRoot))throw Error('ROLE_SOURCE_ROOTS_REQUIRED');

describe('D1 original owner resource service extraction',()=>{
 it('keeps the original group policy, locked publication and route on one callable service',async()=>{
  const candidate=await createFullHostCandidate(nativeRoot,overlayRoot);
  const source=candidate.files.get('routes/groups.ts')!;
  const parsed=ts.createSourceFile('groups.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  expect(parsed.parseDiagnostics).toEqual([]);
  expect(source).toContain('export async function createOwnedRoleWorkspace');
  expect(source).toContain('await createOwnedRoleWorkspace(authUser, body)');
  const service=source.slice(source.indexOf('export async function createOwnedRoleWorkspace'));
  expect(service).toContain('checkGroupLimit(authUser.id, authUser.role)');
  expect(service).toContain('withCapabilityScopeLocks(');
  expect(service).toContain('withAgentProfileLocks(');
  expect(service).toContain('assignWorkspaceAgentProfile(');
  expect(service).toContain('setRegisteredGroup(');
  expect(service).toContain('return await commitCurrent(() => {');
  expect(service).toContain('publishClaim(jid, lockedProfile.id)');
  expect(service).not.toContain("c.get('user')");
  expect(service).not.toContain('c.req.json()');
 });
 it('keeps the original profile policy and capability locks in a shared owner service',async()=>{
  const candidate=await createFullHostCandidate(nativeRoot,overlayRoot);
  const source=candidate.files.get('routes/agent-profiles.ts')!;
  expect(source).toContain('export async function createOwnedRoleProfile');
  expect(source).toContain('await createOwnedRoleProfile(user, body)');
  const service=source.slice(source.indexOf('export async function createOwnedRoleProfile'));
  expect(service).toContain('AgentProfileCreateSchema.safeParse(body)');
  expect(service).toContain('userCapabilityLockKey(user.id)');
  expect(service).toContain('validateRuntimePolicyReferences(');
  expect(service).toContain('createAgentProfile({');
  expect(service).toContain('async () => commitCurrent(() => {');
  expect(service).not.toContain("c.get('user')");
  expect(service).not.toContain('c.req.json()');
 });
 it('claims one owner creation in original SQLite router state and preserves pending after uncertainty',async()=>{
  const candidate=await createFullHostCandidate(nativeRoot,overlayRoot);
  const source=candidate.files.get('db.ts')!;
  expect(source).toContain('export function claimOwnedRoleWorkspace(');
  expect(source).toContain('INSERT OR IGNORE INTO router_state');
  expect(source).toContain('export function resolveOwnedRoleWorkspace(');
  expect(source).toContain('WHERE key = ? AND value = ?');
  expect(source).toContain('wecom-role-workspace:v1:');
  expect(source).toContain('export function withOwnedRoleWorkspaceTransaction');
 });
 it('a real SQLite file keeps one pending claim across connections and resolves only its token',async()=>{
  const candidate=await createFullHostCandidate(nativeRoot,overlayRoot);
  const source=candidate.files.get('db.ts')!;
  const suffix=source.slice(source.indexOf('export interface OwnedRoleWorkspaceClaim'));
  const compiled=ts.transpileModule(suffix.replace(/\bexport\s+/g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const driver=process.env.QIWE_SQLITE_DRIVER;
  if(!driver||!path.isAbsolute(driver))throw Error('QIWE_SQLITE_DRIVER_REQUIRED');
  expect(fs.existsSync(path.join(driver,'build/Release/better_sqlite3.node'))).toBe(true);
  const Database=createRequire(import.meta.url)(driver) as any;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-role-claim-'));
  let first:any,second:any;
  try{
   first=new Database(path.join(root,'claim.sqlite'));first.exec('CREATE TABLE router_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
   second=new Database(path.join(root,'claim.sqlite'));
   const api=(db:any)=>new Function('db','crypto','getRouterState',compiled+';return {claimOwnedRoleWorkspace,resolveOwnedRoleWorkspace,getOwnedRoleWorkspaceClaim,withOwnedRoleWorkspaceTransaction};')(db,crypto,(key:string)=>db.prepare('SELECT value FROM router_state WHERE key = ?').get(key)?.value);
   const a=api(first),b=api(second),resourceKey=crypto.createHash('sha256').update('role-one').digest('hex');
   const input={tenantId:'tenant',ownerId:'owner',storeId:'store-one',role:'marketing',resourceKey,corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1,grantVersion:1};
   const claimed=a.claimOwnedRoleWorkspace(input);
   expect(claimed.state).toBe('claimed');
   expect(b.claimOwnedRoleWorkspace(input).state).toBe('existing');
   const other={...input,storeId:'store-two',resourceKey:crypto.createHash('sha256').update('role-two').digest('hex')};
   expect(b.claimOwnedRoleWorkspace(other).state).toBe('owner_busy');
   expect(b.resolveOwnedRoleWorkspace({...claimed.claim,token:'forged'},'profile','web:workspace')).toBe(false);
   expect(b.getOwnedRoleWorkspaceClaim(resourceKey).state).toBe('pending');
   expect(a.resolveOwnedRoleWorkspace(claimed.claim,'profile','web:workspace')).toBe(true);
   expect(b.getOwnedRoleWorkspaceClaim(resourceKey)).toMatchObject({state:'ready',storeId:'store-one',profileId:'profile',workspaceJid:'web:workspace'});
   expect(b.claimOwnedRoleWorkspace(other).state).toBe('claimed');
   first.close();first=undefined;second.close();second=undefined;
   const reopened=new Database(path.join(root,'claim.sqlite'));
   try{expect(api(reopened).getOwnedRoleWorkspaceClaim(other.resourceKey).state).toBe('pending');}
   finally{reopened.close();}
  }finally{first?.close();second?.close();const resolved=fs.realpathSync(root);expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));expect(path.basename(resolved)).toMatch(/^qiwe-role-claim-/);fs.rmSync(resolved,{recursive:true,force:true});}
 });
 it('publication and ready claim commit together before a lost response',async()=>{
  const candidate=await createFullHostCandidate(nativeRoot,overlayRoot),source=candidate.files.get('db.ts')!;
  const suffix=source.slice(source.indexOf('export interface OwnedRoleWorkspaceClaim'));
  const compiled=ts.transpileModule(suffix.replace(/\bexport\s+/g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const driver=process.env.QIWE_SQLITE_DRIVER;if(!driver||!path.isAbsolute(driver))throw Error('QIWE_SQLITE_DRIVER_REQUIRED');
  const Database=createRequire(import.meta.url)(driver) as any,root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-role-publish-'));
  let db:any;
  try{
   db=new Database(path.join(root,'claim.sqlite'));
   db.exec('CREATE TABLE router_state (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE published (jid TEXT PRIMARY KEY, owner TEXT NOT NULL)');
   const api=new Function('db','crypto','getRouterState',compiled+';return {claimOwnedRoleWorkspace,resolveOwnedRoleWorkspace,getOwnedRoleWorkspaceClaim,withOwnedRoleWorkspaceTransaction};')(db,crypto,(key:string)=>db.prepare('SELECT value FROM router_state WHERE key = ?').get(key)?.value);
   const resourceKey=crypto.createHash('sha256').update('one').digest('hex');
   const input={tenantId:'tenant',ownerId:'owner',storeId:'store',role:'marketing',resourceKey,corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1,grantVersion:1};
   const claim=api.claimOwnedRoleWorkspace(input).claim;
   expect(()=>api.withOwnedRoleWorkspaceTransaction(()=>{db.prepare('INSERT INTO published VALUES (?,?)').run('web:one','owner');if(!api.resolveOwnedRoleWorkspace({...claim,token:'wrong'},'profile','web:one'))throw Error('claim_changed');})).toThrow('claim_changed');
   expect(db.prepare('SELECT COUNT(*) AS n FROM published').get().n).toBe(0);
   api.withOwnedRoleWorkspaceTransaction(()=>{db.prepare('INSERT INTO published VALUES (?,?)').run('web:one','owner');expect(api.resolveOwnedRoleWorkspace(claim,'profile','web:one')).toBe(true);});
   db.close();db=undefined;
   const reopened=new Database(path.join(root,'claim.sqlite'));
   try{expect(reopened.prepare('SELECT COUNT(*) AS n FROM published').get().n).toBe(1);expect(new Function('db','crypto','getRouterState',compiled+';return getOwnedRoleWorkspaceClaim;')(reopened,crypto,(key:string)=>reopened.prepare('SELECT value FROM router_state WHERE key = ?').get(key)?.value)(resourceKey)).toMatchObject({state:'ready',workspaceJid:'web:one'});}
   finally{reopened.close();}
  }finally{db?.close();const resolved=fs.realpathSync(root);expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));expect(path.basename(resolved)).toMatch(/^qiwe-role-publish-/);fs.rmSync(resolved,{recursive:true,force:true});}
 });
 it('appointment pause fences preparation before any Native read or claim',async()=>{
  const calls:string[]=[];
  const native:any={getUserById:()=>{calls.push('owner');return null;},getOwnedRoleWorkspaceClaim:()=>{calls.push('claim');return null;}};
  const gate:any={isPaused:()=>true,beginWrite:()=>{calls.push('ticket');return null;},finishWrite:()=>{calls.push('finish');}};
  const port=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate,native,templates:[],prepareOwnProfiles:async()=>[],journalDirectory:'synthetic',readActor:async()=>{calls.push('actor');return {};}});
  const actor:any={tenantId:'tenant',accountId:'owner',storeId:'store',role:'marketing',grantVersion:1,corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1};
  const input:any={actor,scope:{signal:new AbortController().signal,deadline:performance.now()+1000},idempotencyKey:crypto.createHash('sha256').update(JSON.stringify(['tenant','owner','store','marketing'])).digest('hex'),assertCurrent:async()=>{},withCurrent:async(work:()=>unknown)=>work()};
  expect(await port.prepareRoleWorkspace(input)).toMatchObject({state:'unknown'});
  expect(calls).toEqual([]);
 });
});
