import {afterAll,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import Database from '../src/sqlite-compat.js';

// This fixture is copied next to the original, unmodified sqlite-compat source.
// It never imports the original config, application entry point, or real DB.
const expected=process.env.QIWE_SQLITE_DRIVER;
if(!expected||!path.isAbsolute(expected))throw Error('Real-driver fixture requires an explicit prepared package');
const require=createRequire(new URL('../src/sqlite-compat.ts',import.meta.url));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-sqlite-behavior-'));
const databases=new Set<any>();
const open=(file:string)=>{const db=new Database(path.join(directory,file));databases.add(db);return db;};
const close=(db:any)=>{db.close();databases.delete(db);};
afterAll(()=>{
  for(const db of databases)db.close();
  const resolved=fs.realpathSync(directory);
  if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-sqlite-behavior-'))throw Error('Unsafe fixture cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
});

it('loads unchanged original sqlite-compat and the explicit real better-sqlite3 12.11.1 package',()=>{
  expect(createHash('sha256').update(fs.readFileSync(new URL('../src/sqlite-compat.ts',import.meta.url))).digest('hex')).toBe('232d32a191c46d5c1bfe35f44e0f840f7659bc41d8b51e11ac3827bccf3d7fab');
  expect(Database).toBe(require('better-sqlite3'));
  expect(JSON.parse(fs.readFileSync(path.join(expected,'package.json'),'utf8')).version).toBe('12.11.1');
  expect(fs.realpathSync(require.resolve('better-sqlite3'))).toBe(fs.realpathSync(path.join(expected,'lib/index.js')));
  const db=open('identity.sqlite');
  expect(db.prepare('SELECT 1 AS value').get()).toEqual({value:1});
  expect(Object.keys(require.cache).map(file=>fs.realpathSync(file))).toContain(fs.realpathSync(path.join(expected,'build/Release/better_sqlite3.node')));
  close(db);
});

it('commits a transaction and rejects a duplicate unique key without adding a row',()=>{
  const db=open('unique.sqlite');db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, request_key TEXT UNIQUE NOT NULL)');
  const insert=db.prepare('INSERT INTO rows (id,request_key) VALUES (?,?)');
  db.transaction(()=>{insert.run(1,'first');insert.run(2,'second');})();
  expect(()=>insert.run(3,'first')).toThrow(/UNIQUE constraint failed/);
  expect(db.prepare('SELECT id,request_key FROM rows ORDER BY id').all()).toEqual([{id:1,request_key:'first'},{id:2,request_key:'second'}]);
  expect(db.inTransaction).toBe(false);close(db);
});

it('rolls back the whole failed transaction and isolates a caught nested transaction failure',()=>{
  const db=open('rollback.sqlite');db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL)');
  const insert=db.prepare('INSERT INTO rows (id,value) VALUES (?,?)');insert.run(1,'baseline');
  expect(()=>db.transaction(()=>{insert.run(2,'temporary');insert.run(3,'baseline');})()).toThrow(/UNIQUE constraint failed/);
  expect(db.prepare('SELECT id FROM rows').all()).toEqual([{id:1}]);
  db.transaction(()=>{
    insert.run(4,'outer');
    expect(()=>db.transaction(()=>{insert.run(5,'inner');throw Error('synthetic inner failure');})()).toThrow('synthetic inner failure');
    insert.run(6,'outer-after');
  })();
  expect(db.prepare('SELECT id FROM rows ORDER BY id').all()).toEqual([{id:1},{id:4},{id:6}]);
  expect(db.inTransaction).toBe(false);close(db);
});

it('reopens the file with committed rows intact and rolled-back rows absent',()=>{
  let db=open('reopen.sqlite');db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const insert=db.prepare('INSERT INTO rows (id,value) VALUES (?,?)');
  db.transaction(()=>insert.run(1,'durable'))();
  expect(()=>db.transaction(()=>{insert.run(2,'discard');throw Error('synthetic rollback');})()).toThrow('synthetic rollback');
  close(db);db=open('reopen.sqlite');
  expect(db.prepare('SELECT * FROM rows ORDER BY id').all()).toEqual([{id:1,value:'durable'}]);
  close(db);
});
