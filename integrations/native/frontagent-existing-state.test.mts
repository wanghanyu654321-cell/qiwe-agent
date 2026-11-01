import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as existingState from './frontagent-existing-state.ts';
const {prepareExistingFrontagentState,parseExistingFrontagentStateOption}=existingState;

const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
test('isolated recovery turns off only plugin scanning without modifying the original settings',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-settings-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original=path.join(root,'original.json'),host=path.join(root,'host'),target=path.join(host,'data/config/system-settings.json');
 fs.mkdirSync(path.dirname(target),{recursive:true});
 const initial='{"pluginAutoScan":true,"otherSetting":"retained","large":9007199254740993,"nested":{"pluginAutoScan":true}}';
 fs.writeFileSync(original,initial);fs.writeFileSync(target,initial);
 const prepare=(existingState as any).disableExistingPilotPluginScan??(()=>({beforeSha256:hash(initial),afterSha256:hash(initial)}));
 const result=prepare(host);
 assert.equal(fs.readFileSync(target,'utf8'),initial.replace('"pluginAutoScan":true','"pluginAutoScan":false'));
 assert.equal(fs.readFileSync(original,'utf8'),initial);
 assert.notEqual(result.beforeSha256,result.afterSha256);
 const repeat=prepare(host);assert.equal(repeat.changed,false);assert.equal(repeat.beforeSha256,repeat.afterSha256);
 fs.writeFileSync(target,'{"pluginAutoScan":"unexpected"}');
 assert.throws(()=>prepare(host),/FRONTAGENT_EXISTING_SETTINGS_INVALID/);
 assert.equal(fs.readFileSync(target,'utf8'),'{"pluginAutoScan":"unexpected"}');
 fs.writeFileSync(target,'{"pluginAutoScan":true,"pluginAutoScan":false}');
 assert.throws(()=>prepare(host),/FRONTAGENT_EXISTING_SETTINGS_INVALID/);
 assert.throws(()=>prepare(root),/FRONTAGENT_EXISTING_/);
});
test('isolated pilot restricts its copied session key without changing its bytes',{skip:process.platform==='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-key-permissions-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original=path.join(root,'original.key'),host=path.join(root,'host'),target=path.join(host,'data/config/session-secret.key');
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(original,'synthetic-session-key');fs.writeFileSync(target,'synthetic-session-key');fs.chmodSync(target,0o777);
 const restrict=(existingState as any).restrictExistingPilotSessionKey??(()=>({}));const result=restrict(host);
 assert.equal(fs.readFileSync(target,'utf8'),'synthetic-session-key');assert.equal(fs.readFileSync(original,'utf8'),'synthetic-session-key');
 assert.equal(fs.statSync(target).mode&0o777,0o600);
 assert.equal(result.afterMode,'600');assert.throws(()=>restrict(root),/FRONTAGENT_EXISTING_/);
});
test('isolated pilot restricts its copied system settings without changing their bytes',{skip:process.platform==='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-settings-permissions-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original=path.join(root,'original.json'),host=path.join(root,'host'),target=path.join(host,'data/config/system-settings.json');
 fs.mkdirSync(path.dirname(target),{recursive:true});const bytes='{"pluginAutoScan":false,"other":"retained"}';fs.writeFileSync(original,bytes);fs.writeFileSync(target,bytes);fs.chmodSync(target,0o777);
 const restrict=(existingState as any).restrictExistingPilotSettings??(()=>({}));const result=restrict(host);
 assert.equal(fs.statSync(target).mode&0o777,0o600);assert.equal(fs.readFileSync(target,'utf8'),bytes);assert.equal(fs.readFileSync(original,'utf8'),bytes);assert.equal(result.afterMode,'600');
});
function files(root:string):Array<{path:string;sha256:string}>{
 const result:Array<{path:string;sha256:string}>=[];
 function visit(relative:string){for(const e of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  const name=relative+'/'+e.name;
  if(e.isDirectory())visit(name);else if(e.isFile())result.push({path:name,sha256:hash(fs.readFileSync(path.join(root,name)))});
 }}
 visit('state');visit('code');return result.sort((a,b)=>a.path.localeCompare(b.path));
}
function fixture(t:TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-existing-test-')),inputRoot=path.join(root,'input'),hostRoot=path.join(root,'host');
 fs.mkdirSync(hostRoot);fs.mkdirSync(path.join(inputRoot,'state/runtime/data/db'),{recursive:true});
 const database=path.join(inputRoot,'state/runtime/data/db/messages.db');
 const db=new DatabaseSync(database);
 db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
 CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,owner_user_id TEXT,status TEXT);
 CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,folder TEXT,created_by TEXT,is_home INTEGER,execution_mode TEXT);
 CREATE TABLE workspace_agent_profiles(group_folder TEXT,agent_profile_id TEXT);
 INSERT INTO users VALUES('existing-admin','admin','active',0),('existing-member','member','active',0);`);
 for(const owner of ['existing-admin','existing-member'])for(let i=0;i<8;i++){
  db.prepare('INSERT INTO agent_profiles VALUES(?,?,?)').run(owner+'-profile-'+i,owner,'active');
  db.prepare('INSERT INTO registered_groups VALUES(?,?,?,?,?)').run('web:'+owner+'-'+i,owner+'-folder-'+i,owner,i===0?1:0,'container');
  db.prepare('INSERT INTO workspace_agent_profiles VALUES(?,?)').run(owner+'-folder-'+i,owner+'-profile-'+i);
 }
 db.close();
 const write=(relative:string,text='synthetic retained bytes')=>{const file=path.join(inputRoot,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
 for(const name of ['drafts','manager','shadow','training','training-runs','training-sessions','training-pi','training-request-ledger-20261015','workbook-runner'])write('state/'+name+'/retained.txt');
 write('state/runtime/groups/existing-member/retained.txt');
 write('state/runtime/data/config/session-secret.key','synthetic-secret-retained-byte-for-byte');
 write('state/runtime/data/frontagent-workbench-access.sqlite');write('state/runtime/data/frontagent-wecom-bindings.json');write('state/runtime/data/frontagent-approved-roles.json');
 write('code/product-web.mjs','export const routes=true;');write('code/product-modules.mjs','export const modules=true;');
 write('code/product-web.d.mts','export declare const routes: boolean;');write('code/product-modules.d.mts','export declare const modules: boolean;');
 write('code/product/role-eval/local-product.js','export const drafts=true;');write('code/web/dist/index.html','<p>Existing product</p>');
 write('code/src/index.ts','throw Error("Original R1 main must not run from input code");');
 const descriptor={format:'frontagent-existing-state-v1',accountId:'existing-member',homeJid:'web:existing-member-0',role:'marketing',profileId:'existing-member-profile-1',workspaceJid:'web:existing-member-1',folder:'existing-member-folder-1',tenantId:'existing-tenant',storeId:'existing-store',instanceId:'existing-instance',employee:{employeeId:'existing-employee',employeeName:'Existing employee'},adminCookie:'miniclaw_session=synthetic-private-session',expectedCounts:{users:2,profiles:16,groups:16},files:files(inputRoot)};
 const seal=()=>fs.writeFileSync(path.join(inputRoot,'descriptor.json'),JSON.stringify(descriptor));seal();
 const changeDb=(sql:string)=>{const d=new DatabaseSync(database);try{d.exec(sql);}finally{d.close();}descriptor.files=files(inputRoot);seal();};
 t.after(()=>{const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('frontagent-existing-test-'));fs.rmSync(resolved,{recursive:true,force:true});});
 return {root,inputRoot,hostRoot,descriptor,write,seal,changeDb,invoke:()=>prepareExistingFrontagentState({inputRoot,hostRoot})};
}

test('restores existing exact bytes and resource relationships without a second runtime database or synthetic seed',t=>{
 const f=fixture(t),before=files(f.inputRoot),result=f.invoke() as {codeRoot:string;jobRoot:string;ownerId:string;audit:unknown};
 assert.equal(result.ownerId,'existing-admin');assert.equal(result.codeRoot,path.join(f.hostRoot,'frontagent-product'));assert.equal(result.jobRoot,f.hostRoot);
 for(const entry of before.filter(e=>e.path.startsWith('state/'))){const relative=entry.path.slice('state/'.length),target=relative.startsWith('runtime/data/')?relative.slice('runtime/'.length):relative;assert.equal(hash(fs.readFileSync(path.join(f.hostRoot,target))),entry.sha256);}
 assert.equal(fs.existsSync(path.join(f.hostRoot,'runtime/data')),false);assert.equal(fs.existsSync(path.join(f.hostRoot,'src')),false);
 assert.equal(fs.readFileSync(path.join(result.codeRoot,'product-web.mjs'),'utf8'),'export const routes=true;');
 assert.equal(fs.readFileSync(path.join(result.codeRoot,'product-web.d.mts'),'utf8'),'export declare const routes: boolean;');
 assert.equal(fs.readFileSync(path.join(result.codeRoot,'product-modules.d.mts'),'utf8'),'export declare const modules: boolean;');
 assert.equal(fs.readFileSync(path.join(f.hostRoot,'web/dist/index.html'),'utf8'),'<p>Existing product</p>');
 assert.deepEqual(files(f.inputRoot),before);
 const db=new DatabaseSync(path.join(f.hostRoot,'data/db/messages.db'),{readOnly:true});
 try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get()?.n,16);}finally{db.close();}
 assert.doesNotMatch(JSON.stringify(result.audit),/existing-member|session|Cookie|secret|retained|runtime|drafts|\.sqlite/);
});

test('missing explicit input refuses startup and leaves destination empty',t=>{
 const f=fixture(t);assert.throws(()=>prepareExistingFrontagentState({inputRoot:path.join(f.root,'absent'),hostRoot:f.hostRoot}),/INPUT|SOURCE|missing/i);assert.deepEqual(fs.readdirSync(f.hostRoot),[]);
});
test('relative input is refused without seeding',t=>{const f=fixture(t);assert.throws(()=>prepareExistingFrontagentState({inputRoot:'relative',hostRoot:f.hostRoot}),/ABSOLUTE|ROOT/i);assert.deepEqual(fs.readdirSync(f.hostRoot),[]);});
for(const kind of ['hash','extra-file','missing-file','duplicate','traversal','absolute','backslash'] as const)test('refuses descriptor '+kind+' before creating host data',t=>{
 const f=fixture(t),first=f.descriptor.files[0]!;
 if(kind==='hash')first.sha256='0'.repeat(64);
 if(kind==='extra-file')f.write('state/drafts/unlisted.txt');
 if(kind==='missing-file')fs.unlinkSync(path.join(f.inputRoot,first.path));
 if(kind==='duplicate')f.descriptor.files.push({...first});
 if(kind==='traversal')first.path='state/../descriptor.json';
 if(kind==='absolute')first.path='/state/absolute';
 if(kind==='backslash')first.path='state\\drafts\\retained.txt';
 f.seal();assert.throws(f.invoke,/HASH|FILE|PATH|INVENTORY/i);assert.equal(fs.existsSync(path.join(f.hostRoot,'data')),false);
});
test('missing existing DB never initializes a new DB or user',t=>{const f=fixture(t);fs.unlinkSync(path.join(f.inputRoot,'state/runtime/data/db/messages.db'));f.descriptor.files=files(f.inputRoot);f.seal();assert.throws(f.invoke,/DATABASE|DB/i);assert.deepEqual(fs.readdirSync(f.hostRoot),[]);});
for(const sql of ["UPDATE users SET status='disabled' WHERE id='existing-member'","UPDATE users SET role='member' WHERE id='existing-admin'","UPDATE users SET role='admin' WHERE id='existing-member'","UPDATE registered_groups SET created_by='existing-admin' WHERE jid='web:existing-member-1'","UPDATE workspace_agent_profiles SET agent_profile_id='existing-admin-profile-1' WHERE group_folder='existing-member-folder-1'","UPDATE registered_groups SET is_home=1 WHERE jid='web:existing-member-1'","DELETE FROM agent_profiles WHERE id='existing-member-profile-7'"])
test('refuses inconsistent existing identity projection: '+sql.split(' ')[1],t=>{const f=fixture(t);f.changeDb(sql);assert.throws(f.invoke,/IDENTITY|COUNT|ADMIN|MAPPING|HOME/i);});
for(const linkType of ['junction','hardlink'] as const)test('refuses '+linkType+' in supplied state',t=>{
 const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'bytes'),'synthetic outside');
 const link=path.join(f.inputRoot,'state/drafts/link');if(linkType==='junction')fs.symlinkSync(outside,link,'junction');else fs.linkSync(path.join(outside,'bytes'),link);
 assert.throws(f.invoke,/LINK|FILE/i);assert.equal(fs.existsSync(path.join(f.hostRoot,'data')),false);
});
test('refuses destination collisions and overlapping roots without overwriting',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.hostRoot,'data'));fs.writeFileSync(path.join(f.hostRoot,'data/keep'),'keep');assert.throws(f.invoke,/TARGET|DESTINATION|EXIST/i);assert.equal(fs.readFileSync(path.join(f.hostRoot,'data/keep'),'utf8'),'keep');
 assert.throws(()=>prepareExistingFrontagentState({inputRoot:f.inputRoot,hostRoot:f.inputRoot}),/OVERLAP|ROOT/i);
});

test('existing-state CLI strips only its explicit input and preserves the full original verifier flags',()=>{
 const original=[path.resolve('native'),'--restoration-real-container','--restoration-scenario','--full-host-conversations','--skill-root',path.resolve('skills')],inputRoot=path.resolve('explicit-input');
 assert.deepEqual(parseExistingFrontagentStateOption([...original,'--frontagent-existing-state',inputRoot],'linux'),{args:original,inputRoot});
 assert.deepEqual(parseExistingFrontagentStateOption(original,'win32'),{args:original});
});
for(const mode of ['missing','relative','duplicate','windows','no-real-container','no-restoration','no-full-main','pi','c4'] as const)test('existing-state CLI refuses '+mode+' instead of selecting synthetic seed',()=>{
 let args=[path.resolve('native'),'--restoration-real-container','--restoration-scenario','--full-host-conversations','--frontagent-existing-state',path.resolve('explicit-input')];
 if(mode==='missing')args.pop();if(mode==='relative')args[args.length-1]='relative';if(mode==='duplicate')args.push('--frontagent-existing-state',path.resolve('other'));
 if(mode==='no-real-container')args=args.filter(a=>a!=='--restoration-real-container');if(mode==='no-restoration')args=args.filter(a=>a!=='--restoration-scenario');if(mode==='no-full-main')args=args.filter(a=>a!=='--full-host-conversations');
 if(mode==='pi')args.push('--restoration-pi-scenario');if(mode==='c4')args.push('--c4-synthetic-case','grounded');
 assert.throws(()=>parseExistingFrontagentStateOption(args,mode==='windows'?'win32':'linux'),/FRONTAGENT_EXISTING_/);
});
for(const name of ['frontagent-workbench-access.sqlite','frontagent-wecom-bindings.json','frontagent-approved-roles.json','config/session-secret.key'])test('requires original access/session file '+name+' without initializing replacements',t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.inputRoot,'state/runtime/data',name));f.descriptor.files=files(f.inputRoot);f.seal();assert.throws(f.invoke,/ACCESS|SESSION|FILE/i);assert.equal(fs.existsSync(path.join(f.hostRoot,'data')),false);
});
for(const name of ['product-web.d.mts','product-modules.d.mts'])test('requires product declaration '+name+' before creating host data',t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.inputRoot,'code',name));f.descriptor.files=files(f.inputRoot);f.seal();assert.throws(f.invoke,/CODE.*FILE/i);assert.equal(fs.existsSync(path.join(f.hostRoot,'data')),false);
});
