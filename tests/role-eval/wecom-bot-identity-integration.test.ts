import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWorkbenchOpening} from '../../src/role-eval/workbench-opening.js';
import {createNativeBotIdentityReader} from '../../src/role-eval/native-bot-identity.js';
import {createWecomBotBindingReader} from '../../src/role-eval/wecom-bot-bindings.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bot-identity-')),nativeFile=path.join(dir,'native.sqlite'),grantsFile=path.join(dir,'grants.sqlite'),bindingsFile=path.join(dir,'bindings.json');
  const writer=new DatabaseSync(nativeFile);
  writer.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
    CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
    INSERT INTO users VALUES('a','member','active',0),('b','member','active',0);
    INSERT INTO registered_groups VALUES('web:home-a','a',1,'container'),('web:home-b','b',1,'container');`);
  fs.writeFileSync(bindingsFile,JSON.stringify(['a','b'].map(id=>({botId:'bot-synthetic',corpId:'corp-synthetic',memberId:'member-'+id,accountId:id,version:1,active:true}))));
  const native=createNativeBotIdentityReader(nativeFile),store=new WorkbenchAccessStore(grantsFile);
  const scope=()=>({correlationId:'synthetic-request',signal:new AbortController().signal,deadline:performance.now()+1500});
  const web=createWorkbenchOpening({origin:'https://local.invalid',tenantId:'synthetic-tenant',stores:[{id:'b',name:'B'},{id:'c',name:'C'}],templates:[{key:'manager',name:'Manager',skills:[],payload:{name:'Manager'}}],store,journalDirectory:path.join(dir,'journals'),native:{
    authenticate:async cookie=>cookie==='admin'?{id:'admin',role:'admin',status:'active',must_change_password:false}:(await native(cookie,scope())).user,
    groups:async cookie=>({groups:{[(await native(cookie,scope())).workspaceJid]:{is_my_home:true}}}),
    employees:async()=>['a','b'].map(id=>({id,role:'member',status:'active'})),skills:async()=>[],profiles:()=>({list:async()=>[],create:async()=>{throw Error('profile_creation_not_expected');}}),
  }});
  const bots=['a','b'].map(id=>createWecomBotContext({mode:'isolated-synthetic',botId:'bot-synthetic',corpId:'corp-synthetic',tenantId:'synthetic-tenant',stores:[{id:'b'},{id:'c'}],roles:['manager'],store,
    readSubject:async()=>({botId:'bot-synthetic',memberId:'member-'+id}),
    readBinding:createWecomBotBindingReader(async()=>JSON.parse(fs.readFileSync(bindingsFile,'utf8'))),readNative:native,
  }));
  const grant=(accountId:string,storeId:string,version=0,active=true)=>web.handle(new Request('https://local.invalid/api/local-product/access',{method:'POST',headers:{cookie:'admin',origin:'https://local.invalid'},body:JSON.stringify({accountId,storeId,roles:['manager'],active,expectedVersion:version,requestKey:accountId+'-'+version+'-'+active})}));
  return {dir,writer,native,store,bots,scope,web,grant,bindingsFile,grantsFile,close(){for(const b of bots)b.close();native.close();store.close();writer.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

it('an original Web administrator grant opens Bot access to the same Native account, Home and durable grant',async()=>{
  const s=fixture();try{
    await expect(s.bots[0]!.authorize(s.scope(),'manager')).rejects.toThrow('access_denied');
    expect((await s.grant('a','b')).status).toBe(200);
    const [web,bot]=await Promise.all([s.web.authorize('a'),s.bots[0]!.authorize(s.scope(),'manager')]);
    expect(bot.identity).toEqual(web.identity);
    expect(bot.identity).toEqual({accountId:'a',workspaceJid:'web:home-a',tenantId:'synthetic-tenant',storeId:'b',grantVersion:1});
    const reopened=new WorkbenchAccessStore(s.grantsFile);try{expect(reopened.get('a')).toEqual(web.grant);}finally{reopened.close();}
    expect(fs.existsSync(path.join(s.dir,'journals'))).toBe(false);
  }finally{s.close();}
});

it('Web revocation and Native disable both invalidate a previously issued Bot context',async()=>{
  const s=fixture();try{
    await s.grant('a','b');const context=await s.bots[0]!.authorize(s.scope(),'manager');
    expect((await s.grant('a','b',1,false)).status).toBe(200);
    await expect(s.bots[0]!.assertCurrent(context)).rejects.toThrow('access_changed');
    await expect(s.web.authorize('a')).rejects.toThrow('access_not_open');
    await s.grant('a','b',2,true);const next=await s.bots[0]!.authorize(s.scope(),'manager');
    s.writer.prepare('UPDATE users SET status=? WHERE id=?').run('disabled','a');
    await expect(s.bots[0]!.assertCurrent(next)).rejects.toThrow('access_changed');
    await expect(s.web.authorize('a')).rejects.toThrow('access_denied');
  }finally{s.close();}
});

it('concurrent real SQLite identities stay isolated and file-based remapping invalidates old contexts',async()=>{
  const s=fixture();try{
    await s.grant('a','b');await s.grant('b','c');
    const [a,b]=await Promise.all([s.bots[0]!.authorize(s.scope(),'manager'),s.bots[1]!.authorize(s.scope(),'manager')]);
    expect(a.identity.accountId).toBe('a');expect(a.identity.storeId).toBe('b');expect(a.identity.workspaceJid).toBe('web:home-a');
    expect(b.identity.accountId).toBe('b');expect(b.identity.storeId).toBe('c');expect(b.identity.workspaceJid).toBe('web:home-b');
    const rows=JSON.parse(fs.readFileSync(s.bindingsFile,'utf8'));rows[0].accountId='b';rows[0].version=2;fs.writeFileSync(s.bindingsFile,JSON.stringify(rows));
    await expect(s.bots[0]!.assertCurrent(a)).rejects.toThrow('access_changed');
    await s.bots[1]!.assertCurrent(b);
  }finally{s.close();}
});

it('locked Native storage fails closed without creating a fallback user or grant',async()=>{
  const s=fixture();try{
    await s.grant('a','b');s.writer.exec('BEGIN EXCLUSIVE');
    try{await expect(s.bots[0]!.authorize(s.scope(),'manager')).rejects.toThrow('authority_unavailable');}
    finally{s.writer.exec('ROLLBACK');}
    expect(s.store.list()).toHaveLength(1);
    expect(s.writer.prepare('SELECT id FROM users ORDER BY id').all()).toEqual([{id:'a'},{id:'b'}]);
  }finally{s.close();}
});
