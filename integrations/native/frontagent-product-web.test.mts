import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {installFrontagentProductReadRoutes} from './frontagent-product-web.ts';

// Only public source is bundled; every business record below is synthetic.
const native=path.resolve(process.env.QIWE_NATIVE_ROOT??'../claw-agent-phase-one/.local/full-instance/stage/app');
const product=path.resolve(process.env.QIWE_PRODUCT_ROOT??'../claw-agent-mem0-p0');
const require=createRequire(path.join(native,'package.json'));
const {Hono}=require('hono');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-product-web-'));
const bundle=path.join(root,'product.mjs');
fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
const compiled=new Set<string>();
function compile(relative:string){
 if(compiled.has(relative))return;compiled.add(relative);
 const source=path.join(product,'src/role-eval',relative.replace(/\.js$/,'.ts'));
 const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const target=path.join(root,'product',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,code);
 for(const match of code.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+\.js)['"]/g))compile(path.join(path.dirname(relative),match[1]!));
}
const exports=[['local-product','LocalDraftStore'],['manager-service','createManagerService'],['training-knowledge','createTrainingSummaryService'],['beauty-ops','BEAUTY_CASES']];
for(const [file] of exports)compile(file+'.js');
fs.writeFileSync(bundle,exports.map(([file,name])=>`export {${name}} from './product/${file}.js';`).join('\n'));
const modules=await import(pathToFileURL(bundle).href);
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const keys=['reception','frontdesk','marketing','ads','manager','qa','training'];
function setup(){
 const job=fs.mkdtempSync(path.join(root,'job-')),owner={id:'synthetic-owner',role:'admin',status:'active',must_change_password:false};
 const groups:any={'web:main':{folder:'main',is_home:true,created_by:owner.id}};
 const profiles:any={};for(const key of keys){groups['web:local-'+key]={folder:'local-'+key,is_home:false,created_by:owner.id};profiles['profile-'+key]={id:'profile-'+key,owner_user_id:owner.id,status:'active',name:key,runtime_policy:{skills:{mode:'custom',ids:['skill-'+key]}}};}
 const db={getUserById:(id:string)=>id===owner.id?owner:undefined,getRegisteredGroup:(jid:string)=>groups[jid],getWorkspaceAgentProfileId:(folder:string)=>'profile-'+folder.slice(6),getAgentProfileForUser:(id:string,user:string)=>user===owner.id?profiles[id]:undefined,createUser:()=>{throw Error('must_not_create_user');},createAgentProfile:()=>{throw Error('must_not_create_profile');}};
 const scope={accountId:owner.id,workspaceJid:'web:main'},store=new modules.LocalDraftStore(path.join(job,'drafts'));
 const draft=store.save(scope,{role:'marketing',requestKey:'retained-draft',facts:{...modules.BEAUTY_CASES[0].sources[0].facts},manualText:'Synthetic retained draft'});
 const manager=modules.createManagerService(product,job),report=manager.receive({employeeId:'synthetic-staff-1',messageId:'retained-report',text:'今天销售成交123元'}).report;manager.close();
 const app=new Hono();let authUser:any=owner;
 const auth=async(c:any,next:any)=>{if(!authUser)return c.json({error:'unauthorized'},401);c.set('user',authUser);await next();};
 const binding=installFrontagentProductReadRoutes(app,{origin:'http://127.0.0.1:39130',job,ownerId:owner.id,db,authMiddleware:auth,productModules:modules});
 // Existing gate remains the only downstream mutation handler.
 app.all('/api/local-product/*',(c:any)=>c.json({error:'original_gate_paused'},409));
 const request=(route:string,options:any={})=>app.request('http://127.0.0.1:39130/api/local-product/'+route,{...options,headers:{Host:'127.0.0.1:39130',...options.headers}});
 return {job,owner,groups,profiles,request,binding,draft,report,setUser:(value:any)=>{authUser=value;}};
}
test('reads existing seven roles, persisted drafts and original manager ledger without creating resources',async()=>{
 const s=setup(),ledger=path.join(s.job,'manager/reports.sqlite'),before=fs.readFileSync(ledger);try{
  const config=await s.request('config');assert.equal(config.status,200);const value=await config.json();assert.deepEqual(value.roles.map((r:any)=>r.key),keys);assert.equal(value.roles[2].id,'profile-marketing');
  const drafts=await s.request('drafts');assert.equal(drafts.status,200);assert.deepEqual((await drafts.json()).drafts,[s.draft]);
  const reports=await s.request('manager');assert.equal(reports.status,200);assert.deepEqual((await reports.json()).reports,[s.report]);
 }finally{s.binding.close();assert.deepEqual(fs.readFileSync(ledger),before);}
});
test('rejects foreign host, origin, user, disabled owner and changed workspace ownership before disclosure',async()=>{
 const s=setup();try{
  assert.equal((await s.request('drafts',{headers:{Host:'evil.invalid'}})).status,400);
  assert.equal((await s.request('drafts',{headers:{Origin:'http://evil.invalid'}})).status,403);
  s.setUser(null);assert.equal((await s.request('drafts')).status,401);
  s.setUser({...s.owner,id:'another'});assert.equal((await s.request('drafts')).status,403);
  s.setUser(s.owner);s.owner.status='disabled';assert.equal((await s.request('manager')).status,403);
  s.owner.status='active';s.groups['web:main'].created_by='another';assert.equal((await s.request('drafts')).status,403);
 }finally{s.binding.close();}
});
test('training overview uses the existing scope-bound source and discloses unavailable state on scope mismatch',async()=>{
 const s=setup(),directory=path.join(s.job,'training'),scope={accountId:s.owner.id,workspaceJid:'web:local-training'};
 const sourceText='# Synthetic training\n## Topic\nSynthetic test content',sha256=createHash('sha256').update(sourceText).digest('hex');
 fs.mkdirSync(directory);const approval={kind:'user_provided_summary',scope,sha256,fileName:'synthetic.md'};
 fs.writeFileSync(path.join(directory,'approval.json'),JSON.stringify(approval));fs.writeFileSync(path.join(directory,'summary-'+sha256+'.json'),JSON.stringify({scope,sha256,sourceText}));
 try{
  let response=await s.request('training');assert.equal(response.status,200);let body=await response.json();assert.equal(body.knowledge.documentsAvailable,1);assert.equal(body.knowledge.available,true);assert.equal(body.generation.enabled,false);
  fs.writeFileSync(path.join(directory,'approval.json'),JSON.stringify({...approval,scope:{...scope,accountId:'other'}}));
  response=await s.request('training');body=await response.json();assert.equal(body.knowledge.available,false);assert.equal(body.knowledge.status,'unavailable');
 }finally{s.binding.close();}
});
test('preserves original gate for writes and fails missing role bindings without inventing resources',async()=>{
 const s=setup();try{
  const before=fs.readFileSync(path.join(s.job,'manager/reports.sqlite'));
  assert.equal((await s.request('manager/receive',{method:'POST',headers:{Origin:'http://127.0.0.1:39130'},body:'{}'})).status,409);
  delete s.profiles['profile-marketing'];assert.equal((await s.request('config')).status,503);
  assert.equal((await s.request('knowledge/marketing')).status,503);
  const sql=new DatabaseSync(path.join(s.job,'manager/reports.sqlite'),{readOnly:true});try{assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM employee_reports').get()!.n,1);}finally{sql.close();}
  s.binding.close();assert.deepEqual(fs.readFileSync(path.join(s.job,'manager/reports.sqlite')),before);
 }finally{s.binding.close();}
});
test('missing original business state fails before any empty ledger can be created',()=>{
 const job=fs.mkdtempSync(path.join(root,'missing-'));
 const unexpectedDatabaseRead=()=>{throw Error('UNEXPECTED_DATABASE_READ');};
 const db={getUserById:unexpectedDatabaseRead,getRegisteredGroup:unexpectedDatabaseRead,getWorkspaceAgentProfileId:unexpectedDatabaseRead,getAgentProfileForUser:unexpectedDatabaseRead};
 assert.throws(()=>installFrontagentProductReadRoutes(new Hono(),{origin:'http://127.0.0.1:39130',job,ownerId:'owner',db,authMiddleware:()=>{},productModules:modules}),/state/);
 assert.deepEqual(fs.readdirSync(job),[]);
});
for(const [name,ddl] of [
 ['missing-table','DROP TABLE employee_reports'],
 ['missing-body','DROP TABLE employee_reports; CREATE TABLE employee_reports(id TEXT PRIMARY KEY, scope TEXT NOT NULL, employee TEXT NOT NULL)'],
 ['wrong-body-type','DROP TABLE employee_reports; CREATE TABLE employee_reports(id TEXT PRIMARY KEY, scope TEXT NOT NULL, employee TEXT NOT NULL, body INTEGER NOT NULL)'],
 ['view-instead-of-table',"DROP TABLE employee_reports; CREATE VIEW employee_reports AS SELECT 'x' AS id, 'x' AS scope, 'x' AS employee, '{}' AS body"],
 ['without-rowid','DROP TABLE employee_reports; CREATE TABLE employee_reports(id TEXT PRIMARY KEY, scope TEXT NOT NULL, employee TEXT NOT NULL, body TEXT NOT NULL) WITHOUT ROWID'],
] as const)test('rejects '+name+' before original ManagerStore can initialize or alter the ledger',async()=>{
 const s=setup(),file=path.join(s.job,'manager/reports.sqlite');
 const sql=new DatabaseSync(file);try{sql.exec(ddl);}finally{sql.close();}
 const before=fs.readFileSync(file);let status:number;
 try{status=(await s.request('manager')).status;}finally{s.binding.close();}
 assert.equal(status,503);
 assert.deepEqual(fs.readFileSync(file),before);
 const check=new DatabaseSync(file,{readOnly:true});try{
  if(name==='missing-table')assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='employee_reports'").get()!.n,0);
 }finally{check.close();}
});
test('rejects a corrupt ledger without replacing or repairing it',async()=>{
 const s=setup(),file=path.join(s.job,'manager/reports.sqlite'),before=Buffer.from('synthetic invalid SQLite file');fs.writeFileSync(file,before);
 try{assert.equal((await s.request('manager')).status,503);}finally{s.binding.close();}
 assert.deepEqual(fs.readFileSync(file),before);
});
