import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

type Owner = {id:string;role:string;status:string;must_change_password:boolean};
type Group = {folder:string;created_by?:string;is_home?:boolean};
type Profile = {id:string;owner_user_id:string;name:string;status:string;runtime_policy?:{skills?:{ids?:string[]}}};
type Scope = {accountId:string;workspaceJid:string};
export interface FrontagentProductReadOptions {
 origin:string;job:string;ownerId:string;
 db:{getUserById(id:string):Owner|undefined;getRegisteredGroup(jid:string):Group|undefined;
  getWorkspaceAgentProfileId(folder:string):string|undefined;getAgentProfileForUser(id:string,ownerId:string):Profile|undefined};
 // The original Hono app and middleware are injected from the composed Native
 // module, keeping this adapter independent of a second Hono installation.
 authMiddleware:(context:any,next:()=>Promise<void>)=>unknown;
 productModules:{
  LocalDraftStore:new(directory:string)=>{list(scope:Scope):unknown[]};
  createManagerService(repo:string,job:string):{read(date?:unknown,kind?:unknown):unknown;close():void};
  createTrainingSummaryService?:(directory:string,scope:Scope)=>{overview():unknown};
 };
}
const roles=['reception','frontdesk','marketing','ads','manager','qa','training'] as const;

// ManagerStore's constructor creates employee_reports when absent. Its read
// path uses body/scope/rowid, and the retained core contract also includes the
// original id and employee columns. Verify that contract without opening a
// writable connection, so damaged state cannot become a successful empty read.
function verifyOriginalManagerLedger(file:string){
 const sql=new DatabaseSync(file,{readOnly:true});
 try{
  sql.exec('PRAGMA query_only=ON');
  const table=sql.prepare("SELECT type FROM sqlite_schema WHERE name='employee_reports'").get();
  if(table?.type!=='table')throw Error('frontagent_original_ledger_schema_missing');
  const columns=sql.prepare('PRAGMA table_info(employee_reports)').all();
  for(const name of ['id','scope','employee','body']){
   const column=columns.find(row=>row.name===name);
   if(!column||String(column.type).toUpperCase()!=='TEXT')throw Error('frontagent_original_ledger_schema_invalid');
  }
  // This prepares the real list/summary projection without reading any body.
  sql.prepare('SELECT id,scope,employee,body FROM employee_reports ORDER BY rowid DESC LIMIT 0').all();
  const integrity=sql.prepare('PRAGMA quick_check').all();
  if(integrity.length!==1||integrity[0]?.quick_check!=='ok')throw Error('frontagent_original_ledger_corrupt');
 }finally{sql.close();}
}

/**
 * Extracted from the original local-product build's read routes. Install after
 * the original maintenance gate and before static fallback. No writer, setup,
 * provisioning, shadow probe or generation route is registered here.
 * job must be the isolated complete original job layout, never its runtime/data.
 */
export function installFrontagentProductReadRoutes(app:any,options:FrontagentProductReadOptions) {
 const origin=new URL(options.origin);
 if(origin.origin!==options.origin||origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port)throw Error('frontagent_loopback_origin_required');
 if(!path.isAbsolute(options.job)||!options.ownerId)throw Error('frontagent_original_state_required');
 const job=path.resolve(options.job);
 for(const [relative,kind] of [['','directory'],['drafts','directory'],['manager','directory'],['manager/reports.sqlite','file']] as const){
  const file=path.join(job,relative);let stat:fs.Stats;try{stat=fs.lstatSync(file);}catch{throw Error('frontagent_original_state_missing');}
  if(stat.isSymbolicLink()||(kind==='file'?!stat.isFile():!stat.isDirectory()))throw Error('frontagent_original_state_invalid');
 }
 const {db,ownerId,authMiddleware}=options;
 const {LocalDraftStore,createManagerService,createTrainingSummaryService}=options.productModules;
 const drafts=new LocalDraftStore(path.join(job,'drafts'));
 let manager:ReturnType<typeof createManagerService>|undefined;
 const ownerScope={accountId:ownerId,workspaceJid:'web:main'};
 function authorized(user:Owner|undefined){
  const owner=db.getUserById(ownerId),home=db.getRegisteredGroup('web:main');
  return user?.id===ownerId&&user.role==='admin'&&user.status==='active'&&user.must_change_password===false&&
   owner?.role==='admin'&&owner.status==='active'&&owner.must_change_password===false&&home?.created_by===ownerId&&home.is_home===true;
 }
 function existingRole(key:string){
  const workspaceJid='web:local-'+key,group=db.getRegisteredGroup(workspaceJid);
  if(!group||group.created_by!==ownerId||group.is_home||group.folder!=='local-'+key)throw Error('frontagent_existing_role_unavailable');
  const id=db.getWorkspaceAgentProfileId(group.folder),profile=id?db.getAgentProfileForUser(id,ownerId):undefined;
  if(!profile||profile.id!==id||profile.owner_user_id!==ownerId||profile.status!=='active')throw Error('frontagent_existing_role_unavailable');
  return {key,id:profile.id,name:profile.name,workspaceJid,skills:[...(profile.runtime_policy?.skills?.ids??[])]};
 }
 app.use('/api/local-product/*',async(c:any,next:()=>Promise<void>)=>{
  if(!['GET','HEAD'].includes(c.req.method))return next();
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');
  if(c.req.header('host')!==origin.host)return c.json({error:'invalid_host'},400);
  const requestOrigin=c.req.header('origin');
  if(requestOrigin!==undefined&&requestOrigin!==origin.origin)return c.json({error:'invalid_origin'},403);
  return authMiddleware(c,async()=>{
   if(!authorized(c.get('user'))){c.res=c.json({error:'local_actor_denied'},403);return;}
   await next();
  });
 });
 const read=(route:string,handler:(c:any)=>unknown)=>app.get('/api/local-product/'+route,(c:any)=>{
  try{return c.json(handler(c));}catch{return c.json({error:'frontagent_read_unavailable',message:'原资料或归属暂时无法核实；未创建替代资料。'},503);}
 });
 read('config',()=>({identity:{...ownerScope},roles:roles.map(existingRole),fixtures:[],model:{enabled:false,reason:'当前仅核对原岗位和资料；未开启新生成。'},capabilities:{businessWrites:false,knowledge:'not_connected',samples:'not_connected'},observedAt:new Date().toISOString()}));
 read('drafts',()=>({identity:{...ownerScope},drafts:drafts.list({...ownerScope})}));
 read('manager',c=>{
  if(!manager){verifyOriginalManagerLedger(path.join(job,'manager/reports.sqlite'));manager=createManagerService(job,job);}
  return {identity:{...ownerScope},...manager.read(c.req.query('date'),c.req.query('kind')) as object};
 });
 read('training',()=>{
  const role=existingRole('training');
  if(!createTrainingSummaryService||!fs.existsSync(path.join(job,'training')))throw Error('frontagent_training_not_connected');
  const knowledge=createTrainingSummaryService(path.join(job,'training'),{accountId:ownerId,workspaceJid:role.workspaceJid}).overview();
  return {identity:{...ownerScope},roleId:role.id,knowledge,generation:{enabled:false,implemented:false,reason:'本轮未装配培训生成或历史结果查询'},modelEnabled:false};
 });
 for(const route of ['knowledge/:role','samples/:role'])app.get('/api/local-product/'+route,(c:any)=>c.json({error:'frontagent_resource_not_connected',message:'本轮尚未装配此资料来源。'},503));
 return {close(){manager?.close();manager=undefined;}};
}
