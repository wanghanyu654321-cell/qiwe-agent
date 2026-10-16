import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeBotIdentityReader} from '../../src/role-eval/native-bot-identity.js';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-bot-')),file=path.join(dir,'native.sqlite');
  const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER,password_hash TEXT);
    CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
    INSERT INTO users VALUES('employee-a','member','active',0,'synthetic-secret-never-return'),('employee-b','member','active',0,'synthetic-private');
    INSERT INTO registered_groups VALUES('web:home-a','employee-a',1,'container'),('web:home-b','employee-b',1,'container');`);
  const read=createNativeBotIdentityReader(file);
  const budget=()=>({signal:new AbortController().signal,deadline:performance.now()+1000});
  return {file,db,read,budget,close(){read.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

it('reads existing Native user and unique owned container Home without a cookie or a credential field',async()=>{
  const s=fixture();try{
    const bytes=fs.readFileSync(s.file),before=createHash('sha256').update(bytes).digest('hex');
    expect(await s.read('employee-a',s.budget())).toEqual({user:{id:'employee-a',role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-a'});
    expect(createHash('sha256').update(fs.readFileSync(s.file)).digest('hex')).toBe(before);
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{name:'registered_groups'},{name:'users'}]);
  }finally{s.close();}
});

it('observes account disable and force-change immediately without caching a prior identity',async()=>{
  const s=fixture();try{
    await s.read('employee-a',s.budget());
    s.db.prepare('UPDATE users SET status=?,must_change_password=? WHERE id=?').run('disabled',1,'employee-a');
    expect((await s.read('employee-a',s.budget())).user).toEqual({id:'employee-a',role:'member',status:'disabled',must_change_password:true});
  }finally{s.close();}
});

it('keeps simultaneous accounts isolated and does not borrow another employee Home',async()=>{
  const s=fixture();try{
    const [a,b]=await Promise.all([s.read('employee-a',s.budget()),s.read('employee-b',s.budget())]);
    expect(a.workspaceJid).toBe('web:home-a');expect(b.workspaceJid).toBe('web:home-b');
    s.db.prepare('DELETE FROM registered_groups WHERE created_by=?').run('employee-a');
    await expect(s.read('employee-a',s.budget())).rejects.toThrow('native_identity_unverifiable');
  }finally{s.close();}
});

it('refuses ambiguous, host-executed or invalid Home rather than selecting the first row',async()=>{
  const s=fixture();try{
    s.db.prepare('INSERT INTO registered_groups VALUES(?,?,?,?)').run('web:duplicate-a','employee-a',1,'container');
    await expect(s.read('employee-a',s.budget())).rejects.toThrow('native_identity_unverifiable');
    s.db.prepare('DELETE FROM registered_groups WHERE jid=?').run('web:duplicate-a');
    s.db.prepare('UPDATE registered_groups SET execution_mode=? WHERE created_by=?').run('host','employee-a');
    await expect(s.read('employee-a',s.budget())).rejects.toThrow('native_identity_unverifiable');
    s.db.prepare('UPDATE registered_groups SET execution_mode=?,jid=? WHERE created_by=?').run('container','web:bad home','employee-a');
    await expect(s.read('employee-a',s.budget())).rejects.toThrow('native_identity_unverifiable');
  }finally{s.close();}
});

it('fails closed for a missing account and malformed Native status fields',async()=>{
  const s=fixture();try{
    await expect(s.read('missing',s.budget())).rejects.toThrow('native_identity_unverifiable');
    s.db.prepare('UPDATE users SET must_change_password=2 WHERE id=?').run('employee-a');
    await expect(s.read('employee-a',s.budget())).rejects.toThrow('native_identity_unverifiable');
    s.db.prepare('UPDATE users SET must_change_password=0,status=? WHERE id=?').run('unrecognized','employee-a');
    await expect(s.read('employee-a',s.budget())).rejects.toThrow('native_identity_unverifiable');
  }finally{s.close();}
});

it('rejects aborted, expired and closed reads without exposing Native diagnostics',async()=>{
  const s=fixture();try{
    const controller=new AbortController();controller.abort(Error('synthetic-private-reason'));
    await expect(s.read('employee-a',{signal:controller.signal,deadline:performance.now()+1000})).rejects.toThrow('authority_cancelled');
    await expect(s.read('employee-a',{signal:new AbortController().signal,deadline:performance.now()-1})).rejects.toThrow('authority_timeout');
    s.read.close();
    await expect(s.read('employee-a',s.budget())).rejects.toThrow('native_identity_unverifiable');
  }finally{s.close();}
});
