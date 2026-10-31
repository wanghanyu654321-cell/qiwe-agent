import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

import {restoreExistingFrontagentEmployee as restore} from './frontagent-existing-employee.ts';
const names = ['users','registered_groups','agent_profiles','workspace_agent_profiles','agent_profile_prompt_versions'] as const;
const scope = {tenantId:'synthetic-tenant',storeId:'synthetic-store-b',instanceId:'synthetic-instance'};
const ddl = `CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,must_change_password INTEGER NOT NULL,deleted_at TEXT);
CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,folder TEXT NOT NULL,created_by TEXT REFERENCES users(id),is_home INTEGER,execution_mode TEXT);
CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,identity_prompt TEXT NOT NULL,soul_prompt TEXT NOT NULL,agents_prompt TEXT NOT NULL,tools_prompt TEXT NOT NULL,prompt_mode TEXT NOT NULL,identity_hash TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,is_default INTEGER NOT NULL,model_config_id TEXT);
CREATE TABLE workspace_agent_profiles(group_folder TEXT PRIMARY KEY,agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),interaction_mode TEXT NOT NULL);
CREATE TABLE agent_profile_prompt_versions(id TEXT PRIMARY KEY,agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),version INTEGER NOT NULL,name TEXT NOT NULL,identity_prompt TEXT NOT NULL,soul_prompt TEXT NOT NULL,agents_prompt TEXT NOT NULL,tools_prompt TEXT NOT NULL,prompt_mode TEXT NOT NULL,identity_hash TEXT NOT NULL,UNIQUE(agent_profile_id,version));`;
function fixture(t: TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-existing-employee-'));
  const file=path.join(root,'target.db'), db=new DatabaseSync(file); db.exec(ddl);
  db.exec("INSERT INTO users VALUES('synthetic-admin','original-admin','synthetic-admin-hash','admin','active',0,NULL)");
  const source=new DatabaseSync(':memory:');source.exec(ddl);
  source.exec("INSERT INTO users VALUES('synthetic-member','original-member','synthetic-member-hash','member','active',0,NULL)");
  const keys=['home','reception','frontdesk','marketing','ads','manager','qa','training'];
  for (const [i,key] of keys.entries()) {
    source.prepare('INSERT INTO registered_groups VALUES(?,?,?,?,?)').run('web:synthetic-'+key,'synthetic-folder-'+key,'synthetic-member',i===0?1:0,'container');
    source.prepare('INSERT INTO agent_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-profile-'+key,'synthetic-member',key,'synthetic-secret-prompt','','','','append','synthetic-identity-'+key,3,'active',i===0?1:0,null);
    source.prepare('INSERT INTO workspace_agent_profiles VALUES(?,?,?)').run('synthetic-folder-'+key,'synthetic-profile-'+key,'assistant');
    source.prepare('INSERT INTO agent_profile_prompt_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-version-'+key,'synthetic-profile-'+key,3,key,'synthetic-secret-prompt','','','','append','synthetic-identity-'+key);
  }
  const tables=Object.fromEntries(names.map(name=>[name,source.prepare('SELECT * FROM '+name).all()])) as Record<string,any[]>;
  const payload:any={format:'frontagent-existing-employee-v1',runId:'synthetic-run',accountId:'synthetic-member',homeJid:'web:synthetic-home',source:{unchangedAfterRead:true},schema:Object.fromEntries(names.map(name=>[name,source.prepare('PRAGMA table_info('+name+')').all()])),tables,
    roles:keys.slice(1).map(key=>({key,id:'synthetic-profile-'+key,workspaceJid:'web:synthetic-'+key,skills:['synthetic-skill']})),
    authority:{bindings:[{id:'synthetic-binding',tenant_id:scope.tenantId,store_id:scope.storeId,instance_id:scope.instanceId,platform_user_id:'synthetic-member',workspace_jid:'web:synthetic-home',role:'staff',subject_id:'synthetic-subject',conversation_id:'synthetic-conversation',active:true,can_submit:false,can_decide:true,can_notify:false,can_takeover:false,can_verify:false,version:2}],oldAppMembers:[{app_id:'synthetic-old-app'}]},newBotBinding:'not_exported_old_app_only',excluded:['other_users','sessions','messages','appointments','financial_history','model_keys','bot_secrets','customer_data']};
  source.close();
  t.after(()=>{db.close();const real=fs.realpathSync(root);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(real).startsWith('frontagent-existing-employee-'));fs.rmSync(real,{recursive:true});});
  const invoke=(hash?:string)=>{const exportBytes=Buffer.from(JSON.stringify(payload));return restore({databasePath:file,actorId:'synthetic-admin',exportBytes,expectedSha256:hash??createHash('sha256').update(exportBytes).digest('hex'),expectedScope:scope});};
  const state=()=>names.map(name=>db.prepare('SELECT * FROM '+name+' ORDER BY 1').all());
  return {file,db,payload,invoke,state};
}

test('restores only original rows with unchanged IDs, passwords, profile versions and administrator; repeats as no-op',t=>{
  const f=fixture(t),admin=f.db.prepare('SELECT * FROM users').get();let result:any;
  assert.doesNotThrow(()=>{result=f.invoke();});
  assert.deepEqual(result.imported,{users:1,registered_groups:8,agent_profiles:8,workspace_agent_profiles:8,agent_profile_prompt_versions:8});
  assert.deepEqual(result.reused,{users:0,registered_groups:0,agent_profiles:0,workspace_agent_profiles:0,agent_profile_prompt_versions:0});
  assert.deepEqual(f.db.prepare("SELECT * FROM users WHERE id='synthetic-admin'").get(),admin);
  for(const name of names){const actual=f.db.prepare('SELECT * FROM '+name+(name==='users'?" WHERE role='member'":'')+' ORDER BY 1').all();assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(f.payload.tables[name].sort((a:any,b:any)=>String(Object.values(a)[0]).localeCompare(String(Object.values(b)[0]))))));}
  const before=f.state(),second:any=f.invoke();assert.deepEqual(f.state(),before);assert.deepEqual(second.reused,result.imported);assert.ok(Object.values(second.imported).every(n=>n===0));
  for(const secret of ['synthetic-secret-prompt','synthetic-member-hash','synthetic-admin-hash'])assert.ok(!JSON.stringify(result).includes(secret));
});

const invalids:Record<string,(f:ReturnType<typeof fixture>)=>void>={
  owner:f=>{f.payload.tables.agent_profiles[0].owner_user_id='other';},
  home:f=>{f.payload.tables.registered_groups[1].is_home=1;},
  'wrong home JID':f=>{f.payload.homeJid='web:other';},
  'cross store ACL':f=>{f.payload.authority.bindings[0].store_id='synthetic-store-a';},
  'disabled ACL':f=>{f.payload.authority.bindings[0].active=false;},
  'multiple ACL rows':f=>{f.payload.authority.bindings.push({...f.payload.authority.bindings[0]});},
  archived:f=>{f.payload.tables.agent_profiles[0].status='archived';},
  'disabled employee':f=>{f.payload.tables.users[0].status='disabled';},
  'password reset employee':f=>{f.payload.tables.users[0].must_change_password=1;},
  'deleted employee':f=>{f.payload.tables.users[0].deleted_at='synthetic-deleted';},
  link:f=>{f.payload.tables.workspace_agent_profiles[1].agent_profile_id='synthetic-profile-home';},
  'missing version':f=>{f.payload.tables.agent_profile_prompt_versions.pop();},
  'version prompt differs':f=>{f.payload.tables.agent_profile_prompt_versions[0].identity_prompt='changed';},
  'duplicate version':f=>{f.payload.tables.agent_profile_prompt_versions.push({...f.payload.tables.agent_profile_prompt_versions[0],id:'another-version'});},
  'unknown schema column':f=>{f.payload.schema.users.push({cid:7,name:'unapproved',type:'TEXT',notnull:0,dflt_value:null,pk:0});f.payload.tables.users[0].unapproved='value';},
  'source schema absent from target':f=>{f.payload.schema.users.push({cid:7,name:'avatar_url',type:'TEXT',notnull:0,dflt_value:null,pk:0});f.payload.tables.users[0].avatar_url=null;},
  'wrong primary key':f=>{f.payload.schema.users[0].pk=0;},
  'row missing schema field':f=>{delete f.payload.tables.users[0].password_hash;},
  'extra table':f=>{f.payload.tables.sessions=[];},
  'unknown source stability':f=>{f.payload.source.unchangedAfterRead=false;},
  'replaced role ID':f=>{f.payload.roles[0].id='synthetic-profile-home';},
  'duplicate folder':f=>{f.payload.tables.registered_groups[1].folder='synthetic-folder-home';},
  'username collision':f=>{f.db.exec("INSERT INTO users VALUES('different-id','original-member','keep','member','active',0,NULL)");},
  'folder collision':f=>{f.db.exec("INSERT INTO registered_groups VALUES('web:other','synthetic-folder-home','synthetic-admin',0,'container')");},
  'same PK different contents':f=>{f.db.exec("INSERT INTO users VALUES('synthetic-member','original-member','changed','member','active',0,NULL)");},
  'inactive actor':f=>{f.db.exec("UPDATE users SET status='disabled' WHERE id='synthetic-admin'");},
  'non-admin actor':f=>{f.db.exec("UPDATE users SET role='member' WHERE id='synthetic-admin'");},
  'actor requires password reset':f=>{f.db.exec("UPDATE users SET must_change_password=1 WHERE id='synthetic-admin'");},
  'target mandatory new column':f=>{f.db.exec('ALTER TABLE agent_profiles ADD COLUMN required_new TEXT NOT NULL');},
  'SQLite type coercion would change an original field':f=>{f.payload.tables.agent_profiles[0].version='3';f.payload.tables.agent_profile_prompt_versions[0].version='3';},
};
for(const [name,mutate] of Object.entries(invalids))test(`atomically refuses ${name}`,t=>{const f=fixture(t);mutate(f);const before=f.state();assert.throws(()=>f.invoke());assert.deepEqual(f.state(),before);});

test('rejects wrong externally supplied digest before opening target',t=>{const f=fixture(t),before=f.state();assert.throws(()=>f.invoke('0'.repeat(64)),/hash|digest/i);assert.deepEqual(f.state(),before);});
test('rolls back earlier user and profile inserts when final version insert violates target constraint',t=>{const f=fixture(t);f.db.exec('DROP TABLE agent_profile_prompt_versions; CREATE TABLE agent_profile_prompt_versions(id TEXT PRIMARY KEY,agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),version INTEGER NOT NULL CHECK(version<3),name TEXT NOT NULL,identity_prompt TEXT NOT NULL,soul_prompt TEXT NOT NULL,agents_prompt TEXT NOT NULL,tools_prompt TEXT NOT NULL,prompt_mode TEXT NOT NULL,identity_hash TEXT NOT NULL,UNIQUE(agent_profile_id,version))');const before=f.state();assert.throws(()=>f.invoke());assert.deepEqual(f.state(),before);});
test('accepts target nullable/default additions without dropping source values',t=>{const f=fixture(t);f.db.exec("ALTER TABLE users ADD COLUMN future_nullable TEXT; ALTER TABLE agent_profiles ADD COLUMN future_default TEXT NOT NULL DEFAULT 'kept'");assert.doesNotThrow(()=>f.invoke());assert.equal(f.db.prepare("SELECT future_default FROM agent_profiles LIMIT 1").get()?.future_default,'kept');});
test('refuses missing file without creating a database',t=>{const f=fixture(t);const missing=path.join(path.dirname(f.file),'missing.db');const bytes=Buffer.from(JSON.stringify(f.payload));assert.throws(()=>restore({databasePath:missing,actorId:'synthetic-admin',exportBytes:bytes,expectedSha256:createHash('sha256').update(bytes).digest('hex'),expectedScope:scope}));assert.equal(fs.existsSync(missing),false);});
test('late existing prompt-version conflict rolls back the entire employee import',t=>{const f=fixture(t);f.db.exec("PRAGMA foreign_keys=OFF;INSERT INTO agent_profile_prompt_versions VALUES('synthetic-version-training','synthetic-profile-training',3,'training','conflicting prompt','','','','append','synthetic-identity-training');PRAGMA foreign_keys=ON");const before=f.state();assert.throws(()=>f.invoke());assert.deepEqual(f.state(),before);});
test('refuses invalid existing database without replacing its bytes',t=>{const f=fixture(t),bad=path.join(path.dirname(f.file),'invalid.db'),data=Buffer.from('synthetic invalid sqlite');fs.writeFileSync(bad,data);const bytes=Buffer.from(JSON.stringify(f.payload));assert.throws(()=>restore({databasePath:bad,actorId:'synthetic-admin',exportBytes:bytes,expectedSha256:createHash('sha256').update(bytes).digest('hex'),expectedScope:scope}));assert.deepEqual(fs.readFileSync(bad),data);});
test('does not touch sessions, messages, unrelated profiles or stored business ACL',t=>{const f=fixture(t);f.db.exec("CREATE TABLE sessions(id TEXT,body TEXT);CREATE TABLE messages(id TEXT,body TEXT);CREATE TABLE appointment_bindings(id TEXT,role TEXT);INSERT INTO sessions VALUES('keep-session','synthetic-private');INSERT INTO messages VALUES('keep-message','synthetic-private');INSERT INTO appointment_bindings VALUES('keep-binding','customer');INSERT INTO agent_profiles VALUES('keep-profile','synthetic-admin','keep','','','','','append','keep-hash',1,'active',1,NULL)");const before=['sessions','messages','appointment_bindings'].map(table=>f.db.prepare('SELECT * FROM '+table).all()),profile=f.db.prepare("SELECT * FROM agent_profiles WHERE id='keep-profile'").get();f.invoke();assert.deepEqual(['sessions','messages','appointment_bindings'].map(table=>f.db.prepare('SELECT * FROM '+table).all()),before);assert.deepEqual(f.db.prepare("SELECT * FROM agent_profiles WHERE id='keep-profile'").get(),profile);});
test('refuses unresolved declared FK and rolls back original-row inserts',t=>{const f=fixture(t);f.db.exec('DROP TABLE agent_profile_prompt_versions; CREATE TABLE external_reference(id TEXT PRIMARY KEY); CREATE TABLE agent_profile_prompt_versions(id TEXT PRIMARY KEY,agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),version INTEGER NOT NULL REFERENCES external_reference(id),name TEXT NOT NULL,identity_prompt TEXT NOT NULL,soul_prompt TEXT NOT NULL,agents_prompt TEXT NOT NULL,tools_prompt TEXT NOT NULL,prompt_mode TEXT NOT NULL,identity_hash TEXT NOT NULL,UNIQUE(agent_profile_id,version))');const before=f.state();assert.throws(()=>f.invoke(),/REFERENCE/);assert.deepEqual(f.state(),before);});
test('refuses extra original-owner prompt version outside the trusted snapshot',t=>{const f=fixture(t);f.invoke();f.db.exec("INSERT INTO agent_profile_prompt_versions VALUES('foreign-history','synthetic-profile-home',2,'untrusted','','','','','append','untrusted')");const before=f.state();assert.throws(()=>f.invoke());assert.deepEqual(f.state(),before);});
test('refuses a scalar that SQLite would coerce rather than preserve exactly',t=>{const f=fixture(t);f.db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');f.payload.schema.users.push({cid:7,name:'avatar_url',type:'TEXT',notnull:0,dflt_value:null,pk:0});f.payload.tables.users[0].avatar_url=123;const before=f.state();assert.throws(()=>f.invoke());assert.deepEqual(f.state(),before);});
