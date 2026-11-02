import {resolveWorkbenchAuthority} from './workbench-authority.js';
import {createHash} from 'node:crypto';import path from 'node:path';
import {WORKBENCH_ROLES,type WorkbenchAccessStore,type WorkbenchGrant,type WorkbenchRole,type GrantChange} from './workbench-access.js';
import {installProfiles,type ProfilePort} from './install.js';
import {FileCreationJournal} from './file-journal.js';import {parseOwnWorkspace} from './workspace-access.js';
export interface WorkbenchTemplate {key:WorkbenchRole;name:string;skills:string[];payload:Record<string,unknown>&{name:string};}
export interface WorkbenchIdentity {accountId:string;workspaceJid:string;tenantId:string;storeId:string;grantVersion:number;}
export interface WorkbenchAccessContext {identity:WorkbenchIdentity;grant:WorkbenchGrant;}
export interface WorkbenchOpeningOptions {
 origin:string;tenantId:string;stores:{id:string;name:string}[];templates:WorkbenchTemplate[];store:WorkbenchAccessStore;journalDirectory:string;
 native:{authenticate(cookie:string):Promise<unknown>;employees(cookie:string):Promise<unknown[]>;groups(cookie:string):Promise<unknown>;profiles(cookie:string):ProfilePort;skills(cookie:string):Promise<string[]>;};
}
/** Reuse the original profile reconciliation under the trusted owner's live authority. */
export async function prepareOwnProfiles(input:{definitions:WorkbenchTemplate[];accountId:string;tenantId:string;journalDirectory:string;port:ProfilePort;assertCurrent:()=>Promise<void>}){
 const journal=new FileCreationJournal(path.join(input.journalDirectory,createHash('sha256').update(JSON.stringify([input.tenantId,input.accountId])).digest('hex')));
 const installed=await installProfiles({list:async()=>{await input.assertCurrent();return input.port.list();},beforeCreate:input.assertCurrent,create:payload=>input.port.create(payload)},input.definitions,input.accountId,journal);
 await input.assertCurrent();return installed;
}
export function createWorkbenchOpening(options:WorkbenchOpeningOptions){return createOpening(options,'synthetic');}
/** Local operator opening only; existing employee roles must be imported, never reinstalled here. */
export function createLocalPilotWorkbenchOpening(options:WorkbenchOpeningOptions&{accountId:string}){
 const origin=new URL(options.origin),accountId=options.accountId;
 if(!['http:','https:'].includes(origin.protocol)||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||typeof accountId!=='string'||!accountId||accountId.length>120||/\s/.test(accountId)||options.stores.length!==1||options.templates.length!==1)throw Error('invalid_local_opening');
 const source=options.native,authenticate=source.authenticate.bind(source),employees=source.employees.bind(source),groups=source.groups.bind(source),profiles=source.profiles.bind(source),skills=source.skills.bind(source);
 return createOpening({...options,stores:structuredClone(options.stores),templates:structuredClone(options.templates),native:{authenticate,groups,profiles,skills,employees:async cookie=>(await employees(cookie)).filter(u=>!!u&&typeof u==='object'&&Reflect.get(u,'id')===accountId)}},'controlled-real-pilot',accountId);
}
function createOpening(options:WorkbenchOpeningOptions,mode:'synthetic'|'controlled-real-pilot',accountId?:string){
 const origin=new URL(options.origin),record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 if(mode==='synthetic'&&origin.protocol!=='https:'||!options.tenantId||!options.stores.length||new Set(options.stores.map(s=>s.id)).size!==options.stores.length||options.templates.some(t=>!WORKBENCH_ROLES.includes(t.key))||new Set(options.templates.map(t=>t.key)).size!==options.templates.length)throw Error('invalid_opening_catalog');
 options.store.bindTenant(options.tenantId);
 async function activeUser(cookie:string){const value=await options.native.authenticate(cookie);if(!record(value))throw Error('access_denied');const u={id:value.id,role:value.role,status:value.status,must_change_password:value.must_change_password};if(typeof u.id!=='string'||!u.id||!['admin','member'].includes(String(u.role))||u.status!=='active'||u.must_change_password!==false)throw Error('access_denied');return u as typeof u&{id:string};}
 async function authorize(cookie:string):Promise<WorkbenchAccessContext>{
  const user=await activeUser(cookie),grant=options.store.get(user.id);
  if(accountId!==undefined&&user.id!==accountId)throw Error('access_denied');
  if(!grant?.active||!options.stores.some(s=>s.id===grant.storeId)||grant.roles.some(r=>!options.templates.some(t=>t.key===r)))throw Error('access_not_open');
  const home=parseOwnWorkspace(await options.native.groups(cookie));if(!home)throw Error('access_home_unavailable');
  const currentUser=await activeUser(cookie),currentGrant=options.store.get(user.id);
  if(currentUser.id!==user.id||!currentGrant?.active||currentGrant.version!==grant.version)throw Error('access_changed');
  return resolveWorkbenchAuthority({...options,roles:options.templates.map(t=>t.key)},currentUser,home);
 }
 async function assertCurrent(cookie:string,context:WorkbenchAccessContext){const now=await authorize(cookie);if(JSON.stringify(now.identity)!==JSON.stringify(context.identity))throw Error('access_changed');}
 const handle=async(request:Request):Promise<Response>=>{
  const url=new URL(request.url),json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(url.host!==origin.host||mode==='controlled-real-pilot'&&url.origin!==origin.origin)return json({error:'invalid_host'},400);
  if(!['GET','POST'].includes(request.method))return json({error:'method_denied'},405);
  if(request.method==='POST'&&request.headers.get('origin')!==origin.origin)return json({error:'invalid_origin'},403);
  const route=url.pathname.replace('/api/local-product/access','');if(!['','/self','/prepare'].includes(route))return json({error:'not_found'},404);
  const cookie=request.headers.get('cookie');if(!cookie)return json({error:'unauthorized'},401);
  try{
   const user=await activeUser(cookie);
   if(mode==='controlled-real-pilot'&&route==='/prepare')return json({error:'role_import_required',message:'本地试点复用已核实的原岗位，请由管理员完成原岗位接纳；不会重新安装。'},403);
   if(route===''){
    // Business opening is deliberately limited to administrators. Native manage_users
    // alone still manages accounts, but does not implicitly grant every store.
    if(user.role!=='admin')throw Error('access_denied');
    const employees=(await options.native.employees(cookie)).filter(record).filter(u=>typeof u.id==='string'&&u.role==='member').map(u=>({id:u.id as string,name:typeof u.display_name==='string'&&u.display_name?u.display_name:String(u.username??u.id),status:u.status}));
    if(request.method==='GET'){const current=await activeUser(cookie);if(current.id!==user.id||current.role!=='admin')throw Error('access_changed');return json({users:employees,stores:options.stores,roles:options.templates.map(({key,name})=>({key,name})),grants:options.store.list().filter(g=>employees.some(u=>u.id===g.accountId)),mode,modelCalls:0});}
    const text=await request.text();if(Buffer.byteLength(text)>10000)return json({error:'body_too_large'},413);let body:unknown;try{body=JSON.parse(text);}catch{throw Error('invalid_grant');}
    if(!record(body)||!employees.some(u=>u.id===body.accountId&&(body.active===false||u.status==='active'))||!options.stores.some(s=>s.id===body.storeId)||!Array.isArray(body.roles)||body.roles.some(r=>!options.templates.some(t=>t.key===r)))throw Error('access_denied');
    // Re-read target status after request-body I/O, before committing a grant.
    const targets=await options.native.employees(cookie);if(!targets.some(u=>record(u)&&u.id===body.accountId&&u.role==='member'&&(body.active===false||u.status==='active')))throw Error('access_denied');
    const current=await activeUser(cookie);if(current.id!==user.id||current.role!=='admin')throw Error('access_changed');
    const result=options.store.change(user.id,body as unknown as GrantChange);return json({grant:result,currentGrant:options.store.get(result.accountId),modelCalls:0});
   }
   const context=await authorize(cookie);
   if(route==='/self'&&request.method==='GET')return json({...context,mode,modelCalls:0});
   if(route!=='/prepare'||request.method!=='POST')return json({error:'method_denied'},405);
   const text=await request.text();if(Buffer.byteLength(text)>1000)return json({error:'body_too_large'},413);if(text.trim()!=='{}')throw Error('invalid_grant');
   const definitions=options.templates.filter(t=>context.grant.roles.includes(t.key)),available=await options.native.skills(cookie);
   if(definitions.some(t=>t.skills.some(s=>!available.includes(s))))throw Error('role_resources_unavailable');
   const installed=await prepareOwnProfiles({definitions,accountId:context.identity.accountId,tenantId:options.tenantId,journalDirectory:options.journalDirectory,port:options.native.profiles(cookie),assertCurrent:()=>assertCurrent(cookie,context)});
   return json({identity:context.identity,roles:installed.map(p=>{const t=definitions.find(t=>t.key===p.key)!;return {id:p.id,key:t.key,name:t.name,skills:t.skills};}),mode,modelCalls:0});
  }catch(error){const code=error instanceof Error?error.message:'unknown';
   const status=['access_denied','access_not_open','access_changed'].includes(code)?403:code==='invalid_grant'?400:['grant_version_conflict','grant_request_conflict','role_resources_unavailable'].includes(code)?409:503;
   const message=code==='access_not_open'?'尚未开通岗位，请联系管理员选择员工、门店和岗位。':code==='role_resources_unavailable'?'岗位公共资料尚未就绪，请由管理员处理；无需员工自行装配。':code.startsWith('profile_')?'岗位准备结果暂时无法核实，请保留原状态并联系管理员；不会重复新建。':status===409?'授权已变化或请求冲突，请刷新后核对。':status===403?'当前授权或账号状态已变化，请重新读取。':'暂时无法核实开通结果，请刷新查回原授权。';
   return json({error:status===503?'opening_unverifiable':code,message},status);
  }
 };
 return {handle,authorize,assertCurrent};
}
