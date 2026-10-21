import ts from 'typescript';
import {createHash} from 'node:crypto';

function replace(source,start,end,value){return source.slice(0,start)+value+source.slice(end);}

/** Extract the unchanged owner business body behind a narrow, non-HTTP result. */
export function extractOwnedWorkspaceService(source){
 const parsed=ts.createSourceFile('groups.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const routes=[];
 function visit(node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)
    &&node.expression.expression.getText(parsed)==='groupRoutes'
    &&node.expression.name.text==='post'&&node.arguments[0]?.getText(parsed)==="'/'")routes.push(node);
  ts.forEachChild(node,visit);
 }visit(parsed);
 if(routes.length!==1)throw Error('ROLE_WORKSPACE_GROUP_ROUTE_CHANGED');
 const route=routes[0],callback=route.arguments[2];
 if(!callback||!ts.isArrowFunction(callback)||!callback.body||!ts.isBlock(callback.body))throw Error('ROLE_WORKSPACE_GROUP_HANDLER_CHANGED');
 let body=source.slice(callback.body.getStart(parsed)+1,callback.body.end-1);
 const request="  const body = await c.req.json().catch(() => ({}));";
 const auth="  const authUser = c.get('user') as AuthUser;";
 if(body.split(request).length!==2||body.split(auth).length!==2)throw Error('ROLE_WORKSPACE_GROUP_CONTEXT_CHANGED');
 body=body.replace(request,'').replace(auth,'').replaceAll('c.json(','ownedWorkspaceResult(');
 if(/\bc\./.test(body))throw Error('ROLE_WORKSPACE_GROUP_HTTP_DEPENDENCY_REMAINS');
 const bodyParsed=ts.createSourceFile('owned-workspace.ts',`async function f(){${body}}`,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const publish=[];
 function findPublish(node){if(ts.isTryStatement(node)&&node.getText(bodyParsed).includes('assignWorkspaceAgentProfile(')&&node.getText(bodyParsed).includes('setRegisteredGroup('))publish.push(node);ts.forEachChild(node,findPublish);}findPublish(bodyParsed);
 const innermost=publish.sort((a,b)=>(a.end-a.pos)-(b.end-b.pos))[0];
 if(!innermost||publish.length<1)throw Error('ROLE_WORKSPACE_PUBLICATION_CHANGED');
 const offset='async function f(){'.length,from=innermost.getStart(bodyParsed)-offset,to=innermost.end-offset;
 body=replace(body,from,to,`return await commitCurrent(() => {${body.slice(from,to)}});`);
 const publishAnchor='            deps.getRegisteredGroups()[jid] = group;\n            return lockedProfile;';
 if(body.split(publishAnchor).length!==2)throw Error('ROLE_WORKSPACE_PUBLISH_ANCHOR_CHANGED');
 body=body.replace(publishAnchor,"            deps.getRegisteredGroups()[jid] = group;\n            if (publishClaim && !publishClaim(jid, lockedProfile.id)) throw Error('ROLE_WORKSPACE_CLAIM_CHANGED');\n            return lockedProfile;");
 const lock='withAgentProfileLocks([agentProfile.id], () => {';
 if(body.split(lock).length!==2)throw Error('ROLE_WORKSPACE_PROFILE_LOCK_CHANGED');
 body=body.replace(lock,'withAgentProfileLocks([agentProfile.id], async () => {');
 const service=`\nfunction ownedWorkspaceResult(body: unknown, status = 200) { return {body, status}; }\nexport async function createOwnedRoleWorkspace(authUser: AuthUser, body: unknown, commitCurrent: <T>(work:()=>T)=>Promise<T> = async work=>work(), publishClaim?: (jid:string,profileId:string)=>boolean) {${body}\n}\n`;
 const facade=`async (c) => {\n  const authUser = c.get('user') as AuthUser;\n  const body = await c.req.json().catch(() => ({}));\n  const result = await createOwnedRoleWorkspace(authUser, body);\n  return c.json(result.body, result.status as any);\n}`;
 return replace(source,callback.getStart(parsed),callback.end,facade)+service;
}

export function extractOwnedProfileService(source){
 const parsed=ts.createSourceFile('agent-profiles.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const routes=[];
 function visit(node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)
    &&node.expression.expression.getText(parsed)==='agentProfileRoutes'
    &&node.expression.name.text==='post'&&node.arguments[0]?.getText(parsed)==="'/'")routes.push(node);
  ts.forEachChild(node,visit);
 }visit(parsed);
 if(routes.length!==1)throw Error('ROLE_PROFILE_ROUTE_CHANGED');
 const route=routes[0],callback=route.arguments[2];
 if(!callback||!ts.isArrowFunction(callback)||!callback.body||!ts.isBlock(callback.body))throw Error('ROLE_PROFILE_HANDLER_CHANGED');
 let body=source.slice(callback.body.getStart(parsed)+1,callback.body.end-1);
 const request="  const body = await c.req.json().catch(() => ({}));";
 const auth="  const user = c.get('user') as AuthUser;";
 if(body.split(request).length!==2||body.split(auth).length!==2)throw Error('ROLE_PROFILE_CONTEXT_CHANGED');
 body=body.replace(request,'').replace(auth,'').replaceAll('c.json(','ownedProfileResult(');
 if(/\bc\./.test(body))throw Error('ROLE_PROFILE_HTTP_DEPENDENCY_REMAINS');
 const bodyParsed=ts.createSourceFile('owned-profile.ts',`async function f(){${body}}`,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const callbacks=[];
 function findPolicy(node){if(ts.isCallExpression(node)&&node.expression.getText(bodyParsed)==='withCapabilityScopeLocks'&&node.getText(bodyParsed).includes('createAgentProfile('))callbacks.push(node.arguments[1]);ts.forEachChild(node,findPolicy);}findPolicy(bodyParsed);
 if(callbacks.length!==1||!callbacks[0]||!ts.isArrowFunction(callbacks[0]))throw Error('ROLE_PROFILE_POLICY_LOCK_CHANGED');
 const policy=callbacks[0],offset='async function f(){'.length,from=policy.getStart(bodyParsed)-offset,to=policy.end-offset;
 body=replace(body,from,to,`async () => commitCurrent(() => ${body.slice(from,to).replace(/^\(\) => /,'')})`);
 const service=`\nfunction ownedProfileResult(body: unknown, status = 200) { return {body, status}; }\nexport async function createOwnedRoleProfile(user: AuthUser, body: unknown, commitCurrent: <T>(work:()=>T)=>Promise<T> = async work=>work()) {${body}\n}\n`;
 const facade=`async (c) => {\n  const user = c.get('user') as AuthUser;\n  const body = await c.req.json().catch(() => ({}));\n  const result = await createOwnedRoleProfile(user, body);\n  return c.json(result.body, result.status as any);\n}`;
 return replace(source,callback.getStart(parsed),callback.end,facade)+service;
}

/** Same Native connection and router_state schema; an unresolved claim is never recycled. */
export function addOwnedWorkspaceClaims(source){
 if(!source.includes('export function getRouterState(key: string)'))throw Error('ROLE_WORKSPACE_ROUTER_STATE_CHANGED');
 return source+`
export interface OwnedRoleWorkspaceClaim {
  tenantId: string; ownerId: string; storeId: string; role: string; resourceKey: string;
  state: 'pending' | 'ready'; token: string; profileId?: string; workspaceJid?: string;
  corpId: string; botId: string; memberId: string; bindingVersion: number; grantVersion: number;
}

export function withOwnedRoleWorkspaceTransaction<T>(work:()=>T):T { return db.transaction(work)(); }
const roleWorkspacePrefix = 'wecom-role-workspace:v1:';
const roleOwnerPrefix = 'wecom-role-owner-claim:v1:';
const roleOwnerKey = (ownerId: string) => roleOwnerPrefix + crypto.createHash('sha256').update(ownerId).digest('hex');
export function getOwnedRoleWorkspaceClaim(resourceKey: string): OwnedRoleWorkspaceClaim | undefined {
  if (!/^[a-f0-9]{64}$/.test(resourceKey)) throw Error('invalid_role_resource_key');
  const raw = getRouterState(roleWorkspacePrefix + resourceKey);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as OwnedRoleWorkspaceClaim; }
  catch { throw Error('invalid_role_workspace_claim'); }
}
export function getOwnedRoleWorkspaceClaimsForOwner(ownerId: string): OwnedRoleWorkspaceClaim[] {
  return db.prepare('SELECT value FROM router_state WHERE key LIKE ?').all(roleWorkspacePrefix + '%')
    .map((row: {value: string}) => { try { return JSON.parse(row.value) as OwnedRoleWorkspaceClaim; }
      catch { throw Error('invalid_role_workspace_claim'); } })
    .filter((claim: OwnedRoleWorkspaceClaim) => claim.ownerId === ownerId);
}
export function claimOwnedRoleWorkspace(input: Omit<OwnedRoleWorkspaceClaim,'state'|'token'|'profileId'|'workspaceJid'>):
  {state:'claimed';claim:OwnedRoleWorkspaceClaim}|{state:'existing'|'owner_busy';claim?:OwnedRoleWorkspaceClaim} {
  if (!/^[a-f0-9]{64}$/.test(input.resourceKey) || !input.ownerId || !input.tenantId || !input.storeId || !input.role)
    throw Error('invalid_role_workspace_claim');
  return db.transaction(() => {
    const existing = getOwnedRoleWorkspaceClaim(input.resourceKey);
    if (existing) return {state:'existing' as const,claim:existing};
    const ownerKey = roleOwnerKey(input.ownerId);
    const owner = db.prepare('INSERT OR IGNORE INTO router_state (key, value) VALUES (?, ?)').run(ownerKey,input.resourceKey);
    if (owner.changes !== 1) return {state:'owner_busy' as const};
    const claim: OwnedRoleWorkspaceClaim = {...input,state:'pending',token:crypto.randomUUID()};
    const inserted = db.prepare('INSERT OR IGNORE INTO router_state (key, value) VALUES (?, ?)')
      .run(roleWorkspacePrefix + input.resourceKey,JSON.stringify(claim));
    if (inserted.changes !== 1) {
      db.prepare('DELETE FROM router_state WHERE key = ? AND value = ?').run(ownerKey,input.resourceKey);
      return {state:'existing' as const,claim:getOwnedRoleWorkspaceClaim(input.resourceKey)};
    }
    return {state:'claimed' as const,claim};
  })();
}
export function resolveOwnedRoleWorkspace(pending: OwnedRoleWorkspaceClaim, profileId: string, workspaceJid: string): boolean {
  if (pending.state !== 'pending' || !profileId || !/^web:(?!home(?:-|:|$))[^\\s#]{1,196}$/.test(workspaceJid)) return false;
  return db.transaction(() => {
    const key = roleWorkspacePrefix + pending.resourceKey;
    const resolved: OwnedRoleWorkspaceClaim = {...pending,state:'ready',profileId,workspaceJid};
    const changed = db.prepare('UPDATE router_state SET value = ? WHERE key = ? AND value = ?')
      .run(JSON.stringify(resolved),key,JSON.stringify(pending));
    if (changed.changes !== 1) return false;
    db.prepare('DELETE FROM router_state WHERE key = ? AND value = ?').run(roleOwnerKey(pending.ownerId),pending.resourceKey);
    return true;
  })();
}
`;
}

/** Bind only original Native owner services and the current appointment gate. */
export function createRoleWorkspaceNativePort({mode,gate,native,templates,prepareOwnProfiles,journalDirectory,readActor}){
 if(mode!=='isolated-synthetic'||!gate||!native||!Array.isArray(templates)||typeof prepareOwnProfiles!=='function'||!journalDirectory||typeof readActor!=='function')throw Error('ROLE_WORKSPACE_BINDING_INCOMPLETE');
 const source=Object.freeze({...native}),policy=Object.freeze({...gate});
 const catalog=structuredClone(templates);
 if(new Set(catalog.map(item=>item.key)).size!==catalog.length)throw Error('ROLE_WORKSPACE_TEMPLATE_CONFLICT');
 const unknown={state:'unknown',detail:'role_workspace_unverifiable'};
 const within=scope=>!scope.signal.aborted&&Number.isFinite(scope.deadline)&&performance.now()<scope.deadline;
 const frozen=input=>{
  const actor=Object.freeze({...input.actor});
  const expected=createHash('sha256').update(JSON.stringify([actor.tenantId,actor.accountId,actor.storeId,actor.role])).digest('hex');
  if(input.idempotencyKey!==expected||!actor.accountId||!actor.tenantId||!actor.storeId||!actor.role)throw Error('ROLE_WORKSPACE_IDENTITY_INVALID');
  return actor;
 };
 const trusted=async(actor,scope)=>{
  const current=structuredClone(await readActor(scope));
  for(const field of ['tenantId','accountId','storeId','role','grantVersion','corpId','botId','memberId','bindingVersion'])if(current?.[field]!==actor[field])throw Error('ROLE_WORKSPACE_ACTOR_CHANGED');
  if(!within(scope))throw Error('ROLE_WORKSPACE_BUDGET_EXPIRED');
 };
 const owner=actor=>{
  const row=source.getUserById(actor.accountId);
  if(!row||row.id!==actor.accountId||row.role!=='member'||row.status!=='active'||row.must_change_password!==false)throw Error('ROLE_WORKSPACE_OWNER_INVALID');
  return {id:row.id,username:row.username,role:row.role,status:row.status,display_name:row.display_name,permissions:row.permissions,must_change_password:row.must_change_password};
 };
 const binding=(actor,claim)=>{
  if(!claim||claim.tenantId!==actor.tenantId||claim.ownerId!==actor.accountId||claim.storeId!==actor.storeId||claim.role!==actor.role||claim.resourceKey!==createHash('sha256').update(JSON.stringify([actor.tenantId,actor.accountId,actor.storeId,actor.role])).digest('hex'))throw Error('ROLE_WORKSPACE_PROVENANCE_INVALID');
  if(claim.corpId!==actor.corpId||claim.botId!==actor.botId||claim.memberId!==actor.memberId)throw Error('ROLE_WORKSPACE_BINDING_CHANGED');
  return claim;
 };
 async function read(input){
  try{
   const actor=frozen(input);if(!within(input.scope))return unknown;
   await input.assertCurrent();await trusted(actor,input.scope);if(!within(input.scope))return unknown;owner(actor);
   const claim=binding(actor,source.getOwnedRoleWorkspaceClaim(input.idempotencyKey));
   if(claim.state!=='ready')return unknown;
   if(typeof claim.workspaceJid!=='string'||!/^web:(?!home(?:-|:|$))[^\s#]{1,196}$/.test(claim.workspaceJid)||!claim.profileId)return unknown;
   const group=source.getRegisteredGroup(claim.workspaceJid),profile=source.getAgentProfileForUser(claim.profileId,actor.accountId);
   if(!group||group.created_by!==actor.accountId||group.is_home||group.executionMode!=='container'||!group.folder||!profile||profile.owner_user_id!==actor.accountId||profile.status==='archived'||source.getWorkspaceAgentProfileId(group.folder)!==claim.profileId)return unknown;
   await input.assertCurrent();await trusted(actor,input.scope);if(!within(input.scope))return unknown;owner(actor);
   return {state:'ready',workspaceJid:claim.workspaceJid,profileId:claim.profileId,ownerAccountId:actor.accountId,storeId:actor.storeId,role:actor.role};
  }catch(error){if(error instanceof Error&&error.message==='ROLE_WORKSPACE_PROVENANCE_INVALID')return {state:'missing',detail:'role_workspace_missing'};return unknown;}
 }
 async function prepare(input){
  if(policy.isPaused())return unknown;
  const ticket=policy.beginWrite();if(!ticket)return unknown;
  try{
   const actor=frozen(input),template=catalog.find(item=>item.key===actor.role);
   if(!template||!within(input.scope))return unknown;
   const prior=await read(input);if(prior.state==='ready'||prior.state==='unknown')return prior;
   // The original group schema has no store provenance. A pre-existing non-Home
   // workspace without our claim cannot be assigned to a new store by name.
   const existingGroups=source.getGroupsByOwner(actor.accountId),ownedClaims=source.getOwnedRoleWorkspaceClaimsForOwner(actor.accountId);
   if(!Array.isArray(existingGroups)||!Array.isArray(ownedClaims))return unknown;
   const boundJids=new Set(ownedClaims.filter(claim=>claim.state==='ready').map(claim=>claim.workspaceJid));
   if(existingGroups.some(group=>!group.is_home&&!boundJids.has(group.jid)))return unknown;
   if(template.skills?.length){
    if(typeof source.listAvailableSkills!=='function')return unknown;
    await input.assertCurrent();await trusted(actor,input.scope);
    const available=await source.listAvailableSkills(actor.accountId);
    if(!Array.isArray(available)||template.skills.some(skill=>!available.includes(skill)))return unknown;
   }
   await input.assertCurrent();await trusted(actor,input.scope);if(!within(input.scope)||policy.isPaused())return unknown;
   const claimed=await input.withCurrent(()=>{
    if(!within(input.scope)||policy.isPaused())throw Error('ROLE_WORKSPACE_BUDGET_EXPIRED');
    owner(actor);
    return source.claimOwnedRoleWorkspace({tenantId:actor.tenantId,ownerId:actor.accountId,storeId:actor.storeId,role:actor.role,resourceKey:input.idempotencyKey,corpId:actor.corpId,botId:actor.botId,memberId:actor.memberId,bindingVersion:actor.bindingVersion,grantVersion:actor.grantVersion});
   });
   if(claimed.state!=='claimed')return unknown;
   const assert=async()=>{if(!within(input.scope)||policy.isPaused())throw Error('ROLE_WORKSPACE_BUDGET_EXPIRED');await input.assertCurrent();await trusted(actor,input.scope);owner(actor);};
   const installed=await prepareOwnProfiles({definitions:[template],accountId:actor.accountId,tenantId:actor.tenantId,journalDirectory,port:{
    list:async()=>{await assert();return input.withCurrent(()=>{if(!within(input.scope)||policy.isPaused())throw Error('ROLE_WORKSPACE_BUDGET_EXPIRED');owner(actor);return source.listAgentProfilesForUser(actor.accountId);});},
    beforeCreate:assert,
    create:async payload=>{await assert();const result=await source.createOwnedRoleProfile(owner(actor),payload,work=>input.withCurrent(()=>{if(!within(input.scope)||policy.isPaused())throw Error('ROLE_WORKSPACE_BUDGET_EXPIRED');owner(actor);return work();}));if(result.status!==201||!result.body?.profile)throw Error('ROLE_PROFILE_CREATE_UNKNOWN');return result.body.profile;},
   },assertCurrent:assert});
   const profileId=installed.find(item=>item.key===actor.role)?.id;if(!profileId)return unknown;
   await assert();
   const body={name:`岗位空间-${actor.role}-${input.idempotencyKey.slice(0,12)}`,agent_profile_id:profileId,execution_mode:'container',interaction_mode:'assistant'};
   const result=await source.createOwnedRoleWorkspace(owner(actor),body,work=>input.withCurrent(()=>{if(!within(input.scope)||policy.isPaused())throw Error('ROLE_WORKSPACE_BUDGET_EXPIRED');owner(actor);return source.withOwnedRoleWorkspaceTransaction(work);}), (jid,profileId)=>source.resolveOwnedRoleWorkspace(claimed.claim,profileId,jid));
   if(result.status!==200||result.body?.success!==true||typeof result.body.jid!=='string')return unknown;
   const group=source.getRegisteredGroup(result.body.jid);
   if(!group||group.created_by!==actor.accountId||group.is_home||group.executionMode!=='container'||source.getWorkspaceAgentProfileId(group.folder)!==profileId)return unknown;
   await assert();
   return await read(input);
  }catch{return unknown;}finally{policy.finishWrite(ticket);}
 }
 return Object.freeze({readRoleWorkspace:read,prepareRoleWorkspace:prepare});
}
