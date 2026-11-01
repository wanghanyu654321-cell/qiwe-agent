import {afterAll,expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
const previous=process.cwd();
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-restoration-metadata-')));
const db=await import('../src/db.js');
const {STORE_DIR}=await import('../src/config.js');
const {scanAppointmentBootMetadata}=await import('../src/appointment-boot-inventory.js');
afterAll(()=>{db.closeDatabase();process.chdir(previous);});

it('scans original rowid-keyed sessions with nullable fields and hashes full private rows without exposing them',()=>{
 db.initDatabase();
 const sql=new Database(path.join(STORE_DIR,'messages.db'));
 try {
  const at='2026-10-23T00:00:00.000Z';
  sql.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run('rowid-owner','rowid-owner','synthetic-password-hash',at,at);
  const insert=sql.prepare('INSERT INTO user_sessions(id,user_id,ip_address,user_agent,created_at,expires_at,last_active_at) VALUES(?,?,NULL,NULL,?,?,?)');
  insert.run('synthetic-private-session-a','rowid-owner',at,at,at);
  insert.run('synthetic-private-session-b','rowid-owner',at,at,at);
  const first=scanAppointmentBootMetadata(sql);
  expect(first.blockers).not.toContain('INVALID_METADATA:user_sessions');
  const sessions=first.records.filter(row=>row.kind==='resource/user_sessions');
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions.map(row=>row.key)).size).toBe(2);
  expect(sessions.every(row=>row.disposition==='eligible')).toBe(true);
  expect(JSON.stringify(first)).not.toContain('synthetic-private-session');
  sql.prepare('UPDATE user_sessions SET user_agent=? WHERE id=?').run('synthetic-private-agent','synthetic-private-session-a');
  const next=scanAppointmentBootMetadata(sql).records.filter(row=>row.kind==='resource/user_sessions');
  expect(next.map(row=>row.key)).toEqual(sessions.map(row=>row.key));
  expect(next[0]?.version).not.toBe(sessions[0]?.version);
  // SQLite affinity permits a blob here; the original metadata type validator
  // must continue refusing it after the rowid alias repair.
  sql.prepare('UPDATE user_sessions SET expires_at=? WHERE id=?').run(Buffer.from('invalid-type'),'synthetic-private-session-a');
  expect(scanAppointmentBootMetadata(sql).blockers).toContain('INVALID_METADATA:user_sessions');
 } finally {sql.close();}
});
